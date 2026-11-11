const assert = require("node:assert/strict");
const test = require("node:test");
const { GluetunClient } = require("../src/egress/gluetun");

function createControl({ allowedCountries, publicIp = "198.51.100.9" } = {}) {
  const calls = [];

  const fetchImpl = async (url, init = {}) => {
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body, headers: init.headers });

    if (url.endsWith("/v1/vpn/settings") && method === "PUT") {
      const name = body.provider.server_selection.countries[0];
      if (allowedCountries && !allowedCountries.includes(name)) {
        return new Response(
          "provider settings: server selection: country specified is not valid: " +
            `none of ${name} is one of the choices available ${allowedCountries.join(", ")}`,
          { status: 400 }
        );
      }
      return new Response("restarting", { status: 200 });
    }

    if (url.endsWith("/v1/vpn/status")) {
      return new Response(JSON.stringify({ status: "running" }), { status: 200 });
    }

    if (url.endsWith("/v1/publicip/ip")) {
      return new Response(JSON.stringify({ public_ip: publicIp }), { status: 200 });
    }

    return new Response("not found", { status: 404 });
  };

  return { calls, fetchImpl };
}

test("sends provider country names, not ISO codes", async () => {
  const control = createControl({ allowedCountries: ["Germany", "France"] });
  const client = new GluetunClient({
    baseUrl: "http://gluetun:8000",
    fetchImpl: control.fetchImpl,
  });

  const result = await client.setServerSelection({ countries: ["DE"] });

  assert.deepEqual(result.selection.countries, ["Germany"]);
  assert.equal(result.outcome, "restarting");
  assert.equal(control.calls.length, 1);
  assert.deepEqual(
    control.calls[0].body.provider.server_selection.countries,
    ["Germany"]
  );
});

test("retries once with the provider spelling from the validation error", async () => {
  // Our alias map says "Czech Republic"; this provider only knows "Czechia".
  const control = createControl({ allowedCountries: ["Czechia"] });
  const client = new GluetunClient({
    baseUrl: "http://gluetun:8000",
    fetchImpl: control.fetchImpl,
  });

  const result = await client.setServerSelection({ countries: ["CZ"] });

  assert.deepEqual(result.selection.countries, ["Czechia"]);
  assert.equal(control.calls.length, 2);
  assert.deepEqual(
    control.calls[0].body.provider.server_selection.countries,
    ["Czech Republic"]
  );
  assert.deepEqual(
    control.calls[1].body.provider.server_selection.countries,
    ["Czechia"]
  );
  assert.equal(client.countryNameOverrides.get("CZ"), "Czechia");

  // The learned spelling is reused instead of failing the same way again.
  await client.setServerSelection({ countries: ["CZ"] });
  assert.equal(control.calls.length, 3);
  assert.deepEqual(
    control.calls[2].body.provider.server_selection.countries,
    ["Czechia"]
  );
});

test("reports a country that the provider does not offer", async () => {
  const control = createControl({ allowedCountries: ["France"] });
  const client = new GluetunClient({
    baseUrl: "http://gluetun:8000",
    fetchImpl: control.fetchImpl,
  });

  await assert.rejects(
    client.setServerSelection({ countries: ["DE"] }),
    /does not offer a country/
  );
});

test("reads status and public IP with basic auth", async () => {
  const control = createControl({ allowedCountries: [] });
  const client = new GluetunClient({
    baseUrl: "http://gluetun:8000/",
    username: "monitor",
    password: "secret",
    fetchImpl: control.fetchImpl,
  });

  assert.equal(await client.getStatus(), "running");
  assert.equal(await client.getPublicIp(), "198.51.100.9");

  const expected = `Basic ${Buffer.from("monitor:secret").toString("base64")}`;
  assert.equal(control.calls[0].headers.Authorization, expected);
});

test("surfaces unrelated control server errors unchanged", async () => {
  const client = new GluetunClient({
    baseUrl: "http://gluetun:8000",
    fetchImpl: async () => new Response("boom", { status: 500 }),
  });

  await assert.rejects(
    client.setServerSelection({ countries: ["DE"] }),
    /failed \(500\)/
  );
});
