const fs = require("node:fs/promises");
const path = require("node:path");
const { OTHER_BUCKET, matchesBucket } = require("../net/geo");
const { firstSuccess, shuffle } = require("../net/limit");
const { checkProxy: defaultCheckProxy } = require("./proxy-check");
const { fetchSources: defaultFetchSources } = require("./proxy-sources");

const DEFAULTS = {
  maxPoolSize: 5_000,
  maxCandidates: 6,
  cooldownMs: 10 * 60 * 1000,
  refreshMinutes: 30,
};

function entryUsefulness(entry) {
  const healthy = entry.lastOkAt ? 2 : 0;
  const failures = (entry.failures || 0) * 0.5;
  const country = entry.country ? 0.25 : 0;
  return healthy - failures + country;
}

function roundRobinSample(entries, cap) {
  if (entries.length <= cap) return entries;

  const groups = new Map();
  for (const entry of entries) {
    const key = entry.country || "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  for (const group of groups.values()) {
    group.sort((a, b) => entryUsefulness(b) - entryUsefulness(a));
  }

  const lists = [...groups.values()];
  const selected = [];
  let index = 0;

  while (selected.length < cap && lists.some((list) => index < list.length)) {
    for (const list of lists) {
      if (selected.length >= cap) break;
      if (index < list.length) selected.push(list[index]);
    }
    index += 1;
  }

  return selected;
}

/**
 * Pool of public proxies: periodic refresh from the configured feeds, on-demand
 * validation through a real request, cooldown for repeated failures, and a
 * persisted cache so restarts do not start empty.
 */
class ProxyPool {
  constructor({
    sourceDefinitions,
    protocols = ["http", "https", "socks5"],
    cacheFile = null,
    maxPoolSize = DEFAULTS.maxPoolSize,
    maxCandidates = DEFAULTS.maxCandidates,
    cooldownMs = DEFAULTS.cooldownMs,
    checkUrl,
    checkTimeoutMs = 6_000,
    verifyProxyTls = true,
    geoLookup = null,
    logAction,
    fetchSourcesImpl = defaultFetchSources,
    checkProxyImpl = defaultCheckProxy,
    random = Math.random,
    now = Date.now,
  }) {
    this.sourceDefinitions = sourceDefinitions;
    this.protocols = protocols;
    this.cacheFile = cacheFile;
    this.maxPoolSize = maxPoolSize;
    this.maxCandidates = maxCandidates;
    this.cooldownMs = cooldownMs;
    this.checkUrl = checkUrl;
    this.checkTimeoutMs = checkTimeoutMs;
    this.verifyProxyTls = verifyProxyTls;
    this.geoLookup = geoLookup;
    this.logAction = logAction;
    this.fetchSources = fetchSourcesImpl;
    this.checkProxy = checkProxyImpl;
    this.random = random;
    this.now = now;

    this.entries = new Map();
    this.loaded = false;
    this.loading = null;
    this.refreshInFlight = null;
    this.refreshTimer = null;
    this.persistTimer = null;
    this.dirty = false;
    this.refreshedAt = null;
  }

  get size() {
    return this.entries.size;
  }

  async load() {
    if (this.loaded) return;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      this.loaded = true;
      if (!this.cacheFile) return;

      try {
        const text = await fs.readFile(this.cacheFile, "utf8");
        const data = JSON.parse(text);
        for (const entry of data.entries || []) {
          if (!entry || !entry.id) continue;
          if (this.protocols.length && !this.protocols.includes(entry.protocol)) {
            continue;
          }
          this.entries.set(entry.id, entry);
        }
        this.refreshedAt = data.updatedAt ? Date.parse(data.updatedAt) : null;
        this.logAction?.("proxy.cache.loaded", {
          file: this.cacheFile,
          total: this.entries.size,
        });
      } catch (error) {
        if (error.code !== "ENOENT") {
          this.logAction?.("proxy.cache.load_failed", {
            file: this.cacheFile,
            error: error.message,
          });
        }
      }
    })();

    return this.loading;
  }

  async refresh(reason = "scheduled") {
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = this.doRefresh(reason).finally(() => {
      this.refreshInFlight = null;
    });

    return this.refreshInFlight;
  }

  async doRefresh(reason) {
    const startedAt = this.now();
    const { proxies, results, errors } = await this.fetchSources(
      this.sourceDefinitions,
      {
        protocols: this.protocols,
        logAction: this.logAction,
      }
    );

    if (!proxies.length) {
      this.logAction?.("proxy.refresh.empty", {
        reason,
        sources: results.map((result) => result.source),
        errors: errors.map((error) => error.error),
      });
      return { total: this.entries.size, added: 0, refreshedAt: this.refreshedAt };
    }

    const now = this.now();
    let added = 0;
    const next = new Map();

    for (const proxy of proxies) {
      const existing = this.entries.get(proxy.id);
      if (!existing) added += 1;

      next.set(proxy.id, {
        id: proxy.id,
        protocol: proxy.protocol,
        host: proxy.host,
        port: proxy.port,
        username: proxy.username,
        password: proxy.password,
        country: proxy.country || existing?.country || null,
        source: proxy.source,
        failures: existing?.failures || 0,
        lastOkAt: existing?.lastOkAt || null,
        lastFailAt: existing?.lastFailAt || null,
        lastIp: existing?.lastIp || null,
        latencyMs: existing?.latencyMs ?? null,
        firstSeenAt: existing?.firstSeenAt || now,
      });
    }

    const selected = roundRobinSample([...next.values()], this.maxPoolSize);
    this.entries = new Map(selected.map((entry) => [entry.id, entry]));
    this.refreshedAt = now;
    this.dirty = true;
    this.schedulePersist();

    const byProtocol = {};
    const countries = new Set();
    for (const entry of this.entries.values()) {
      byProtocol[entry.protocol] = (byProtocol[entry.protocol] || 0) + 1;
      if (entry.country) countries.add(entry.country);
    }

    this.logAction?.("proxy.refresh.completed", {
      reason,
      fetched: proxies.length,
      kept: this.entries.size,
      added,
      dropped: next.size - selected.length,
      countries: countries.size,
      byProtocol,
      durationMs: now - startedAt,
      errors: errors.map((error) => error.error),
    });

    return {
      total: this.entries.size,
      added,
      countries: countries.size,
      byProtocol,
      refreshedAt: this.refreshedAt,
    };
  }

  startAutoRefresh(intervalMs = DEFAULTS.refreshMinutes * 60 * 1000) {
    if (this.refreshTimer || intervalMs <= 0) return () => {};

    this.refreshTimer = setInterval(() => {
      this.refresh("timer").catch((error) => {
        this.logAction?.("proxy.refresh.failed", { error: error.message });
      });
    }, intervalMs);
    this.refreshTimer.unref?.();

    return () => this.stopAutoRefresh();
  }

  stopAutoRefresh() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  isAvailable(entry, now = this.now()) {
    if (!entry.lastFailAt) return true;
    const failures = Math.max(1, entry.failures || 1);
    const backoff = Math.min(
      this.cooldownMs * 2 ** Math.max(0, failures - 1),
      60 * 60 * 1000
    );
    return now - entry.lastFailAt >= backoff;
  }

  candidatesFor(bucket, preferred, now = this.now()) {
    const known = [];
    const unknown = [];

    for (const entry of this.entries.values()) {
      if (!this.isAvailable(entry, now)) continue;
      // Chromium cannot send SOCKS credentials through --proxy-server.
      if (entry.username && entry.protocol.startsWith("socks")) continue;
      if (!entry.country) {
        unknown.push(entry);
        continue;
      }
      if (matchesBucket(bucket, entry.country, preferred)) {
        known.push(entry);
      }
    }

    const rank = (a, b) =>
      (a.failures || 0) - (b.failures || 0) ||
      (b.lastOkAt || 0) - (a.lastOkAt || 0) ||
      (a.latencyMs ?? 9_999) - (b.latencyMs ?? 9_999);

    known.sort(rank);
    unknown.sort(rank);

    return { known, unknown };
  }

  /**
   * Tries candidates in small parallel batches and returns the first proxy that
   * completes a real request with a matching exit country. Candidate checking
   * stops as soon as one works, so a healthy pool costs a single check.
   */
  async acquire({ bucket, preferred = [], maxCandidates = this.maxCandidates }) {
    const { known, unknown } = this.candidatesFor(bucket, preferred);
    const batchSize = Math.max(1, maxCandidates);

    const knownTake = shuffle(known.slice(0, batchSize * 3), this.random).slice(
      0,
      batchSize * 2
    );
    const unknownTake = shuffle(
      unknown.slice(0, batchSize * 2),
      this.random
    ).slice(0, batchSize);

    const ordered = [...knownTake, ...unknownTake];
    if (!ordered.length) {
      this.logAction?.("proxy.pool.empty", {
        bucket,
        total: this.entries.size,
      });
      return null;
    }

    for (let offset = 0; offset < ordered.length; offset += batchSize) {
      const batch = ordered.slice(offset, offset + batchSize);
      let settled = false;

      try {
        return await firstSuccess(batch, async (entry) => {
          const result = await this.verifyCandidate(entry, {
            bucket,
            preferred,
            isSuperseded: () => settled,
          });
          settled = true;
          return result;
        });
      } catch {
        // Whole batch failed; try the next one.
      }
    }

    this.logAction?.("proxy.pool.exhausted", {
      bucket,
      tried: ordered.length,
      available: known.length + unknown.length,
    });
    return null;
  }

  async verifyCandidate(entry, { bucket, preferred, isSuperseded = () => false }) {
    const check = await this.checkProxy(entry, {
      checkUrl: this.checkUrl,
      timeoutMs: this.checkTimeoutMs,
      verifyProxyTls: this.verifyProxyTls,
    });

    if (!check.ok) {
      this.reportFailure(entry.id, check.error, {
        quiet: isSuperseded(),
      });
      throw new Error(`${entry.id}: ${check.error}`);
    }

    let observedCountry = entry.country || null;
    if (this.geoLookup && check.ip) {
      const resolved = await this.geoLookup.lookup(check.ip);
      if (resolved) observedCountry = resolved;
    }

    if (bucket === OTHER_BUCKET) {
      if (observedCountry && preferred.includes(observedCountry)) {
        this.logCandidateMismatch(entry, bucket, observedCountry, isSuperseded);
        throw new Error(
          `${entry.id} exits in preferred country ${observedCountry}, not "other".`
        );
      }
    } else if (observedCountry !== bucket) {
      this.logCandidateMismatch(entry, bucket, observedCountry, isSuperseded);
      throw new Error(
        `${entry.id} exits in ${observedCountry || "an unknown country"} instead of ${bucket}.`
      );
    }

    this.reportSuccess(entry.id, {
      latencyMs: check.latencyMs,
      ip: check.ip,
      country: observedCountry,
    });

    return {
      proxy: {
        id: entry.id,
        protocol: entry.protocol,
        host: entry.host,
        port: entry.port,
        username: entry.username,
        password: entry.password,
      },
      country: observedCountry,
      ip: check.ip,
      latencyMs: check.latencyMs,
    };
  }

  logCandidateMismatch(entry, bucket, observedCountry, isSuperseded) {
    // Late checks from a batch that already produced a winner are noise.
    if (isSuperseded()) return;
    this.logAction?.("proxy.candidate.mismatch", {
      proxy: entry.id,
      bucket,
      observedCountry: observedCountry || null,
    });
  }

  reportSuccess(id, { latencyMs, ip, country } = {}) {
    const entry = this.entries.get(id);
    if (!entry) return;

    entry.failures = 0;
    entry.lastOkAt = this.now();
    entry.lastFailAt = null;
    entry.lastError = null;
    if (latencyMs !== undefined) entry.latencyMs = latencyMs;
    if (ip) entry.lastIp = ip;
    if (country) entry.country = country;

    this.dirty = true;
    this.schedulePersist();
  }

  reportFailure(id, error, { quiet = false } = {}) {
    const entry = this.entries.get(id);
    if (!entry) return;

    entry.failures = (entry.failures || 0) + 1;
    entry.lastFailAt = this.now();
    entry.lastError = String(error || "unknown error").slice(0, 200);

    if (!quiet) {
      this.logAction?.("proxy.candidate.failed", {
        proxy: id,
        failures: entry.failures,
        error: entry.lastError,
      });
    }

    this.dirty = true;
    this.schedulePersist();
  }

  stats() {
    const now = this.now();
    const byProtocol = {};
    const byCountry = {};
    let healthy = 0;
    let coolingDown = 0;

    for (const entry of this.entries.values()) {
      byProtocol[entry.protocol] = (byProtocol[entry.protocol] || 0) + 1;
      const country = entry.country || "unknown";
      byCountry[country] = (byCountry[country] || 0) + 1;
      if (entry.lastOkAt && now - entry.lastOkAt < 60 * 60 * 1000) healthy += 1;
      if (entry.lastFailAt && !this.isAvailable(entry, now)) coolingDown += 1;
    }

    const topCountries = Object.fromEntries(
      Object.entries(byCountry)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
    );

    return {
      total: this.entries.size,
      healthy,
      coolingDown,
      byProtocol,
      topCountries,
      refreshedAt: this.refreshedAt
        ? new Date(this.refreshedAt).toISOString()
        : null,
    };
  }

  schedulePersist() {
    if (!this.cacheFile || this.persistTimer) return;

    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flush().catch((error) => {
        this.logAction?.("proxy.cache.write_failed", {
          file: this.cacheFile,
          error: error.message,
        });
      });
    }, 2_000);
    this.persistTimer.unref?.();
  }

  async flush() {
    if (!this.cacheFile || !this.dirty) return;
    this.dirty = false;

    const payload = JSON.stringify({
      updatedAt: this.refreshedAt
        ? new Date(this.refreshedAt).toISOString()
        : new Date().toISOString(),
      entries: [...this.entries.values()].map((entry) => ({
        ...entry,
        lastError: entry.lastError || null,
      })),
    });

    const directory = path.dirname(this.cacheFile);
    const tempFile = `${this.cacheFile}.tmp`;

    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(tempFile, payload, { mode: 0o600 });
    await fs.rename(tempFile, this.cacheFile);
  }

  async stop() {
    this.stopAutoRefresh();
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.flush().catch(() => {});
  }
}

module.exports = { ProxyPool };
