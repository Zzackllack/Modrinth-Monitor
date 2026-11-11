const { parseProxyUrl } = require("./egress/proxy-model");
const {
  DEFAULT_SOURCES,
  resolveSourceDefinitions,
} = require("./egress/proxy-sources");
const { MODES } = require("./egress/route-planner");
const {
  DEFAULT_OTHER_COUNTRIES,
  normalizeBucket,
  parseCountryWeights,
  preferredBuckets,
} = require("./net/geo");

const MODE_DEFAULT = "direct";
const FALLBACKS = ["vpn", "direct", "none"];

function numberFrom(value) {
  return Number(String(value).trim());
}

function numberEnv(env, name, fallback, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;

  const value = numberFrom(raw);
  if (
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  ) {
    const bounds = `${min === -Infinity ? "" : `${min}..`}${max === Infinity ? "" : max}`;
    throw new Error(
      `${name} must be ${integer ? "an integer" : "a number"}${bounds ? ` between ${bounds}` : ""} (got "${raw}").`
    );
  }

  return value;
}

function booleanEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;

  const value = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;

  throw new Error(`${name} must be a boolean (true/false, 1/0, yes/no, on/off).`);
}

function listEnv(value) {
  return String(value || "")
    .split(/[,;\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function modeEnv(env) {
  const raw = String(env.EGRESS_MODE || MODE_DEFAULT).trim().toLowerCase();
  if (!MODES.has(raw)) {
    throw new Error(
      `EGRESS_MODE must be one of ${[...MODES].join(", ")} (got "${raw}").`
    );
  }
  return raw;
}

function protocolEnv(env) {
  const protocols = listEnv(env.PROXY_PROTOCOLS || "http,https,socks5").map(
    (value) => value.toLowerCase()
  );
  const supported = ["http", "https", "socks4", "socks4a", "socks5", "socks5h"];
  for (const protocol of protocols) {
    if (!supported.includes(protocol)) {
      throw new Error(
        `PROXY_PROTOCOLS contains unsupported protocol "${protocol}" (supported: ${supported.join(", ")}).`
      );
    }
  }
  return protocols;
}

function otherCountriesEnv(env) {
  const values = listEnv(env.EGRESS_OTHER_COUNTRIES);
  if (!values.length) return DEFAULT_OTHER_COUNTRIES;

  const countries = [];
  for (const value of values) {
    const bucket = normalizeBucket(value);
    if (!bucket || bucket === "other") {
      throw new Error(
        `EGRESS_OTHER_COUNTRIES must contain ISO 3166-1 alpha-2 codes (got "${value}").`
      );
    }
    countries.push(bucket);
  }
  return countries;
}

function fallbackEnv(env) {
  const raw = String(env.EGRESS_PROXY_FALLBACK || "vpn").trim().toLowerCase();
  if (!FALLBACKS.includes(raw)) {
    throw new Error(
      `EGRESS_PROXY_FALLBACK must be one of ${FALLBACKS.join(", ")} (got "${raw}").`
    );
  }
  return raw;
}

function vpnProxyEnv(env) {
  const raw = String(env.VPN_PROXY_URL || "").trim();
  if (!raw) return null;

  try {
    return parseProxyUrl(raw, { defaultProtocol: "http" });
  } catch (error) {
    throw new Error(`VPN_PROXY_URL is invalid: ${error.message}`);
  }
}

function defaultVpnShare(mode) {
  if (mode === "vpn") return 100;
  if (mode === "proxy") return 0;
  if (mode === "mixed") return 50;
  return 0;
}

/** Legacy hour-based scheduler controls still work; validate them too. */
function hoursToMinutes(env, name, fallbackMinutes) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") return fallbackMinutes;

  const hours = numberFrom(raw);
  if (!Number.isFinite(hours) || hours < 0) {
    throw new Error(`${name} must be a non-negative number (got "${raw}").`);
  }
  return hours * 60;
}

/**
 * Single source of truth for every knob. Parsing here means the scheduler can
 * fail fast on a bad .env instead of discovering it mid-run.
 */
function loadConfig(env = process.env) {
  const mode = modeEnv(env);
  const weights = parseCountryWeights(
    env.EGRESS_COUNTRY_WEIGHTS || "US=1,DE=1,other=1"
  );
  const preferred = preferredBuckets(weights);
  const otherCountries = otherCountriesEnv(env);

  const minDelayMinutes = numberEnv(
    env,
    "MIN_DELAY_MINUTES",
    hoursToMinutes(env, "MIN_DELAY_HOURS", 180),
    { min: 0 }
  );
  const maxDelayMinutes = numberEnv(
    env,
    "MAX_DELAY_MINUTES",
    hoursToMinutes(env, "MAX_DELAY_HOURS", 240),
    { min: 0 }
  );
  if (maxDelayMinutes < minDelayMinutes) {
    throw new Error(
      "MAX_DELAY_MINUTES must be greater than or equal to MIN_DELAY_MINUTES."
    );
  }

  const sourceDefinitions = resolveSourceDefinitions(
    env.PROXY_SOURCES || DEFAULT_SOURCES
  );

  const vpnProxy = vpnProxyEnv(env);

  return {
    mode,
    vpnShare: numberEnv(env, "EGRESS_VPN_SHARE", defaultVpnShare(mode), {
      min: 0,
      max: 100,
    }),
    countries: {
      weights,
      preferred,
      otherCountries,
    },
    retries: {
      max: numberEnv(env, "EGRESS_MAX_RETRIES", 3, { min: 1, max: 10, integer: true }),
      delayMs:
        numberEnv(env, "EGRESS_RETRY_DELAY_SECONDS", 10, { min: 0, max: 600 }) *
        1000,
    },
    vpn: {
      enabled: mode === "vpn" || mode === "mixed",
      controlUrl: env.GLUETUN_CONTROL_URL || "http://localhost:8000",
      username: env.GLUETUN_CONTROL_USER || "",
      password: env.GLUETUN_CONTROL_PASSWORD || "",
      // Gluetun's built-in HTTP proxy is what lets a bridge-network container
      // use the tunnel without sharing the VPN namespace.
      proxy: vpnProxy,
      connectTimeoutMs:
        numberEnv(env, "VPN_CONNECT_TIMEOUT_SECONDS", 120, { min: 5, max: 600 }) *
        1000,
      pollMs:
        numberEnv(env, "VPN_STATUS_POLL_SECONDS", 3, { min: 1, max: 60 }) * 1000,
      verifyCountry: booleanEnv(env, "EGRESS_VERIFY_COUNTRY", true),
      restartTimeoutMs:
        numberEnv(env, "VPN_RESTART_TIMEOUT_SECONDS", 30, { min: 5, max: 300 }) *
        1000,
      cities: listEnv(env.GLUETUN_CITY_POOL),
      regions: listEnv(env.GLUETUN_REGION_POOL),
      hostnames: listEnv(env.GLUETUN_HOSTNAME_POOL),
    },
    proxy: {
      enabled: mode === "proxy" || mode === "mixed",
      sourceDefinitions,
      protocols: protocolEnv(env),
      fallback: fallbackEnv(env),
      cacheFile: env.PROXY_CACHE_FILE || "./data/proxies.json",
      refreshMs:
        numberEnv(env, "PROXY_REFRESH_MINUTES", 30, { min: 1, max: 1440 }) * 60_000,
      maxCandidates: numberEnv(env, "PROXY_MAX_CANDIDATES", 6, {
        min: 1,
        max: 20,
        integer: true,
      }),
      maxPoolSize: numberEnv(env, "PROXY_MAX_POOL_SIZE", 5000, {
        min: 50,
        max: 50_000,
        integer: true,
      }),
      cooldownMs:
        numberEnv(env, "PROXY_COOLDOWN_MINUTES", 10, { min: 1, max: 240 }) *
        60_000,
      checkUrl: env.PROXY_CHECK_URL || "https://api.ipify.org/",
      checkTimeoutMs: numberEnv(env, "PROXY_CHECK_TIMEOUT_MS", 6000, {
        min: 500,
        max: 60_000,
      }),
      verifyCountry: booleanEnv(env, "PROXY_VERIFY_COUNTRY", true),
    },
    geoLookup: {
      providerUrl: env.GEO_LOOKUP_URL || "https://ipwho.is/",
      timeoutMs: numberEnv(env, "GEO_LOOKUP_TIMEOUT_MS", 5000, {
        min: 500,
        max: 30_000,
      }),
      cacheFile: env.GEO_CACHE_FILE || "./data/geo.json",
    },
    logging: {
      file: env.EGRESS_LOG_FILE || "./logs/egress.jsonl",
    },
    probe: {
      timeoutMs: numberEnv(env, "EGRESS_PROBE_TIMEOUT_MS", 20_000, {
        min: 1000,
        max: 120_000,
      }),
    },
    scheduler: {
      minDelayMs: minDelayMinutes * 60_000,
      maxDelayMs: maxDelayMinutes * 60_000,
      oneShot: booleanEnv(env, "ONE_SHOT", false),
      browsersPath: env.PLAYWRIGHT_BROWSERS_PATH || "./.playwright-browsers",
    },
  };
}

module.exports = { loadConfig };
