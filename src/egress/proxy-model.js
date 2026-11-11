const { formatHostForUrl, stripBrackets } = require("../net/ip");

const SUPPORTED_PROTOCOLS = new Set([
  "http",
  "https",
  "socks4",
  "socks4a",
  "socks5",
  "socks5h",
]);

const COUNTRY_IN_BUCKET = /^[A-Z]{2}$/;
const AUTHORITY_WITH_PORT =
  /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(?:\[[^\]]+\]|[^:/?#]+):(\d{1,5})(?:[/?#]|$)/i;

function normalizeProxyCountry(value) {
  const code = String(value || "").trim().toUpperCase();
  if (!COUNTRY_IN_BUCKET.test(code) || code === "ZZ") return undefined;
  return code;
}

/**
 * Accepts `host:port`, `scheme://host:port`, `user:pass@host:port` and IPv6
 * literals (`[2001:db8::1]:8080`). Unbracketed IPv6 is split on the last colon,
 * which is what most public proxy lists ship.
 */
function parseProxyUrl(input, { defaultProtocol = "http" } = {}) {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("Empty proxy address.");

  let candidate = raw;
  if (!candidate.includes("://")) {
    candidate = `${defaultProtocol}://${candidate}`;
  }

  const url = (() => {
    try {
      return new URL(candidate);
    } catch (error) {
      throw new Error(`Invalid proxy address "${raw}": ${error.message}`);
    }
  })();
  const protocol = url.protocol.replace(":", "").toLowerCase();
  if (!SUPPORTED_PROTOCOLS.has(protocol)) {
    throw new Error(`Unsupported proxy protocol "${protocol}".`);
  }

  const host = stripBrackets(url.hostname).toLowerCase();
  if (!host) throw new Error(`Proxy address has no host: ${raw}`);

  // WHATWG URL drops default ports (80/443), so the port is read from the
  // authority instead of `url.port`. A proxy without an explicit port is
  // ambiguous and rejected rather than guessed.
  const portMatch = AUTHORITY_WITH_PORT.exec(candidate);
  const port = portMatch ? Number(portMatch[1]) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Proxy address has no valid port: ${raw}`);
  }

  const proxy = { protocol, host, port };
  if (url.username) proxy.username = decodeURIComponent(url.username);
  if (url.password) proxy.password = decodeURIComponent(url.password);
  proxy.id = proxyId(proxy);
  return proxy;
}

function proxyId(proxy) {
  return `${proxy.protocol}://${formatHostForUrl(proxy.host)}:${proxy.port}`;
}

/** Playwright-compatible server string; never contains credentials. */
function proxyServer(proxy) {
  return `${proxy.protocol}://${formatHostForUrl(proxy.host)}:${proxy.port}`;
}

function splitHostPort(value) {
  const raw = value.trim();
  if (!raw) return null;

  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end === -1) return null;
    const host = raw.slice(0, end + 1);
    const rest = raw.slice(end + 1);
    if (!rest.startsWith(":")) return null;
    return { host, port: rest.slice(1) };
  }

  const first = raw.indexOf(":");
  const last = raw.lastIndexOf(":");
  if (first === -1) return null;
  if (first !== last) {
    // Bare IPv6 with a trailing port.
    return { host: raw.slice(0, last), port: raw.slice(last + 1) };
  }

  return { host: raw.slice(0, first), port: raw.slice(first + 1) };
}

function entryToProxy(entry, { defaultProtocol = "http" } = {}) {
  const { proxy, protocol, ip, port, host } = entry;

  if (typeof entry === "string") {
    return parseProxyUrl(entry, { defaultProtocol });
  }

  if (proxy || (protocol && (ip || host) && port)) {
    return parseProxyUrl(proxy || `${protocol}://${ip || host}:${port}`, {
      defaultProtocol,
    });
  }

  return null;
}

/**
 * `proxifly-json` is the geolocation-rich feed from proxifly/free-proxy-list;
 * `lines` covers the classic `ip:port` / `scheme://ip:port` text feeds.
 */
function parseProxyList(text, options = {}) {
  const { format = "lines", defaultProtocol = "http", source = "" } = options;
  const proxies = [];
  let skipped = 0;

  const push = (entry, country) => {
    try {
      const proxy = entryToProxy(entry, { defaultProtocol });
      if (!proxy) {
        skipped += 1;
        return;
      }
      proxy.country = normalizeProxyCountry(country);
      proxy.source = source;
      proxies.push(proxy);
    } catch {
      skipped += 1;
    }
  };

  if (format === "proxifly-json") {
    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new Error(`Proxy source ${source} returned invalid JSON: ${error.message}`);
    }

    if (!Array.isArray(data)) {
      throw new Error(`Proxy source ${source} did not return an array.`);
    }

    for (const entry of data) {
      if (typeof entry === "string") {
        push(entry);
        continue;
      }
      push(entry, entry.geolocation && entry.geolocation.country);
    }

    return { proxies, skipped };
  }

  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;

    const withoutComment = trimmed.split(/\s+/)[0];
    const [address, country] = withoutComment.split(",");
    push(address, country);
  }

  return { proxies, skipped };
}

/** Dedupe by protocol/host/port, preferring entries that carry a country. */
function dedupeProxies(proxies) {
  const byId = new Map();

  for (const proxy of proxies) {
    const existing = byId.get(proxy.id);
    if (!existing) {
      byId.set(proxy.id, proxy);
      continue;
    }

    if (!existing.country && proxy.country) {
      byId.set(proxy.id, { ...existing, country: proxy.country });
    }
  }

  return [...byId.values()];
}

module.exports = {
  dedupeProxies,
  parseProxyList,
  parseProxyUrl,
  proxyServer,
  splitHostPort,
};
