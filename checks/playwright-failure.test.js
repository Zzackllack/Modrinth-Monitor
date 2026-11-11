const assert = require("node:assert/strict");
const test = require("node:test");
const {
  summarizePlaywrightFailure,
} = require("../src/egress/playwright-failure");

const PROXY_CERT_FAILURE = `
Running 1 test using 1 worker

\u001b[31m  ✘  1 [modrinth-monitor] › tests/modrinth-download.spec.ts:26:7 › monitor (1.4s)\u001b[39m


  1) [modrinth-monitor] › tests/modrinth-download.spec.ts:26:7 › monitor

    Error: page.goto: net::ERR_PROXY_CERTIFICATE_INVALID at https://modrinth.com/modpack/winterlands

    Call log:
      - navigating to "https://modrinth.com/modpack/winterlands", waiting until "domcontentloaded"


  1 failed
`;

test("extracts the browser failure cause from Playwright output", () => {
  const summary = summarizePlaywrightFailure(PROXY_CERT_FAILURE);

  assert.match(summary, /ERR_PROXY_CERTIFICATE_INVALID/);
  assert.match(summary, /page\.goto/);
  assert.doesNotMatch(summary, /\u001b/);
  assert.ok(summary.length <= 400);
});

test("falls back to the last line when no known pattern matches", () => {
  const summary = summarizePlaywrightFailure("some output\nlast useful line");
  assert.equal(summary, "last useful line");
});

test("handles empty output", () => {
  assert.equal(summarizePlaywrightFailure(""), "");
  assert.equal(summarizePlaywrightFailure(undefined), "");
});
