const fs = require("node:fs/promises");
const net = require("node:net");
const path = require("node:path");
const { fetchJson } = require("../net/http");

const DEFAULT_PROVIDER = "https://ipwho.is/";
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 10 * 60 * 1000;

function buildLookupUrl(template, ip) {
  if (template.includes("{ip}")) {
    return template.replace("{ip}", encodeURIComponent(ip));
  }
  return `${template.replace(/\/+$/, "")}/${encodeURIComponent(ip)}`;
}

function extractCountry(data) {
  if (!data || typeof data !== "object") return undefined;
  if (data.success === false || data.status === "fail") return undefined;

  const raw = data.country_code || data.countryCode || data.country;
  const code = String(raw || "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : undefined;
}

/**
 * Cached IP -> country resolution. Free proxies ship stale country metadata, so
 * the observed exit IP is what gets geolocated; results are cached on disk to
 * keep the refresh path cheap.
 */
class GeoLookup {
  constructor({
    providerUrl = DEFAULT_PROVIDER,
    timeoutMs = 5_000,
    cacheFile = null,
    ttlMs = DEFAULT_TTL_MS,
    logAction,
    fetchJsonImpl = fetchJson,
  } = {}) {
    this.providerUrl = providerUrl;
    this.timeoutMs = timeoutMs;
    this.cacheFile = cacheFile;
    this.ttlMs = ttlMs;
    this.logAction = logAction;
    this.fetchJson = fetchJsonImpl;
    this.entries = new Map();
    this.loaded = false;
    this.loading = null;
    this.persistTimer = null;
    this.dirty = false;
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
        for (const [ip, entry] of Object.entries(data.entries || {})) {
          if (net.isIP(ip) && entry && typeof entry.at === "number") {
            this.entries.set(ip, entry);
          }
        }
      } catch (error) {
        if (error.code !== "ENOENT") {
          this.logAction?.("geo.cache.load_failed", {
            file: this.cacheFile,
            error: error.message,
          });
        }
      }
    })();

    return this.loading;
  }

  async lookup(ip) {
    if (!net.isIP(ip)) return undefined;
    await this.load();

    const cached = this.entries.get(ip);
    const now = Date.now();
    if (cached) {
      const ttl = cached.country ? this.ttlMs : NEGATIVE_TTL_MS;
      if (now - cached.at < ttl) return cached.country || undefined;
    }

    try {
      const data = await this.fetchJson(buildLookupUrl(this.providerUrl, ip), {
        timeoutMs: this.timeoutMs,
        headers: { Accept: "application/json" },
      });
      const country = extractCountry(data);
      this.entries.set(ip, { country: country || null, at: now });
      this.dirty = true;
      this.schedulePersist();
      return country;
    } catch (error) {
      this.entries.set(ip, { country: null, at: now });
      this.dirty = true;
      this.schedulePersist();
      this.logAction?.("geo.lookup.failed", {
        ip,
        provider: this.providerUrl,
        error: error.message,
      });
      return undefined;
    }
  }

  schedulePersist() {
    if (!this.cacheFile || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flush().catch((error) => {
        this.logAction?.("geo.cache.write_failed", {
          file: this.cacheFile,
          error: error.message,
        });
      });
    }, 2_000);
    // Do not keep the process alive just for a cache write.
    this.persistTimer.unref?.();
  }

  async flush() {
    if (!this.cacheFile || !this.dirty) return;
    this.dirty = false;

    const entries = Object.fromEntries(this.entries);
    const payload = JSON.stringify({ updatedAt: new Date().toISOString(), entries });
    const directory = path.dirname(this.cacheFile);
    const tempFile = `${this.cacheFile}.tmp`;

    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(tempFile, payload, { mode: 0o600 });
    await fs.rename(tempFile, this.cacheFile);
  }
}

module.exports = { GeoLookup, buildLookupUrl, extractCountry };
