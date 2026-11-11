const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ProxyPool } = require("../src/egress/proxy-pool");
const { parseProxyUrl } = require("../src/egress/proxy-model");

function proxy(address, country) {
  return { ...parseProxyUrl(address), country };
}

function createPool({
  proxies = [],
  checkProxy,
  geoLookup = null,
  cacheFile = null,
  maxCandidates = 1,
  cooldownMs = 1_000,
  now = () => 1_000,
  logAction = () => {},
} = {}) {
  const pool = new ProxyPool({
    sourceDefinitions: [],
    protocols: ["http", "https", "socks5"],
    cacheFile,
    maxCandidates,
    cooldownMs,
    logAction,
    geoLookup,
    now,
    random: () => 0.999999,
    fetchSourcesImpl: async () => ({ proxies, results: [], errors: [] }),
    checkProxyImpl: checkProxy || (async () => ({ ok: false, error: "unused" })),
  });

  return pool;
}

const geoFrom = (map) => ({
  lookup: async (ip) => map[ip],
});

test("refreshes feeds and reports pool statistics", async () => {
  const pool = createPool({
    proxies: [
      proxy("1.1.1.1:8080", "US"),
      proxy("2.2.2.2:8080", "DE"),
      proxy("3.3.3.3:8080", "FR"),
      proxy("4.4.4.4:8080", undefined),
    ],
  });

  const result = await pool.refresh("test");
  assert.equal(result.total, 4);
  assert.equal(pool.size, 4);

  const stats = pool.stats();
  assert.equal(stats.total, 4);
  assert.deepEqual(stats.byProtocol, { http: 4 });
  assert.equal(stats.topCountries.US, 1);
});

test("acquires a proxy that matches the requested country", async () => {
  const pool = createPool({
    proxies: [
      proxy("1.1.1.1:8080", "US"),
      proxy("2.2.2.2:8080", "DE"),
    ],
    checkProxy: async (entry) => ({ ok: true, ip: `ip-${entry.host}`, latencyMs: 5 }),
    geoLookup: geoFrom({ "ip-1.1.1.1": "US", "ip-2.2.2.2": "DE" }),
  });
  await pool.refresh("test");

  const result = await pool.acquire({ bucket: "US", preferred: ["US", "DE"] });
  assert.equal(result.proxy.id, "http://1.1.1.1:8080");
  assert.equal(result.country, "US");
  assert.equal(result.ip, "ip-1.1.1.1");
});

test("skips a failing candidate and retries the next one", async () => {
  const pool = createPool({
    proxies: [
      proxy("1.1.1.1:8080", "US"),
      proxy("2.2.2.2:8080", "US"),
    ],
    checkProxy: async (entry) =>
      entry.host === "1.1.1.1"
        ? { ok: false, error: "connection refused" }
        : { ok: true, ip: "ip-good", latencyMs: 9 },
    geoLookup: geoFrom({ "ip-good": "US" }),
  });
  await pool.refresh("test");

  const result = await pool.acquire({ bucket: "US", preferred: ["US", "DE"] });
  assert.equal(result.proxy.id, "http://2.2.2.2:8080");
  assert.equal(pool.entries.get("http://1.1.1.1:8080").failures, 1);
});

test("other bucket rejects preferred countries", async () => {
  const pool = createPool({
    proxies: [
      proxy("1.1.1.1:8080", "US"),
      proxy("2.2.2.2:8080", "FR"),
    ],
    checkProxy: async (entry) => ({ ok: true, ip: `ip-${entry.host}`, latencyMs: 5 }),
    geoLookup: geoFrom({ "ip-1.1.1.1": "US", "ip-2.2.2.2": "FR" }),
  });
  await pool.refresh("test");

  const result = await pool.acquire({ bucket: "other", preferred: ["US", "DE"] });
  assert.equal(result.country, "FR");
});

test("returns null when no candidate matches the bucket", async () => {
  const pool = createPool({
    proxies: [proxy("1.1.1.1:8080", "US")],
    checkProxy: async () => ({ ok: true, ip: "ip-us", latencyMs: 5 }),
    geoLookup: geoFrom({ "ip-us": "US" }),
  });
  await pool.refresh("test");

  assert.equal(
    await pool.acquire({ bucket: "DE", preferred: ["US", "DE"] }),
    null
  );
});

test("cools down failed proxies before retrying them", async () => {
  let clock = 10_000;
  let checks = 0;
  const pool = createPool({
    proxies: [proxy("1.1.1.1:8080", "US")],
    cooldownMs: 1_000,
    now: () => clock,
    checkProxy: async () => {
      checks += 1;
      return { ok: false, error: "down" };
    },
  });
  await pool.refresh("test");

  assert.equal(
    await pool.acquire({ bucket: "US", preferred: ["US"] }),
    null
  );
  assert.equal(checks, 1);

  clock += 500;
  assert.equal(
    await pool.acquire({ bucket: "US", preferred: ["US"] }),
    null
  );
  assert.equal(checks, 1, "proxy should stay in cooldown");

  clock += 2_000;
  assert.equal(
    await pool.acquire({ bucket: "US", preferred: ["US"] }),
    null
  );
  assert.equal(checks, 2, "proxy should be retried after cooldown");
});

test("persists the pool and keeps health metadata across refreshes", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "proxy-pool-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cacheFile = path.join(directory, "proxies.json");

  const proxies = [
    proxy("1.1.1.1:8080", "US"),
    proxy("2.2.2.2:1080", "US"),
  ];
  const pool = createPool({
    proxies,
    cacheFile,
    checkProxy: async () => ({ ok: true, ip: "ip-us", latencyMs: 7 }),
    geoLookup: geoFrom({ "ip-us": "US" }),
  });

  await pool.refresh("test");
  await pool.acquire({ bucket: "US", preferred: ["US"] });
  await pool.flush();

  const reloaded = createPool({ proxies, cacheFile });
  await reloaded.load();
  assert.equal(reloaded.size, 2);
  assert.ok(
    reloaded.entries.get("http://1.1.1.1:8080").lastOkAt,
    "health timestamp should survive"
  );

  await reloaded.refresh("test");
  assert.ok(
    reloaded.entries.get("http://1.1.1.1:8080").lastOkAt,
    "refresh must not clear health metadata"
  );
});

test("ignores SOCKS proxies with credentials because Chromium cannot send them", async () => {
  const authenticatedSocks = proxy("socks5://user:pass@1.1.1.1:1080", "US");
  const pool = createPool({
    proxies: [authenticatedSocks],
    checkProxy: async () => ({ ok: true, ip: "ip-us", latencyMs: 5 }),
    geoLookup: geoFrom({ "ip-us": "US" }),
  });
  await pool.refresh("test");

  assert.equal(
    await pool.acquire({ bucket: "US", preferred: ["US"] }),
    null
  );
});
