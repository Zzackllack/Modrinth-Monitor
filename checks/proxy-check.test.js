const assert = require("node:assert/strict");
const test = require("node:test");
const {
  checkProxy,
  httpGetThroughProxy,
  openTunnel,
} = require("../src/egress/proxy-check");
const {
  findClosedPort,
  startHttpProxy,
  startOriginServer,
  startRejectingProxy,
  startSilentProxy,
  startSocks5Proxy,
} = require("./helpers/proxy-fixtures");

test("accepts a working HTTP CONNECT proxy and parses the exit IP", async (t) => {
  const origin = await startOriginServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("203.0.113.7\n");
  });
  const proxy = await startHttpProxy();
  t.after(() => origin.close());
  t.after(() => proxy.close());

  const result = await checkProxy(
    { protocol: "http", host: "127.0.0.1", port: proxy.port },
    {
      checkUrl: `http://127.0.0.1:${origin.port}/ip`,
      timeoutMs: 4_000,
    }
  );

  assert.equal(result.ok, true, result.error);
  assert.equal(result.ip, "203.0.113.7");
  assert.equal(proxy.stats.connects, 1);
});

test("decodes chunked responses through the tunnel", async (t) => {
  const origin = await startOriginServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write('{"ip":');
    setTimeout(() => {
      response.end('"198.51.100.4"}');
    }, 10);
  });
  const proxy = await startHttpProxy();
  t.after(() => origin.close());
  t.after(() => proxy.close());

  const response = await httpGetThroughProxy(
    { protocol: "http", host: "127.0.0.1", port: proxy.port },
    `http://127.0.0.1:${origin.port}/json`
  );

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body.toString("utf8")), {
    ip: "198.51.100.4",
  });
});

test("rejects a proxy that refuses CONNECT", async (t) => {
  const proxy = await startRejectingProxy();
  t.after(() => proxy.close());

  const result = await checkProxy(
    { protocol: "http", host: "127.0.0.1", port: proxy.port },
    { checkUrl: "http://example.test/", timeoutMs: 2_000 }
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /403|refused CONNECT/i);
});

test("rejects a dead proxy port", async () => {
  const port = await findClosedPort();
  const result = await checkProxy(
    { protocol: "http", host: "127.0.0.1", port },
    { checkUrl: "http://example.test/", timeoutMs: 1_500 }
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /ECONNREFUSED|connect/i);
});

test("times out on a proxy that never answers", async (t) => {
  const proxy = await startSilentProxy();
  t.after(() => proxy.close());

  const startedAt = Date.now();
  const result = await checkProxy(
    { protocol: "http", host: "127.0.0.1", port: proxy.port },
    { checkUrl: "http://example.test/", timeoutMs: 400 }
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /timed out/i);
  assert.ok(Date.now() - startedAt < 5_000);
});

test("tunnels through a SOCKS5 proxy", async (t) => {
  const origin = await startOriginServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("192.0.2.55\n");
  });
  const proxy = await startSocks5Proxy();
  t.after(() => origin.close());
  t.after(() => proxy.close());

  const result = await checkProxy(
    { protocol: "socks5", host: "127.0.0.1", port: proxy.port },
    {
      checkUrl: `http://127.0.0.1:${origin.port}/ip`,
      timeoutMs: 4_000,
    }
  );

  assert.equal(result.ok, true, result.error);
  assert.equal(result.ip, "192.0.2.55");
  assert.equal(proxy.stats.connects, 1);
});

test("reports SOCKS5 proxies that reject all auth methods", async (t) => {
  const proxy = await startSocks5Proxy({ rejectMethods: true });
  t.after(() => proxy.close());

  const result = await checkProxy(
    { protocol: "socks5", host: "127.0.0.1", port: proxy.port },
    { checkUrl: "http://example.test/", timeoutMs: 2_000 }
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /authentication methods|closed the connection/i);
});

test("supports IPv6 proxy addresses when the host has IPv6", async (t) => {
  const proxy = await startHttpProxy();
  t.after(() => proxy.close());

  // The fixture listens on IPv4 only; a second proxy bound to ::1 proves the
  // address handling end to end.
  const net = require("node:net");
  const http = require("node:http");
  const { once } = require("node:events");

  const server = http.createServer();
  server.on("connect", (request, clientSocket) => {
    clientSocket.end("HTTP/1.1 503 Unavailable\r\n\r\n");
  });

  try {
    server.listen(0, "::1");
    await once(server, "listening");
  } catch {
    server.close();
    t.skip("IPv6 loopback is not available on this host");
    return;
  }
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const tunnel = await openTunnel(
    { protocol: "http", host: "::1", port: server.address().port },
    { host: "127.0.0.1", port: proxy.port },
    { timeoutMs: 2_000 }
  ).catch((error) => error);

  assert.ok(tunnel instanceof Error, "expected CONNECT refusal");
  assert.match(tunnel.message, /503|refused CONNECT/i);
});
