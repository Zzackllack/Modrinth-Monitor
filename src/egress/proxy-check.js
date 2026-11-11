const net = require("node:net");
const tls = require("node:tls");
const { formatHostForUrl, isIPv6, stripBrackets } = require("../net/ip");

const MAX_HEADER_BYTES = 64 * 1024;
const DEFAULT_CHECK_URL = "https://api.ipify.org/";
const DEFAULT_TIMEOUT_MS = 6_000;

/**
 * Buffered reader for a proxy connection. Reads are sequential: the tunnel
 * handshakes are strictly request/response, so no concurrent reads are needed.
 */
class SocketReader {
  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.buffer = Buffer.alloc(0);
    this.pending = null;
    this.timer = null;
    this.failure = null;
    this.ended = false;

    this.onData = (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > MAX_HEADER_BYTES * 16) {
        this.fail(new Error("Proxy response exceeded the buffer limit."));
        return;
      }
      this.tryResolve();
    };
    this.onEnd = () => {
      this.ended = true;
      this.tryResolve();
    };
    this.onError = (error) => {
      this.failure = error;
      this.tryResolve();
    };

    socket.on("data", this.onData);
    socket.once("end", this.onEnd);
    socket.once("close", this.onEnd);
    socket.once("error", this.onError);
  }

  read(predicate, description) {
    if (this.pending) {
      return Promise.reject(new Error("Concurrent reads on a proxy socket are not supported."));
    }

    return new Promise((resolve, reject) => {
      this.pending = { predicate, resolve, reject, description };
      this.timer = setTimeout(() => {
        this.fail(new Error(`Proxy timed out waiting for ${description}.`));
      }, this.timeoutMs);
      this.timer.unref?.();
      this.tryResolve();
    });
  }

  tryResolve() {
    const pending = this.pending;
    if (!pending) return;

    if (this.failure) {
      this.fail(this.failure);
      return;
    }

    let result;
    try {
      result = pending.predicate(this.buffer, this.ended);
    } catch (error) {
      this.fail(error);
      return;
    }

    if (result) {
      this.pending = null;
      clearTimeout(this.timer);
      this.timer = null;
      pending.resolve(result);
      return;
    }

    if (this.ended) {
      this.fail(new Error(`Proxy closed the connection while waiting for ${pending.description}.`));
    }
  }

  fail(error) {
    const pending = this.pending;
    if (!pending) {
      this.failure = this.failure || error;
      return;
    }

    this.pending = null;
    clearTimeout(this.timer);
    this.timer = null;
    pending.reject(error);
  }

  async readExact(length, description) {
    const chunk = await this.read(
      (buffer) => (buffer.length >= length ? buffer.subarray(0, length) : null),
      description
    );
    this.buffer = this.buffer.subarray(length);
    return chunk;
  }

  async readHeaders(description) {
    const result = await this.read((buffer) => {
      const index = buffer.indexOf("\r\n\r\n");
      if (index === -1) return null;
      return {
        head: buffer.subarray(0, index).toString("latin1"),
        length: index + 4,
      };
    }, description);

    this.buffer = this.buffer.subarray(result.length);
    return result.head;
  }

  async readUntil(predicate, description) {
    return this.read(predicate, description);
  }

  /** Stops owning the socket so it can be wrapped in TLS or handed to a caller. */
  detach() {
    this.socket.off("data", this.onData);
    this.socket.off("end", this.onEnd);
    this.socket.off("close", this.onEnd);
    this.socket.off("error", this.onError);
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length) {
      this.socket.pause();
      this.socket.unshift(this.buffer);
      this.buffer = Buffer.alloc(0);
    } else {
      this.socket.pause();
    }
    this.pending = null;
  }

  destroy() {
    this.detach();
    this.socket.destroy();
  }
}

function connectSocket({ host, port, timeoutMs, useTls }) {
  return new Promise((resolve, reject) => {
    let settled = false;

    // Free "https" proxies frequently use self-signed certificates. The hop to
    // the proxy is not what protects the payload; the payload is still wrapped
    // in TLS to the destination.
    const socket = useTls
      ? tls.connect({
          host,
          port,
          servername: net.isIP(host) ? undefined : host,
          rejectUnauthorized: false,
        })
      : net.connect({ host, port });

    const timer = setTimeout(() => {
      finish(new Error(`Proxy connect timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    timer.unref?.();

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        socket.destroy();
        reject(error);
        return;
      }
      socket.setNoDelay?.(true);
      resolve(socket);
    }

    socket.once(useTls ? "secureConnect" : "connect", () => finish());
    socket.once("error", finish);
  });
}

function parseHead(head) {
  const [startLine, ...headerLines] = head.split("\r\n");
  const headers = {};
  for (const line of headerLines) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return { startLine, headers };
}

function statusCode(startLine) {
  const match = /^[A-Za-z]+\/\d(?:\.\d)?\s+(\d{3})/.exec(startLine || "");
  return match ? Number(match[1]) : undefined;
}

function portBuffer(port) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(port, 0);
  return buffer;
}

function ipv4ToBuffer(address) {
  return Buffer.from(address.split(".").map((part) => Number(part)));
}

function ipv6ToBuffer(address) {
  const [head, tail] = stripBrackets(address).split("::");
  const parsePart = (part) => (part ? part.split(":") : []);
  const left = parsePart(head);
  const right = parsePart(tail);
  const missing = tail === undefined ? 0 : 8 - left.length - right.length;
  const groups = [...left, ...Array(Math.max(missing, 0)).fill("0"), ...right];

  if (groups.length !== 8) {
    throw new Error(`Invalid IPv6 address: ${address}`);
  }

  const buffer = Buffer.alloc(16);
  groups.forEach((group, index) => {
    buffer.writeUInt16BE(parseInt(group || "0", 16), index * 2);
  });
  return buffer;
}

function socksAddress(host) {
  const bare = stripBrackets(host);
  if (net.isIPv4(bare)) {
    return { atyp: 0x01, address: ipv4ToBuffer(bare), name: bare };
  }
  if (isIPv6(bare)) {
    return { atyp: 0x04, address: ipv6ToBuffer(bare), name: bare };
  }
  const name = Buffer.from(bare);
  if (name.length > 255) throw new Error("SOCKS5 target hostname is too long.");
  return { atyp: 0x03, address: Buffer.concat([Buffer.from([name.length]), name]), name: bare };
}

async function httpConnect(proxy, target, timeoutMs) {
  const socket = await connectSocket({
    host: proxy.host,
    port: proxy.port,
    timeoutMs,
    useTls: proxy.protocol === "https",
  });

  const authority = `${formatHostForUrl(target.host)}:${target.port}`;
  const lines = [
    `CONNECT ${authority} HTTP/1.1`,
    `Host: ${authority}`,
    "Proxy-Connection: keep-alive",
  ];

  if (proxy.username) {
    const credentials = Buffer.from(
      `${proxy.username}:${proxy.password || ""}`
    ).toString("base64");
    lines.push(`Proxy-Authorization: Basic ${credentials}`);
  }
  lines.push("", "");

  socket.write(lines.join("\r\n"));
  const reader = new SocketReader(socket, timeoutMs);

  try {
    const { startLine } = parseHead(await reader.readHeaders("CONNECT response"));
    const status = statusCode(startLine);
    if (status !== 200) {
      throw new Error(`Proxy refused CONNECT with "${startLine || "no response"}".`);
    }
    reader.detach();
    return socket;
  } catch (error) {
    reader.destroy();
    throw error;
  }
}

async function socks5Connect(proxy, target, timeoutMs) {
  const socket = await connectSocket({
    host: proxy.host,
    port: proxy.port,
    timeoutMs,
    useTls: false,
  });
  const reader = new SocketReader(socket, timeoutMs);
  const wantsAuth = Boolean(proxy.username);

  try {
    socket.write(
      Buffer.from([0x05, wantsAuth ? 0x02 : 0x01, wantsAuth ? 0x02 : 0x00])
    );

    const [version, method] = await reader.readExact(2, "SOCKS5 method");
    if (version !== 0x05) throw new Error(`Not a SOCKS5 proxy (version ${version}).`);

    if (method === 0x02) {
      if (!wantsAuth) {
        throw new Error("SOCKS5 proxy requires credentials that are not configured.");
      }
      const user = Buffer.from(proxy.username);
      const pass = Buffer.from(proxy.password || "");
      socket.write(
        Buffer.concat([
          Buffer.from([0x01, user.length]),
          user,
          Buffer.from([pass.length]),
          pass,
        ])
      );
      const [authVersion, authStatus] = await reader.readExact(2, "SOCKS5 auth reply");
      if (authVersion !== 0x01 || authStatus !== 0x00) {
        throw new Error(`SOCKS5 authentication failed (status ${authStatus}).`);
      }
    } else if (method === 0xff) {
      throw new Error("SOCKS5 proxy rejected all authentication methods.");
    } else if (method !== 0x00) {
      throw new Error(`SOCKS5 proxy selected unsupported method ${method}.`);
    }

    const address = socksAddress(target.host);
    socket.write(
      Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, address.atyp]),
        address.address,
        portBuffer(target.port),
      ])
    );

    const reply = await reader.readExact(4, "SOCKS5 connect reply");
    if (reply[0] !== 0x05 || reply[1] !== 0x00) {
      throw new Error(`SOCKS5 connect failed (code ${reply[1]}).`);
    }

    const atyp = reply[3];
    let remaining;
    if (atyp === 0x01) {
      remaining = 4;
    } else if (atyp === 0x04) {
      remaining = 16;
    } else if (atyp === 0x03) {
      const [length] = await reader.readExact(1, "SOCKS5 bound address length");
      remaining = length;
    } else {
      throw new Error(`SOCKS5 reply used unknown address type ${atyp}.`);
    }

    await reader.readExact(remaining + 2, "SOCKS5 bound address");
    reader.detach();
    return socket;
  } catch (error) {
    reader.destroy();
    throw error;
  }
}

async function socks4Connect(proxy, target, timeoutMs) {
  const socket = await connectSocket({
    host: proxy.host,
    port: proxy.port,
    timeoutMs,
    useTls: false,
  });
  const reader = new SocketReader(socket, timeoutMs);
  const bare = stripBrackets(target.host);
  const ipv4 = net.isIPv4(bare);
  const parts = [
    Buffer.from([0x04, 0x01]),
    portBuffer(target.port),
    ipv4 ? ipv4ToBuffer(bare) : Buffer.from([0, 0, 0, 1]),
    Buffer.from(proxy.username || ""),
    Buffer.from([0x00]),
  ];

  if (!ipv4) {
    // SOCKS4a: let the proxy resolve the hostname.
    parts.push(Buffer.from(`${bare}\0`));
  }

  try {
    socket.write(Buffer.concat(parts));
    const reply = await reader.readExact(8, "SOCKS4 reply");
    if (reply[1] !== 0x5a) {
      throw new Error(`SOCKS4 connect failed (code 0x${reply[1].toString(16)}).`);
    }
    reader.detach();
    return socket;
  } catch (error) {
    reader.destroy();
    throw error;
  }
}

/** Opens a raw tunnel to `target` through `proxy`. */
async function openTunnel(proxy, target, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  switch (proxy.protocol) {
    case "http":
    case "https":
      return httpConnect(proxy, target, timeoutMs);
    case "socks4":
    case "socks4a":
      return socks4Connect(proxy, target, timeoutMs);
    case "socks5":
    case "socks5h":
      return socks5Connect(proxy, target, timeoutMs);
    default:
      throw new Error(`Unsupported proxy protocol "${proxy.protocol}".`);
  }
}

function upgradeToTls(socket, servername, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const tlsSocket = tls.connect({
      socket,
      servername: net.isIP(servername) ? undefined : servername,
      rejectUnauthorized: true,
    });

    const timer = setTimeout(() => {
      finish(new Error(`TLS handshake timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    timer.unref?.();

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        tlsSocket.destroy();
        reject(error);
      } else {
        resolve(tlsSocket);
      }
    }

    tlsSocket.once("secureConnect", () => finish());
    tlsSocket.once("error", finish);
    socket.resume();
  });
}

function chunkedBodyComplete(buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf("\r\n", offset);
    if (lineEnd === -1) return false;
    const size = Number.parseInt(
      buffer.subarray(offset, lineEnd).toString("latin1").split(";")[0].trim(),
      16
    );
    if (!Number.isFinite(size)) return false;
    if (size === 0) return true;
    offset = lineEnd + 2 + size + 2;
    if (offset > buffer.length) return false;
  }
  return false;
}

function decodeChunked(buffer) {
  const parts = [];
  let offset = 0;

  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf("\r\n", offset);
    if (lineEnd === -1) break;
    const size = Number.parseInt(
      buffer.subarray(offset, lineEnd).toString("latin1").split(";")[0].trim(),
      16
    );
    if (!Number.isFinite(size) || size <= 0) break;
    const start = lineEnd + 2;
    const end = Math.min(start + size, buffer.length);
    parts.push(buffer.subarray(start, end));
    offset = end + 2;
  }

  return Buffer.concat(parts);
}

async function readResponseBody(reader, headers, maxBytes) {
  if (/chunked/i.test(headers["transfer-encoding"] || "")) {
    const raw = await reader.readUntil((buffer, ended) => {
      if (chunkedBodyComplete(buffer)) return buffer;
      if (buffer.length >= maxBytes) return buffer.subarray(0, maxBytes);
      return ended ? buffer : null;
    }, "chunked response body");
    return decodeChunked(raw);
  }

  const length = Number(headers["content-length"]);
  if (Number.isFinite(length) && length >= 0) {
    return reader.readExact(Math.min(length, maxBytes), "response body");
  }

  return reader.readUntil((buffer, ended) => {
    if (ended) return buffer;
    return buffer.length >= maxBytes ? buffer.subarray(0, maxBytes) : null;
  }, "response body");
}

/**
 * Minimal HTTP/1.1 GET through a proxy tunnel. Used for health checks and
 * route probes, so it deliberately avoids an HTTP agent and its connection
 * reuse: every call should prove that this specific proxy works right now.
 */
async function httpGetThroughProxy(
  proxy,
  urlString,
  { timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = 64 * 1024, headers = {} } = {}
) {
  const url = new URL(urlString);
  const targetPort = url.port
    ? Number(url.port)
    : url.protocol === "https:"
      ? 443
      : 80;
  const targetHost = stripBrackets(url.hostname);

  let socket = await openTunnel(
    proxy,
    { host: targetHost, port: targetPort },
    { timeoutMs }
  );

  try {
    if (url.protocol === "https:") {
      socket = await upgradeToTls(socket, targetHost, timeoutMs);
    } else {
      // `SocketReader.detach()` pauses the socket; reads need it flowing again.
      socket.resume();
    }

    const requestHeaders = {
      Host: url.host,
      "User-Agent": "modrinth-monitor/1.0 (+egress-check)",
      Accept: "*/*",
      Connection: "close",
      ...headers,
    };

    const lines = [`GET ${url.pathname || "/"}${url.search || ""} HTTP/1.1`];
    for (const [name, value] of Object.entries(requestHeaders)) {
      lines.push(`${name}: ${value}`);
    }
    lines.push("", "");
    socket.write(lines.join("\r\n"));

    const reader = new SocketReader(socket, timeoutMs);
    try {
      const { startLine, headers: responseHeaders } = parseHead(
        await reader.readHeaders("HTTP response headers")
      );
      const status = statusCode(startLine);
      if (!status) throw new Error(`Malformed HTTP status line: ${startLine}`);

      const body = await readResponseBody(reader, responseHeaders, maxBytes);
      return { status, headers: responseHeaders, body, startLine };
    } catch (error) {
      reader.destroy();
      throw error;
    }
  } finally {
    if (!socket.destroyed) socket.destroy();
  }
}

function normalizeIp(raw) {
  const value = String(raw || "").trim().split(/\s+/)[0];
  return net.isIP(value) ? value : undefined;
}

/**
 * Full treadmill check: tunnel + TLS to a public endpoint + parse a real HTTP
 * response. A TCP connect alone says nothing about whether a proxy forwards.
 */
async function checkProxy(proxy, options = {}) {
  const {
    checkUrl = DEFAULT_CHECK_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = 4 * 1024,
  } = options;
  const startedAt = Date.now();

  try {
    const response = await httpGetThroughProxy(proxy, checkUrl, {
      timeoutMs,
      maxBytes,
    });

    if (response.status < 200 || response.status >= 400) {
      throw new Error(`Health check returned HTTP ${response.status}.`);
    }

    const bodyText = response.body.toString("utf8");
    let ip = normalizeIp(bodyText);

    if (!ip) {
      try {
        const parsed = JSON.parse(bodyText);
        ip = normalizeIp(parsed.ip || parsed.query || parsed.address);
      } catch {
        // Not JSON; the endpoint may be a plain-text IP service.
      }
    }

    return {
      ok: true,
      ip,
      latencyMs: Date.now() - startedAt,
      status: response.status,
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || String(error),
      latencyMs: Date.now() - startedAt,
    };
  }
}

async function probeThroughProxy(proxy, url, options = {}) {
  const startedAt = Date.now();
  const response = await httpGetThroughProxy(proxy, url, {
    timeoutMs: options.timeoutMs || 20_000,
    maxBytes: options.maxBytes || 256 * 1024,
  });
  return {
    status: response.status,
    bytes: response.body.length,
    latencyMs: Date.now() - startedAt,
  };
}

module.exports = {
  DEFAULT_CHECK_URL,
  checkProxy,
  httpGetThroughProxy,
  openTunnel,
  probeThroughProxy,
};
