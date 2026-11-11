const assert = require("node:assert/strict");
const test = require("node:test");
const {
  dedupeProxies,
  parseProxyList,
  parseProxyUrl,
  proxyServer,
  splitHostPort,
} = require("../src/egress/proxy-model");

test("parses host:port, schemes, credentials and IPv6", () => {
  assert.deepEqual(
    { ...parseProxyUrl("1.2.3.4:8080"), id: undefined },
    { protocol: "http", host: "1.2.3.4", port: 8080, id: undefined }
  );

  const authenticated = parseProxyUrl("socks5://user:pa%40ss@proxy.example:1080");
  assert.equal(authenticated.protocol, "socks5");
  assert.equal(authenticated.username, "user");
  assert.equal(authenticated.password, "pa@ss");
  assert.equal(authenticated.id, "socks5://proxy.example:1080");

  const ipv6 = parseProxyUrl("[2001:db8::1]:3128");
  assert.equal(ipv6.host, "2001:db8::1");
  assert.equal(ipv6.id, "http://[2001:db8::1]:3128");
  assert.equal(proxyServer(ipv6), "http://[2001:db8::1]:3128");

  assert.equal(parseProxyUrl("HTTPS://Proxy.Example:443").protocol, "https");
});

test("rejects malformed proxy addresses", () => {
  for (const value of ["", "1.2.3.4", "ftp://1.2.3.4:21", "1.2.3.4:0", "1.2.3.4:70000"]) {
    assert.throws(() => parseProxyUrl(value), /proxy|port|protocol|Empty/i);
  }
});

test("splits bracketed and bare IPv6 host:port forms", () => {
  assert.deepEqual(splitHostPort("[::1]:8080"), { host: "[::1]", port: "8080" });
  assert.deepEqual(splitHostPort("2001:db8::1:8080"), {
    host: "2001:db8::1",
    port: "8080",
  });
  assert.deepEqual(splitHostPort("host:1"), { host: "host", port: "1" });
  assert.equal(splitHostPort("host"), null);
});

test("parses plain line lists with comments and country hints", () => {
  const text = [
    "# comment",
    "",
    "http://1.1.1.1:8080",
    "2.2.2.2:3128",
    "3.3.3.3:1080,US",
    "socks5://4.4.4.4:1080 # trailing",
    "5.5.5.5:notaport",
    "http://[2001:db8::5]:8080",
  ].join("\n");

  const { proxies, skipped } = parseProxyList(text, { source: "test" });
  const ids = proxies.map((proxy) => proxy.id);

  assert.deepEqual(ids, [
    "http://1.1.1.1:8080",
    "http://2.2.2.2:3128",
    "http://3.3.3.3:1080",
    "socks5://4.4.4.4:1080",
    "http://[2001:db8::5]:8080",
  ]);
  assert.equal(skipped, 1);
  assert.equal(proxies[2].country, "US");
  assert.equal(proxies[0].source, "test");
});

test("parses the proxifly geolocation feed", () => {
  const payload = JSON.stringify([
    {
      proxy: "socks5://208.102.51.6:58208",
      protocol: "socks5",
      ip: "208.102.51.6",
      port: 58208,
      geolocation: { country: "US", city: "Alexandria" },
    },
    {
      proxy: "http://10.0.0.1:8080",
      protocol: "http",
      ip: "10.0.0.1",
      port: 8080,
      geolocation: null,
    },
    {
      proxy: "http://10.0.0.2:8080",
      protocol: "http",
      ip: "10.0.0.2",
      port: 8080,
      geolocation: { country: "ZZ" },
    },
  ]);

  const { proxies } = parseProxyList(payload, {
    format: "proxifly-json",
    source: "proxifly",
  });

  assert.equal(proxies.length, 3);
  assert.equal(proxies[0].country, "US");
  assert.equal(proxies[1].country, undefined);
  assert.equal(proxies[2].country, undefined);
});

test("rejects an invalid JSON feed loudly", () => {
  assert.throws(
    () => parseProxyList("not json", { format: "proxifly-json", source: "x" }),
    /invalid JSON/
  );
});

test("dedupes by protocol/host/port and keeps country metadata", () => {
  const proxies = dedupeProxies([
    parseProxyUrl("1.2.3.4:8080"),
    { ...parseProxyUrl("1.2.3.4:8080"), country: "DE" },
    parseProxyUrl("1.2.3.4:8081"),
  ]);

  assert.equal(proxies.length, 2);
  assert.equal(proxies[0].country, "DE");
});
