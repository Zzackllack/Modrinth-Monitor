const { randomUUID } = require("node:crypto");
const { fetchWithTimeout, sleep: defaultSleep } = require("../net/http");
const { OTHER_BUCKET, matchesBucket, pickOtherCountry } = require("../net/geo");
const { checkProxy, probeThroughProxy } = require("./proxy-check");
const { proxyServer } = require("./proxy-model");
const { planRoute } = require("./route-planner");

/**
 * Owns route selection, validation and retries for one monitor run.
 *
 * A run either exits through Gluetun (optionally via its HTTP proxy) or through
 * a validated public proxy. Every attempt gets a fresh route, and a failing
 * attempt invalidates the proxy it used before the next attempt starts.
 */
class EgressManager {
  constructor({
    config,
    journal,
    proxyPool = null,
    gluetun = null,
    geoLookup = null,
    sleep = defaultSleep,
    random = Math.random,
    checkProxyImpl = checkProxy,
    probeThroughProxyImpl = probeThroughProxy,
    fetchImpl = fetchWithTimeout,
    now = Date.now,
  }) {
    this.config = config;
    this.journal = journal;
    this.proxyPool = proxyPool;
    this.gluetun = gluetun;
    this.geoLookup = geoLookup;
    this.sleep = sleep;
    this.random = random;
    this.checkProxy = checkProxyImpl;
    this.probeThroughProxy = probeThroughProxyImpl;
    this.fetch = fetchImpl;
    this.now = now;
  }

  plan() {
    return planRoute({
      mode: this.config.mode,
      vpnShare: this.config.vpnShare,
      weights: this.config.countries.weights,
      otherCountries: this.config.countries.otherCountries,
      preferred: this.config.countries.preferred,
      random: this.random,
    });
  }

  newRouteId(attempt, planned) {
    return `${attempt}-${planned.kind}-${planned.bucket}-${randomUUID().slice(0, 8)}`;
  }

  concreteCountry(bucket) {
    if (bucket === OTHER_BUCKET) {
      return pickOtherCountry(
        this.config.countries.otherCountries,
        this.config.countries.preferred,
        this.random
      );
    }
    return bucket;
  }

  describeRoute(route) {
    const country =
      route.kind === "direct"
        ? null
        : route.observedCountry || route.requestedCountry || null;

    return {
      routeId: route.routeId,
      kind: route.kind,
      bucket: route.bucket,
      requestedCountry: route.requestedCountry || null,
      country,
      proxy: route.proxy ? route.proxy.id : null,
      ip: route.ip || null,
      fallbackFrom: route.fallbackFrom || null,
    };
  }

  /** Resolves a usable route for this attempt, validating it before use. */
  async acquire(attempt) {
    const planned = this.plan();
    this.journal.record("egress.route.planned", { attempt, ...planned });

    if (planned.kind === "direct") {
      return {
        ...planned,
        attempt,
        routeId: this.newRouteId(attempt, planned),
      };
    }

    if (planned.kind === "vpn") {
      return this.acquireVpn({ ...planned, attempt });
    }

    return this.acquireProxy({ ...planned, attempt });
  }

  async acquireProxy(planned, meta = {}) {
    if (!this.proxyPool) {
      throw new Error(
        "Proxy egress is selected but no proxy pool is configured."
      );
    }

    const result = await this.proxyPool.acquire({
      bucket: planned.bucket,
      preferred: this.config.countries.preferred,
      maxCandidates: this.config.proxy.maxCandidates,
    });

    if (result) {
      const route = {
        kind: "proxy",
        bucket: planned.bucket,
        requestedCountry: planned.requestedCountry,
        attempt: planned.attempt,
        routeId: this.newRouteId(planned.attempt, planned),
        proxy: result.proxy,
        observedCountry: result.country || null,
        ip: result.ip || null,
        latencyMs: result.latencyMs,
        fallbackFrom: meta.fallbackFrom || null,
      };

      this.journal.record("egress.proxy.ready", {
        ...this.describeRoute(route),
        latencyMs: route.latencyMs,
      });
      return route;
    }

    const fallback = this.config.proxy.fallback;
    this.journal.record("egress.proxy.unavailable", {
      attempt: planned.attempt,
      bucket: planned.bucket,
      fallback,
    });

    if (fallback === "vpn") {
      return this.acquireVpn(
        {
          kind: "vpn",
          bucket: planned.bucket,
          requestedCountry: this.concreteCountry(planned.bucket),
          attempt: planned.attempt,
        },
        { fallbackFrom: "proxy" }
      );
    }

    if (fallback === "direct") {
      const route = {
        kind: "direct",
        bucket: planned.bucket,
        requestedCountry: null,
        attempt: planned.attempt,
        routeId: this.newRouteId(planned.attempt, planned),
        fallbackFrom: "proxy",
      };
      this.journal.record("egress.direct.fallback", this.describeRoute(route));
      return route;
    }

    throw new Error(
      `No working proxy for bucket "${planned.bucket}" and EGRESS_PROXY_FALLBACK=${fallback}.`
    );
  }

  async acquireVpn(planned, meta = {}) {
    if (!this.gluetun) {
      throw new Error(
        "VPN egress requires GLUETUN_CONTROL_URL and a reachable Gluetun control server."
      );
    }

    const country = planned.requestedCountry || this.concreteCountry(planned.bucket);

    const applied = await this.gluetun.setServerSelection({
      countries: [country],
      cities: this.config.vpn.cities,
      regions: this.config.vpn.regions,
      hostnames: this.config.vpn.hostnames,
    });

    // A settings patch restarts the tunnel. Wait until the restart is visible
    // before waiting for `running`, otherwise a still-running old tunnel would
    // be accepted and the browser could start mid-reconnect. Gluetun reports
    // "settings left unchanged" when the selection is identical; in that case
    // there is no restart to wait for.
    const outcome = applied ? applied.outcome || "" : "";
    if (!/unchanged/i.test(outcome)) {
      await this.gluetun.waitForRestart({
        timeoutMs: this.config.vpn.restartTimeoutMs,
        pollMs: this.config.vpn.pollMs,
      });
    }
    await this.gluetun.waitForRunning({
      timeoutMs: this.config.vpn.connectTimeoutMs,
      pollMs: this.config.vpn.pollMs,
    });

    const route = {
      kind: "vpn",
      bucket: planned.bucket,
      requestedCountry: country,
      attempt: planned.attempt,
      routeId: this.newRouteId(planned.attempt, planned),
      selection: applied ? applied.selection : null,
      outcome: applied ? applied.outcome : null,
      fallbackFrom: meta.fallbackFrom || null,
    };

    if (this.config.vpn.verifyCountry) {
      const observation = await this.verifyCountry(route);
      route.ip = observation.ip;
      route.observedCountry = observation.country;
    } else {
      route.ip = await this.exitIp(route).catch(() => null);
      route.observedCountry = route.ip
        ? await this.lookupCountry(route.ip)
        : null;
    }

    this.journal.record("egress.vpn.ready", {
      ...this.describeRoute(route),
      vpnProxy: this.config.vpn.proxy ? this.config.vpn.proxy.id : null,
    });
    return route;
  }

  /** Waits until the exit IP actually belongs to the requested bucket. */
  async verifyCountry(route) {
    const deadline = this.now() + this.config.vpn.connectTimeoutMs;
    let last = { ip: null, country: null };
    let lastError = null;

    while (this.now() < deadline) {
      try {
        const ip = await this.exitIp(route);
        if (ip) {
          const country = await this.lookupCountry(ip);
          last = { ip, country };
          if (
            matchesBucket(route.bucket, country, this.config.countries.preferred)
          ) {
            return last;
          }
        }
      } catch (error) {
        lastError = error.message;
      }

      await this.sleep(this.config.vpn.pollMs);
    }

    throw new Error(
      `VPN exit country did not match bucket "${route.bucket}" within ${Math.round(
        this.config.vpn.connectTimeoutMs / 1000
      )}s (last: ${last.country || "unknown"} / ${last.ip || "no ip"}${
        lastError ? `; last error: ${lastError}` : ""
      }).`
    );
  }

  /**
   * Exit IP as the browser sees it: through Gluetun's HTTP proxy when that is
   * the configured path, otherwise from the control server.
   */
  async exitIp(route) {
    if (route.kind === "vpn" && this.config.vpn.proxy) {
      const check = await this.checkProxy(this.config.vpn.proxy, {
        checkUrl: this.config.proxy.checkUrl,
        timeoutMs: this.config.proxy.checkTimeoutMs,
      });
      if (!check.ok) {
        throw new Error(`Gluetun HTTP proxy probe failed: ${check.error}`);
      }
      return check.ip;
    }

    return this.gluetun.getPublicIp();
  }

  async lookupCountry(ip) {
    if (!this.geoLookup || !ip) return null;
    return (await this.geoLookup.lookup(ip)) || null;
  }

  browserProxyFor(route) {
    if (route.kind === "proxy") return route.proxy;
    if (route.kind === "vpn") return this.config.vpn.proxy || null;
    return null;
  }

  /**
   * Environment handed to the Playwright process. Empty values are important:
   * a stale proxy from a previous attempt must never leak into a direct run.
   */
  envFor(route) {
    const env = {
      MONITOR_PROXY_SERVER: "",
      MONITOR_PROXY_USERNAME: "",
      MONITOR_PROXY_PASSWORD: "",
      EGRESS_KIND: route.kind,
      EGRESS_BUCKET: route.kind === "direct" ? "" : route.bucket,
      EGRESS_COUNTRY:
        route.kind === "direct"
          ? ""
          : route.observedCountry || route.requestedCountry || "",
      EGRESS_ROUTE_ID: route.routeId,
      EGRESS_ATTEMPT: String(route.attempt),
      EGRESS_PROXY_ID: route.proxy ? route.proxy.id : "",
    };

    const proxy = this.browserProxyFor(route);
    if (proxy) {
      env.MONITOR_PROXY_SERVER = proxyServer(proxy);
      if (proxy.username) {
        env.MONITOR_PROXY_USERNAME = proxy.username;
        env.MONITOR_PROXY_PASSWORD = proxy.password || "";
      }
    }

    return env;
  }

  /** Probes the exact path the browser will take, through the chosen route. */
  async probeRoute(route, url) {
    const proxy = this.browserProxyFor(route);

    if (proxy) {
      const startedAt = this.now();
      const response = await this.probeThroughProxy(proxy, url, {
        timeoutMs: this.config.probe.timeoutMs,
      });
      if (response.status >= 400) {
        throw new Error(`Route probe returned HTTP ${response.status}.`);
      }
      return {
        status: response.status,
        bytes: response.bytes,
        latencyMs: this.now() - startedAt,
        via: "proxy",
      };
    }

    const response = await this.fetch(url, {
      timeoutMs: this.config.probe.timeoutMs,
      headers: { "User-Agent": "modrinth-monitor/1.0 (+route-probe)" },
    }).catch((error) => {
      throw new Error(
        `Route probe failed: ${error.cause?.code || error.cause?.message || error.message}`
      );
    });
    if (!response.ok) {
      throw new Error(`Route probe returned HTTP ${response.status}.`);
    }
    await response.body?.cancel?.();

    return { status: response.status, via: "direct" };
  }

  async probeWithRetry(route, url, attempts = 2) {
    let lastError;
    for (let index = 0; index < attempts; index += 1) {
      try {
        return await this.probeRoute(route, url);
      } catch (error) {
        lastError = error;
        this.journal.record("egress.probe.failed", {
          ...this.describeRoute(route),
          attempt: index + 1,
          error: error.message,
        });
        if (index + 1 < attempts) await this.sleep(2_000);
      }
    }
    throw lastError;
  }

  reportRouteFailure(route, error) {
    if (route.kind === "proxy" && route.proxy && this.proxyPool) {
      this.proxyPool.reportFailure(route.proxy.id, error.message);
    }
  }

  async retryDelay(attempt) {
    const delayMs = this.config.retries.delayMs;
    if (!delayMs) return;
    this.journal.record("egress.retry.scheduled", { attempt, delayMs });
    await this.sleep(delayMs);
  }

  /**
   * Runs `execute(env, route)` until an attempt succeeds or the retry budget is
   * spent. Each attempt resolves its own route, so a retry is a different proxy
   * or a different VPN country.
   */
  async runWithRetries({ execute, probeUrl }) {
    const maxAttempts = this.config.retries.max;
    const failures = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let route;

      try {
        route = await this.acquire(attempt);
      } catch (error) {
        failures.push({ attempt, stage: "acquire", error: error.message });
        this.journal.record("egress.attempt.failed", {
          attempt,
          stage: "acquire",
          error: error.message,
        });
        if (attempt === maxAttempts) break;
        await this.retryDelay(attempt);
        continue;
      }

      this.journal.record("egress.attempt.start", {
        attempt,
        ...this.describeRoute(route),
      });

      try {
        if (probeUrl) {
          const probe = await this.probeWithRetry(route, probeUrl);
          this.journal.record("egress.probe.ok", {
            attempt,
            ...this.describeRoute(route),
            ...probe,
          });
        }

        await execute(this.envFor(route), route);

        this.journal.record("egress.attempt.success", {
          attempt,
          ...this.describeRoute(route),
        });
        return { ok: true, route, attempts: attempt };
      } catch (error) {
        failures.push({
          attempt,
          error: error.message,
          ...this.describeRoute(route),
        });
        this.journal.record("egress.attempt.failed", {
          attempt,
          ...this.describeRoute(route),
          error: error.message,
        });
        this.reportRouteFailure(route, error);

        if (attempt === maxAttempts) break;
        await this.retryDelay(attempt);
      }
    }

    this.journal.record("egress.exhausted", { attempts: maxAttempts, failures });

    const last = failures[failures.length - 1];
    const detail = last ? String(last.error).replace(/\.+$/, "") : "no route available";
    const error = new Error(
      `Egress failed after ${maxAttempts} attempt(s): ${detail}.`
    );
    error.attempts = failures;
    throw error;
  }

  setProxyBypass(proxy) {
    this.vpnProxyOverride = proxy;
  }

  async stop() {
    await this.proxyPool?.stop();
  }
}

module.exports = { EgressManager };
