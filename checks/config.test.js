const assert = require("node:assert/strict");
const test = require("node:test");
const { loadConfig } = require("../src/config");

test("defaults to direct mode with equal country thirds", () => {
  const config = loadConfig({});

  assert.equal(config.mode, "direct");
  assert.deepEqual(
    config.countries.weights.map((entry) => entry.bucket),
    ["US", "DE", "other"]
  );
  assert.deepEqual(config.countries.preferred, ["US", "DE"]);
  assert.equal(config.retries.max, 3);
  assert.equal(config.proxy.fallback, "vpn");
  assert.equal(config.vpn.proxy, null);
  assert.equal(config.scheduler.oneShot, false);
});

test("composes mixed mode and proxy settings from env", () => {
  const config = loadConfig({
    EGRESS_MODE: "mixed",
    EGRESS_VPN_SHARE: "25",
    EGRESS_COUNTRY_WEIGHTS: "US=2,DE=1,other=1",
    EGRESS_MAX_RETRIES: "5",
    EGRESS_RETRY_DELAY_SECONDS: "2",
    EGRESS_PROXY_FALLBACK: "none",
    PROXY_SOURCES: "proxifly,hookzof",
    PROXY_PROTOCOLS: "http,socks5",
    PROXY_REFRESH_MINUTES: "15",
    PROXY_MAX_CANDIDATES: "3",
    VPN_PROXY_URL: "socks5://user:pass@10.0.0.1:1080",
    ONE_SHOT: "true",
    MIN_DELAY_HOURS: "1",
    MAX_DELAY_HOURS: "2",
  });

  assert.equal(config.mode, "mixed");
  assert.equal(config.vpnShare, 25);
  assert.equal(config.retries.max, 5);
  assert.equal(config.retries.delayMs, 2_000);
  assert.equal(config.proxy.fallback, "none");
  assert.deepEqual(config.proxy.protocols, ["http", "socks5"]);
  assert.equal(config.proxy.refreshMs, 15 * 60_000);
  assert.equal(config.proxy.sourceDefinitions.length, 2);
  assert.equal(config.vpn.proxy.id, "socks5://10.0.0.1:1080");
  assert.equal(config.scheduler.oneShot, true);
  assert.equal(config.scheduler.minDelayMs, 60 * 60_000);
  assert.equal(config.scheduler.maxDelayMs, 120 * 60_000);
  assert.equal(config.countries.weights[0].share, 0.5);
});

test("rejects invalid egress settings instead of guessing", () => {
  const invalid = [
    { EGRESS_MODE: "tor" },
    { EGRESS_COUNTRY_WEIGHTS: "XYZ=1" },
    { EGRESS_COUNTRY_WEIGHTS: "US=0,DE=0" },
    { EGRESS_MAX_RETRIES: "0" },
    { EGRESS_MAX_RETRIES: "2.5" },
    { EGRESS_VPN_SHARE: "101" },
    { EGRESS_PROXY_FALLBACK: "tor" },
    { EGRESS_VERIFY_COUNTRY: "maybe" },
    { PROXY_PROTOCOLS: "quic" },
    { PROXY_SOURCES: "unknown-feed" },
    { VPN_PROXY_URL: "not a valid url" },
    { MIN_DELAY_MINUTES: "abc" },
    { MIN_DELAY_HOURS: "abc" },
    { MIN_DELAY_MINUTES: "30", MAX_DELAY_MINUTES: "10" },
    { EGRESS_OTHER_COUNTRIES: "USA" },
  ];

  for (const patch of invalid) {
    assert.throws(
      () => loadConfig(patch),
      /EGRESS_|PROXY_|VPN_PROXY_URL|MIN_DELAY|MAX_DELAY|Unknown proxy source/,
      JSON.stringify(patch)
    );
  }
});
