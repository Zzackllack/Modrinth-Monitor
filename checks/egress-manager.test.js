const assert = require("node:assert/strict");
const test = require("node:test");
const { loadConfig } = require("../src/config");
const { EgressManager } = require("../src/egress/egress-manager");
const { parseProxyUrl } = require("../src/egress/proxy-model");

function buildConfig(overrides = {}) {
  return loadConfig({
    EGRESS_MODE: "mixed",
    EGRESS_VPN_SHARE: "0",
    EGRESS_COUNTRY_WEIGHTS: "US=1",
    EGRESS_MAX_RETRIES: "2",
    EGRESS_RETRY_DELAY_SECONDS: "0",
    PROXY_SOURCES: "proxifly",
    ...overrides,
  });
}

function createJournal() {
  const records = [];
  return {
    records,
    record(event, fields = {}) {
      records.push({ event, ...fields });
    },
    events(name) {
      return records.filter((record) => record.event === name);
    },
  };
}

function proxyResult(address) {
  const proxy = parseProxyUrl(address);
  return { proxy, country: "US", ip: `ip-${proxy.host}`, latencyMs: 12 };
}

test("retries a failed attempt with a fresh route and reports the bad proxy", async () => {
  const config = buildConfig();
  const journal = createJournal();
  const acquired = [];
  const reported = [];
  let executions = 0;

  const proxyPool = {
    acquire: async () => {
      const result = proxyResult(
        acquired.length === 0 ? "1.1.1.1:8080" : "2.2.2.2:8080"
      );
      acquired.push(result.proxy.id);
      return result;
    },
    reportFailure: (id, error) => reported.push({ id, error }),
    stop: async () => {},
  };

  const manager = new EgressManager({
    config,
    journal,
    proxyPool,
    geoLookup: { lookup: async () => "US" },
    sleep: async () => {},
  });

  const seenEnvironments = [];
  const result = await manager.runWithRetries({
    execute: async (env) => {
      executions += 1;
      seenEnvironments.push(env);
      if (executions === 1) throw new Error("page load failed");
    },
  });

  assert.equal(result.attempts, 2);
  assert.equal(executions, 2);
  assert.deepEqual(acquired, ["http://1.1.1.1:8080", "http://2.2.2.2:8080"]);
  assert.equal(reported.length, 1);
  assert.equal(reported[0].id, "http://1.1.1.1:8080");
  assert.match(reported[0].error, /page load failed/);

  assert.equal(seenEnvironments[1].MONITOR_PROXY_SERVER, "http://2.2.2.2:8080");
  assert.equal(seenEnvironments[1].EGRESS_KIND, "proxy");
  assert.equal(seenEnvironments[1].EGRESS_COUNTRY, "US");

  assert.equal(journal.events("egress.attempt.failed").length, 1);
  assert.equal(journal.events("egress.attempt.success").length, 1);
});

test("falls back to the VPN when no proxy is healthy", async () => {
  const config = buildConfig();
  const journal = createJournal();
  const selections = [];

  const proxyPool = {
    acquire: async () => null,
    reportFailure: () => {},
    stop: async () => {},
  };

  const gluetun = {
    setServerSelection: async (selection) => {
      selections.push(selection);
      return { selection: selection.countries, outcome: "restarting" };
    },
    waitForRestart: async () => true,
    waitForRunning: async () => "running",
    getPublicIp: async () => "198.51.100.9",
  };

  const manager = new EgressManager({
    config,
    journal,
    proxyPool,
    gluetun,
    geoLookup: { lookup: async () => "US" },
    sleep: async () => {},
  });

  const result = await manager.runWithRetries({
    execute: async () => {},
  });

  assert.equal(result.route.kind, "vpn");
  assert.equal(result.route.fallbackFrom, "proxy");
  assert.equal(result.route.observedCountry, "US");
  assert.deepEqual(selections[0].countries, ["US"]);
  assert.equal(journal.events("egress.proxy.unavailable").length, 1);
});

test("builds proxy environments without leaking credentials into other fields", () => {
  const config = buildConfig();
  const manager = new EgressManager({
    config,
    journal: createJournal(),
    geoLookup: { lookup: async () => undefined },
  });

  const proxy = parseProxyUrl("http://user:pass@1.1.1.1:8080");
  const proxyEnv = manager.envFor({
    kind: "proxy",
    bucket: "US",
    requestedCountry: "US",
    attempt: 1,
    routeId: "route-1",
    proxy,
    observedCountry: "US",
  });

  assert.equal(proxyEnv.MONITOR_PROXY_SERVER, "http://1.1.1.1:8080");
  assert.equal(proxyEnv.MONITOR_PROXY_USERNAME, "user");
  assert.equal(proxyEnv.MONITOR_PROXY_PASSWORD, "pass");
  assert.equal(proxyEnv.EGRESS_PROXY_ID, "http://1.1.1.1:8080");

  const directEnv = manager.envFor({
    kind: "direct",
    bucket: "other",
    requestedCountry: null,
    attempt: 2,
    routeId: "route-2",
  });

  assert.equal(directEnv.MONITOR_PROXY_SERVER, "");
  assert.equal(directEnv.MONITOR_PROXY_USERNAME, "");
  assert.equal(directEnv.MONITOR_PROXY_PASSWORD, "");
  assert.equal(directEnv.EGRESS_COUNTRY, "");
});

test("throws after the retry budget is exhausted", async () => {
  const config = buildConfig({ EGRESS_MAX_RETRIES: "1" });
  const journal = createJournal();

  const manager = new EgressManager({
    config,
    journal,
    proxyPool: {
      acquire: async () => proxyResult("1.1.1.1:8080"),
      reportFailure: () => {},
      stop: async () => {},
    },
    geoLookup: { lookup: async () => "US" },
    sleep: async () => {},
  });

  await assert.rejects(
    manager.runWithRetries({
      execute: async () => {
        throw new Error("download failed");
      },
    }),
    /Egress failed after 1 attempt/
  );

  const exhausted = journal.events("egress.exhausted");
  assert.equal(exhausted.length, 1);
  assert.equal(exhausted[0].failures.length, 1);
  assert.match(exhausted[0].failures[0].error, /download failed/);
});

test("direct mode runs without any egress dependency", async () => {
  const config = buildConfig({ EGRESS_MODE: "direct" });
  const journal = createJournal();

  const manager = new EgressManager({
    config,
    journal,
    sleep: async () => {},
  });

  let observedEnv;
  const result = await manager.runWithRetries({
    execute: async (env) => {
      observedEnv = env;
    },
  });

  assert.equal(result.route.kind, "direct");
  assert.equal(observedEnv.MONITOR_PROXY_SERVER, "");
  assert.equal(observedEnv.EGRESS_KIND, "direct");
});
