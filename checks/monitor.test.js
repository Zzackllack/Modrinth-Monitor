const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { startHttpProxy } = require("./helpers/proxy-fixtures");

function runMonitor(env, outputDir) {
  return new Promise((resolve, reject) => {
    const inherited = { ...process.env };
    for (const key of Object.keys(inherited)) {
      if (key.startsWith("MONITOR_PROXY_") || key.startsWith("EGRESS_")) {
        delete inherited[key];
      }
    }

    const child = spawn(
      process.execPath,
      [require.resolve("@playwright/test/cli"), "test", "--output", outputDir],
      { env: { ...inherited, ...env }, timeout: 120_000 }
    );
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

test("monitor visits the page with and without a download", { timeout: 180_000 }, async (t) => {
  const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), "modrinth-monitor-"));
  t.after(() => fs.rm(temporaryDir, { recursive: true, force: true }));
  const payload = "local fixture modpack";
  let pageVisits = 0;
  let downloadRequests = 0;
  const server = http.createServer((request, response) => {
    if (request.url === "/fixture.mrpack") {
      downloadRequests++;
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="fixture.mrpack"',
      });
      response.end(payload);
      return;
    }
    if (request.url !== "/") {
      response.writeHead(404).end();
      return;
    }
    pageVisits++;
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(`<!doctype html><title>Local modpack fixture</title>
      <button onclick="this.remove()">Accept cookies</button>
      <button onclick="document.querySelector('a').hidden = false">Download</button>
      <a href="/fixture.mrpack" hidden>Modpack file</a>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const modrinthUrl = `http://127.0.0.1:${server.address().port}/`;

  for (const percentage of ["0", "100"]) {
    await t.test(`DOWNLOAD_PERCENTAGE=${percentage}`, async () => {
      pageVisits = 0;
      downloadRequests = 0;
      const downloadDir = path.join(temporaryDir, percentage, "downloads");
      const result = await runMonitor({
        MODRINTH_URL: modrinthUrl,
        DOWNLOAD_DIR: downloadDir,
        DOWNLOAD_PERCENTAGE: percentage,
      }, path.join(temporaryDir, percentage, "results"));

      assert.equal(result.code, 0, result.output);
      assert.equal(pageVisits, 1, result.output);
      assert.match(result.output, /cookies.accepted/);
      assert.match(result.output, /download.trigger.visible/);
      assert.equal((result.output.match(/visit.mode.selected/g) || []).length, 1);
      if (percentage === "0") {
        assert.equal(downloadRequests, 0);
        assert.match(result.output, /download.skipped/);
        assert.doesNotMatch(result.output, /download.trigger.clicked|download.saved/);
        await assert.rejects(fs.stat(downloadDir), { code: "ENOENT" });
      } else {
        assert.equal(downloadRequests, 1);
        assert.match(result.output, /download.validated/);
        assert.doesNotMatch(result.output, /download.skipped/);
        const downloadedFile = path.join(downloadDir, "fixture.mrpack");
        assert.equal(await fs.readFile(downloadedFile, "utf8"), payload);
      }
    });
  }

  await t.test("invalid percentage fails before visiting", async () => {
    pageVisits = 0;
    downloadRequests = 0;
    const result = await runMonitor({
      MODRINTH_URL: modrinthUrl,
      DOWNLOAD_PERCENTAGE: "101",
    }, path.join(temporaryDir, "invalid", "results"));
    assert.notEqual(result.code, 0);
    assert.match(result.output, /DOWNLOAD_PERCENTAGE must be a number between 0 and 100/);
    assert.equal(pageVisits, 0);
    assert.equal(downloadRequests, 0);
  });

  await t.test("routes the visit through the configured proxy", async () => {
    pageVisits = 0;
    downloadRequests = 0;
    const proxy = await startHttpProxy();
    t.after(() => proxy.close());

    const result = await runMonitor({
      MODRINTH_URL: modrinthUrl,
      DOWNLOAD_DIR: path.join(temporaryDir, "proxy", "downloads"),
      DOWNLOAD_PERCENTAGE: "0",
      MONITOR_PROXY_SERVER: `http://127.0.0.1:${proxy.port}`,
      EGRESS_KIND: "proxy",
      EGRESS_BUCKET: "US",
      EGRESS_COUNTRY: "US",
      EGRESS_PROXY_ID: "http://127.0.0.1:1",
      EGRESS_ATTEMPT: "1",
    }, path.join(temporaryDir, "proxy", "results"));

    assert.equal(result.code, 0, result.output);
    assert.equal(pageVisits, 1, result.output);
    assert.ok(
      proxy.stats.requests + proxy.stats.connects > 0,
      `expected traffic through the proxy, saw ${JSON.stringify(proxy.stats)}`
    );
    assert.match(result.output, /"egressKind":"proxy"/);
    assert.match(result.output, /"egressCountry":"US"/);
  });
});
