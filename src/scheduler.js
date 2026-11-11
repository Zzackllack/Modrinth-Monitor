const { spawn } = require("node:child_process");
const { loadConfig } = require("./config");
const { EgressJournal } = require("./egress/egress-journal");
const { EgressManager } = require("./egress/egress-manager");
const { GeoLookup } = require("./egress/geo-lookup");
const { GluetunClient } = require("./egress/gluetun");
const { summarizePlaywrightFailure } = require("./egress/playwright-failure");
const { ProxyPool } = require("./egress/proxy-pool");
const { sleep } = require("./net/http");
const { dumpEnv, dumpSystem, logAction } = require("./logger");

const DEFAULT_URL = "https://modrinth.com/modpack/winterlands";

let activeChild = null;
let shuttingDown = false;

function randomDelayMs(config) {
  const { minDelayMs, maxDelayMs } = config.scheduler;
  return Math.random() * (maxDelayMs - minDelayMs) + minDelayMs;
}

/** Route metadata is per attempt; never inherit it from the parent process. */
function childEnv(routeEnv) {
  const env = { ...process.env };

  for (const key of Object.keys(env)) {
    if (key.startsWith("MONITOR_PROXY_") || key.startsWith("EGRESS_")) {
      delete env[key];
    }
  }

  return { ...env, ...routeEnv };
}

function runPlaywright(routeEnv, config) {
  return new Promise((resolve, reject) => {
    logAction("playwright.start", {
      env: {
        MODRINTH_URL: process.env.MODRINTH_URL,
        DOWNLOAD_DIR: process.env.DOWNLOAD_DIR,
        PLAYWRIGHT_BROWSERS_PATH: config.scheduler.browsersPath,
        egressKind: routeEnv.EGRESS_KIND,
        egressCountry: routeEnv.EGRESS_COUNTRY,
        egressProxy: routeEnv.EGRESS_PROXY_ID || null,
      },
    });

    const child = spawn("pnpm", ["exec", "playwright", "test"], {
      // Piped instead of inherited so the failure reason (for example
      // ERR_PROXY_CERTIFICATE_INVALID) reaches the egress journal.
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...childEnv(routeEnv),
        PLAYWRIGHT_BROWSERS_PATH: config.scheduler.browsersPath,
      },
    });
    activeChild = child;

    let tail = "";
    const collect = (chunk) => {
      tail = (tail + chunk.toString()).slice(-8_000);
    };

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      collect(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      collect(chunk);
    });

    child.on("exit", (code, signal) => {
      activeChild = null;
      if (code === 0) {
        resolve();
        return;
      }

      const reason =
        code === null
          ? `Playwright was terminated by ${signal}.`
          : `Playwright exited with code ${code}.`;
      const excerpt = summarizePlaywrightFailure(tail);

      reject(new Error(excerpt ? `${reason} ${excerpt}` : reason));
    });

    child.on("error", (error) => {
      activeChild = null;
      reject(error);
    });
  });
}

function summarizeConfig(config) {
  return {
    mode: config.mode,
    vpnShare: config.vpnShare,
    countryWeights: config.countries.weights.map((entry) => ({
      bucket: entry.bucket,
      share: Number(entry.share.toFixed(3)),
    })),
    otherCountries: config.countries.otherCountries.length,
    retries: config.retries,
    vpn: {
      controlUrl: config.vpn.controlUrl,
      viaHttpProxy: Boolean(config.vpn.proxy),
      verifyCountry: config.vpn.verifyCountry,
      connectTimeoutMs: config.vpn.connectTimeoutMs,
    },
    proxy: {
      sources: config.proxy.sourceDefinitions.map((source) => source.label),
      protocols: config.proxy.protocols,
      fallback: config.proxy.fallback,
      refreshMinutes: config.proxy.refreshMs / 60_000,
      maxCandidates: config.proxy.maxCandidates,
      cacheFile: config.proxy.cacheFile,
    },
    logging: config.logging,
  };
}

function warnDeprecatedPools(journal) {
  if (process.env.GLUETUN_COUNTRY_POOL || process.env.SERVER_COUNTRIES) {
    journal.record("config.deprecated", {
      variable: process.env.GLUETUN_COUNTRY_POOL
        ? "GLUETUN_COUNTRY_POOL"
        : "SERVER_COUNTRIES",
      message:
        "Country selection is now driven by EGRESS_COUNTRY_WEIGHTS; the country pool is ignored.",
    });
  }
}

async function createProxyPool(config, geoLookup, journal) {
  if (!config.proxy.enabled) return null;

  const pool = new ProxyPool({
    sourceDefinitions: config.proxy.sourceDefinitions,
    protocols: config.proxy.protocols,
    cacheFile: config.proxy.cacheFile,
    maxPoolSize: config.proxy.maxPoolSize,
    maxCandidates: config.proxy.maxCandidates,
    cooldownMs: config.proxy.cooldownMs,
    checkUrl: config.proxy.checkUrl,
    checkTimeoutMs: config.proxy.checkTimeoutMs,
    verifyProxyTls: config.proxy.verifyProxyTls,
    geoLookup,
    logAction,
  });

  await pool.load();

  try {
    await pool.refresh("startup");
  } catch (error) {
    journal.record("proxy.refresh.failed", {
      reason: "startup",
      error: error.message,
      cached: pool.size,
    });
  }

  pool.startAutoRefresh(config.proxy.refreshMs);
  journal.record("proxy.pool.ready", pool.stats());

  return pool;
}

async function main() {
  const config = loadConfig();
  const journal = new EgressJournal({
    file: config.logging.file,
    logAction,
  });

  warnDeprecatedPools(journal);

  const geoLookup = new GeoLookup({
    ...config.geoLookup,
    logAction,
  });

  const gluetun = new GluetunClient({
    baseUrl: config.vpn.controlUrl,
    username: config.vpn.username,
    password: config.vpn.password,
    logAction,
  });

  const proxyPool = await createProxyPool(config, geoLookup, journal);

  const manager = new EgressManager({
    config,
    journal,
    proxyPool,
    gluetun,
    geoLookup,
  });

  journal.record("scheduler.init", {
    env: dumpEnv(),
    system: dumpSystem(),
    config: summarizeConfig(config),
  });

  if (config.vpn.enabled) {
    try {
      const ip = await gluetun.getPublicIp();
      if (ip) journal.record("gluetun.ip.current", { publicIP: ip });
    } catch (error) {
      journal.record("gluetun.unreachable", {
        controlUrl: config.vpn.controlUrl,
        error: error.message,
      });
    }
  }

  const targetUrl = process.env.MODRINTH_URL || DEFAULT_URL;

  while (!shuttingDown) {
    const startedAt = new Date().toISOString();
    journal.record("run.start", { startedAt, targetUrl });

    try {
      const result = await manager.runWithRetries({
        execute: (routeEnv) => {
          if (shuttingDown) throw new Error("Shutting down.");
          return runPlaywright(routeEnv, config);
        },
        probeUrl: targetUrl,
      });

      journal.record("run.success", {
        finishedAt: new Date().toISOString(),
        attempts: result.attempts,
        ...manager.describeRoute(result.route),
      });
    } catch (error) {
      journal.record("run.failure", {
        finishedAt: new Date().toISOString(),
        error: error.message,
        attempts: error.attempts,
      });
    }

    await geoLookup.flush().catch(() => {});

    if (config.scheduler.oneShot || shuttingDown) break;

    const delay = randomDelayMs(config);
    journal.record("scheduler.sleep", {
      delayMs: delay,
      delayHours: Number((delay / 3_600_000).toFixed(2)),
      delayMinutes: Math.round(delay / 60_000),
    });
    await sleep(delay);
  }

  await manager.stop();
  journal.record("scheduler.exit", {
    reason: shuttingDown ? "signal" : "one_shot",
  });
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logAction("scheduler.shutdown", { signal });
  if (activeChild) activeChild.kill("SIGTERM");
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

main().catch((error) => {
  logAction("scheduler.crash", { error: error.message });
  process.exit(1);
});
