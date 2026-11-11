const { fetchWithTimeout, sleep } = require("../net/http");
const { matchesBucket } = require("../net/geo");

const DEFAULT_CONTROL_URL = "http://localhost:8000";

/**
 * Thin client for the Gluetun control server.
 *
 * `PUT /v1/vpn/settings` applies server selection and restarts the tunnel, so a
 * country switch is: patch settings -> wait for `running` -> confirm the exit
 * country actually changed.
 */
class GluetunClient {
  constructor({
    baseUrl = DEFAULT_CONTROL_URL,
    username = "",
    password = "",
    timeoutMs = 15_000,
    logAction,
    fetchImpl = fetchWithTimeout,
  } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.username = username;
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.logAction = logAction;
    this.fetch = fetchImpl;
  }

  headers() {
    const headers = { Accept: "application/json" };
    if (this.username) {
      const token = Buffer.from(
        `${this.username}:${this.password || ""}`
      ).toString("base64");
      headers.Authorization = `Basic ${token}`;
    }
    return headers;
  }

  async request(path, { method = "GET", body } = {}) {
    const headers = this.headers();
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: this.timeoutMs,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `Gluetun ${method} ${path} failed (${response.status}): ${text.slice(0, 300) || response.statusText}`
      );
    }

    return text;
  }

  async getStatus() {
    const text = await this.request("/v1/vpn/status");
    const data = JSON.parse(text);
    return data.status;
  }

  async getPublicIp() {
    const text = await this.request("/v1/publicip/ip");
    const data = JSON.parse(text);
    return data.public_ip || null;
  }

  async setServerSelection({ countries, cities, regions, hostnames }) {
    const selection = {};
    if (countries && countries.length) selection.countries = countries;
    if (cities && cities.length) selection.cities = cities;
    if (regions && regions.length) selection.regions = regions;
    if (hostnames && hostnames.length) selection.hostnames = hostnames;

    if (!Object.keys(selection).length) return null;

    const body = { provider: { server_selection: selection } };
    this.logAction?.("gluetun.settings.patch", { selection });

    const outcome = (
      await this.request("/v1/vpn/settings", { method: "PUT", body })
    ).trim();

    this.logAction?.("gluetun.settings.applied", {
      selection,
      outcome: outcome.slice(0, 120),
    });

    return { selection, outcome };
  }

  /**
   * Detects the tunnel leaving `running` after a settings patch. Not finding it
   * is not fatal (Gluetun may answer "unchanged"), so the caller still verifies
   * the exit country afterwards.
   */
  async waitForRestart({ timeoutMs = 30_000, pollMs = 1_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastStatus = "unknown";

    while (Date.now() < deadline) {
      try {
        lastStatus = await this.getStatus();
        if (lastStatus !== "running") {
          this.logAction?.("gluetun.restart.detected", { status: lastStatus });
          return true;
        }
      } catch (error) {
        lastStatus = `error: ${error.message}`;
      }
      await sleep(pollMs);
    }

    this.logAction?.("gluetun.restart.not_detected", { lastStatus });
    return false;
  }

  async waitForRunning({ timeoutMs = 120_000, pollMs = 2_000 } = {}) {    const deadline = Date.now() + timeoutMs;
    let lastStatus = "unknown";

    while (Date.now() < deadline) {
      try {
        lastStatus = await this.getStatus();
        if (lastStatus === "running") return lastStatus;
      } catch (error) {
        lastStatus = `error: ${error.message}`;
      }
      await sleep(pollMs);
    }

    throw new Error(
      `Gluetun did not reach "running" within ${Math.round(timeoutMs / 1000)}s (last status: ${lastStatus}).`
    );
  }

  /**
   * Waits until the exit IP resolves to a country that satisfies `bucket`.
   * A stale IP from the previous route is rejected, otherwise a failed
   * reconnection would silently keep the old country.
   */
  async waitForCountry({
    bucket,
    preferred = [],
    lookup,
    previousIp = null,
    timeoutMs = 90_000,
    pollMs = 3_000,
  } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastObservation = { ip: null, country: null };

    while (Date.now() < deadline) {
      const ip = await this.getPublicIp().catch(() => null);
      if (ip && ip !== previousIp) {
        const country = lookup ? await lookup(ip) : undefined;
        lastObservation = { ip, country: country || null };
        if (matchesBucket(bucket, country, preferred)) {
          return lastObservation;
        }
      }
      await sleep(pollMs);
    }

    throw new Error(
      `Gluetun exit country did not match bucket "${bucket}" within ${Math.round(timeoutMs / 1000)}s (last: ${lastObservation.country || "unknown"} / ${lastObservation.ip || "no ip"}).`
    );
  }

  async stop() {
    await this.request("/v1/vpn/status", {
      method: "PUT",
      body: { status: "stopped" },
    });
  }
}

module.exports = { GluetunClient };
