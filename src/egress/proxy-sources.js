const { fetchText } = require("../net/http");
const { dedupeProxies, parseProxyList } = require("./proxy-model");

const RAW = "https://raw.githubusercontent.com";

/**
 * Public, auto-updating feeds. The first set of every feed is the default; add
 * more with PROXY_SOURCES (keys or full URLs) when the extra volume is worth
 * the health-check time.
 *
 * proxifly is the primary source because it is regenerated every few minutes
 * and ships exit-country metadata, which is what makes geographic selection
 * cheap. The others are plain host:port feeds and only add volume.
 */
const SOURCE_DEFINITIONS = {
  proxifly: [
    {
      url: `${RAW}/proxifly/free-proxy-list/main/proxies/all/data.json`,
      format: "proxifly-json",
      label: "proxifly/all",
    },
  ],
  monosans: [
    {
      url: `${RAW}/monosans/proxy-list/main/proxies/all.txt`,
      format: "lines",
      label: "monosans/all",
    },
  ],
  thespeedx: [
    {
      url: `${RAW}/TheSpeedX/PROXY-List/master/http.txt`,
      format: "lines",
      label: "thespeedx/http",
      defaultProtocol: "http",
    },
    {
      url: `${RAW}/TheSpeedX/PROXY-List/master/socks4.txt`,
      format: "lines",
      label: "thespeedx/socks4",
      defaultProtocol: "socks4",
    },
    {
      url: `${RAW}/TheSpeedX/PROXY-List/master/socks5.txt`,
      format: "lines",
      label: "thespeedx/socks5",
      defaultProtocol: "socks5",
    },
  ],
  clarketm: [
    {
      url: `${RAW}/clarketm/proxy-list/master/proxy-list-raw.txt`,
      format: "lines",
      label: "clarketm/raw",
      defaultProtocol: "http",
    },
  ],
  hookzof: [
    {
      url: `${RAW}/hookzof/socks5_list/master/proxy.txt`,
      format: "lines",
      label: "hookzof/socks5",
      defaultProtocol: "socks5",
    },
  ],
};

const DEFAULT_SOURCES = "proxifly,monosans";

function describeUrlSource(url) {
  return {
    url,
    format: "lines",
    label: url.replace(/^https?:\/\//, "").slice(0, 80),
    defaultProtocol: "http",
  };
}

/**
 * Resolves `PROXY_SOURCES` into concrete feed descriptors. Accepts known keys,
 * full URLs and comma/whitespace separated combinations of both.
 */
function resolveSourceDefinitions(raw = DEFAULT_SOURCES) {
  const parts = String(raw)
    .split(/[,;\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (!parts.length) {
    throw new Error("PROXY_SOURCES must list at least one source.");
  }

  const resolved = [];
  for (const part of parts) {
    const key = part.toLowerCase();
    if (SOURCE_DEFINITIONS[key]) {
      resolved.push(...SOURCE_DEFINITIONS[key]);
      continue;
    }

    if (/^https?:\/\//i.test(part)) {
      resolved.push(describeUrlSource(part));
      continue;
    }

    throw new Error(
      `Unknown proxy source "${part}". Use one of ${Object.keys(SOURCE_DEFINITIONS).join(", ")} or a full http(s) URL.`
    );
  }

  return resolved;
}

async function fetchSource(definition, { timeoutMs = 25_000, protocols, logAction } = {}) {
  const startedAt = Date.now();
  try {
    const text = await fetchText(definition.url, { timeoutMs });
    const { proxies, skipped } = parseProxyList(text, {
      format: definition.format,
      defaultProtocol: definition.defaultProtocol || "http",
      source: definition.label,
    });

    const filtered = protocols && protocols.length
      ? proxies.filter((proxy) => protocols.includes(proxy.protocol))
      : proxies;

    logAction?.("proxy.source.loaded", {
      source: definition.label,
      proxies: filtered.length,
      skipped,
      durationMs: Date.now() - startedAt,
    });

    return { source: definition.label, proxies: filtered, skipped };
  } catch (error) {
    logAction?.("proxy.source.failed", {
      source: definition.label,
      error: error.message,
      durationMs: Date.now() - startedAt,
    });
    return { source: definition.label, proxies: [], error: error.message };
  }
}

/**
 * Fetches every feed concurrently. A dead feed must not take the whole refresh
 * down, so failures are returned instead of thrown.
 */
async function fetchSources(definitions, options = {}) {
  const results = await Promise.all(
    definitions.map((definition) => fetchSource(definition, options))
  );

  const proxies = dedupeProxies(results.flatMap((result) => result.proxies));
  const errors = results.filter((result) => result.error);

  return { proxies, results, errors };
}

module.exports = {
  DEFAULT_SOURCES,
  fetchSources,
  resolveSourceDefinitions,
};
