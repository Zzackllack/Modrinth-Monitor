const { spawn } = require("child_process");
const { dumpEnv, dumpSystem, logAction } = require("./logger");

const MIN_DELAY_MINUTES = parseFloat(
  process.env.MIN_DELAY_MINUTES || process.env.MIN_DELAY_HOURS * 60 || "180"
);
const MAX_DELAY_MINUTES = parseFloat(
  process.env.MAX_DELAY_MINUTES || process.env.MAX_DELAY_HOURS * 60 || "240"
);
const ONE_SHOT = process.env.ONE_SHOT === "true";
const PLAYWRIGHT_BROWSERS_PATH =
  process.env.PLAYWRIGHT_BROWSERS_PATH || "./.playwright-browsers";
const GLUETUN_CONTROL_URL =
  process.env.GLUETUN_CONTROL_URL || "http://localhost:8000";
const GLUETUN_CONTROL_USER = process.env.GLUETUN_CONTROL_USER || "";
const GLUETUN_CONTROL_PASSWORD = process.env.GLUETUN_CONTROL_PASSWORD || "";
const GLUETUN_COUNTRY_POOL =
  process.env.GLUETUN_COUNTRY_POOL || process.env.SERVER_COUNTRIES || "";
const GLUETUN_CITY_POOL = process.env.GLUETUN_CITY_POOL || "";
const GLUETUN_REGION_POOL = process.env.GLUETUN_REGION_POOL || "";
const GLUETUN_HOSTNAME_POOL = process.env.GLUETUN_HOSTNAME_POOL || "";

if (Number.isNaN(MIN_DELAY_MINUTES) || Number.isNaN(MAX_DELAY_MINUTES)) {
  throw new Error("MIN_DELAY_MINUTES and MAX_DELAY_MINUTES must be numbers.");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelayMs() {
  const minMs = MIN_DELAY_MINUTES * 60 * 1000;
  const maxMs = MAX_DELAY_MINUTES * 60 * 1000;
  return Math.random() * (maxMs - minMs) + minMs;
}

function authHeaders() {
  if (!GLUETUN_CONTROL_USER) return {};
  const token = Buffer.from(
    `${GLUETUN_CONTROL_USER}:${GLUETUN_CONTROL_PASSWORD}`
  ).toString("base64");
  return { Authorization: `Basic ${token}` };
}

function pickRandomValue(pool) {
  const items = pool
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!items.length) return undefined;
  const idx = Math.floor(Math.random() * items.length);
  return items[idx];
}

async function patchGluetunServerSelection() {
  const selection = {};
  const country = pickRandomValue(GLUETUN_COUNTRY_POOL);
  const city = pickRandomValue(GLUETUN_CITY_POOL);
  const region = pickRandomValue(GLUETUN_REGION_POOL);
  const hostname = pickRandomValue(GLUETUN_HOSTNAME_POOL);

  if (country) selection.countries = [country];
  if (city) selection.cities = [city];
  if (region) selection.regions = [region];
  if (hostname) selection.hostnames = [hostname];

  if (Object.keys(selection).length === 0) {
    return null;
  }

  const payload = { provider: { server_selection: selection } };
  logAction("gluetun.patch.start", { payload });

  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(`${GLUETUN_CONTROL_URL}/v1/vpn/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(payload),
      });

      const text = await res.text();
      if (!res.ok) {
        throw new Error(
          `gluetun patch failed (${res.status}): ${text || res.statusText}`
        );
      }

      logAction("gluetun.patch.success", { response: text, attempt });
      return selection;
    } catch (err) {
      lastErr = err;
      logAction("gluetun.patch.retry", { attempt, error: err.message });
      await sleep(2000 * attempt);
    }
  }

  throw lastErr || new Error("gluetun patch failed");
}

async function getPublicIP() {
  try {
    const res = await fetch(`${GLUETUN_CONTROL_URL}/v1/publicip/ip`, {
      headers: authHeaders(),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.public_ip || null;
  } catch {
    return null;
  }
}

function runPlaywright() {
  return new Promise((resolve, reject) => {
    logAction("playwright.start", {
      env: {
        MODRINTH_URL: process.env.MODRINTH_URL,
        DOWNLOAD_DIR: process.env.DOWNLOAD_DIR,
        PLAYWRIGHT_BROWSERS_PATH,
      },
    });

    const child = spawn("pnpm", ["exec", "playwright", "test"], {
      stdio: "inherit",
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH,
      },
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Playwright exited with code ${code}`));
      }
    });

    child.on("error", reject);
  });
}

async function preflightModrinth() {
  const url =
    process.env.MODRINTH_URL || "https://modrinth.com/modpack/winterlands";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    logAction("preflight.modrinth.ok", { url, status: res.status });
    return true;
  } catch (err) {
    logAction("preflight.modrinth.failed", {
      url,
      error: err.message || String(err),
    });
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function preflightWithRetry(attempts = 3, delayMs = 5000) {
  for (let i = 1; i <= attempts; i++) {
    const ok = await preflightModrinth();
    if (ok) return true;
    await sleep(delayMs);
  }
  return false;
}

async function loop() {
  logAction("scheduler.init", {
    env: dumpEnv(),
    system: dumpSystem(),
  });

  let lastIP = await getPublicIP();
  if (lastIP) {
    logAction("gluetun.ip", { publicIP: lastIP });
  }

  while (true) {
    const startedAt = new Date().toISOString();
    logAction("run.start", { startedAt });

    try {
      let played = false;
      for (let attempt = 1; attempt <= 3 && !played; attempt++) {
        const selection = await patchGluetunServerSelection();
        if (selection) {
          logAction("gluetun.selection.applied", { ...selection, attempt });
        }

        const ipBefore = lastIP || (await getPublicIP());
        if (ipBefore) {
          logAction("gluetun.ip.before", { publicIP: ipBefore, attempt });
        }

        const netOk = await preflightWithRetry(3, 5000);
        if (!netOk) {
          logAction("preflight.modrinth.exhausted", { attempt });
          continue; // try another country
        }

        await runPlaywright();
        logAction("run.success", { finishedAt: new Date().toISOString() });

        const ipAfter = await getPublicIP();
        if (ipAfter) {
          logAction("gluetun.ip.after", { publicIP: ipAfter });
          if (ipBefore && ipAfter === ipBefore) {
            logAction("gluetun.ip.unchanged", { publicIP: ipAfter });
          }
          lastIP = ipAfter;
        }
        played = true;
      }

      if (!played) {
        throw new Error("preflight to modrinth failed after multiple regions");
      }
    } catch (err) {
      logAction("run.failure", {
        finishedAt: new Date().toISOString(),
        error: err.message,
      });
    }

    if (ONE_SHOT) {
      logAction("scheduler.exit", { reason: "one_shot" });
      break;
    }

    const delay = randomDelayMs();
    const delayHours = delay / (1000 * 60 * 60);
    logAction("scheduler.sleep", {
      delayMs: delay,
      delayHours: Number(delayHours.toFixed(2)),
      delayMinutes: Math.round(delay / 60000),
    });
    await sleep(delay);
  }
}

loop().catch((err) => {
  logAction("scheduler.crash", { error: err.message });
  process.exit(1);
});
