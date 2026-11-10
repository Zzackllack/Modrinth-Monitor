const assert = require("node:assert/strict");
const test = require("node:test");
const {
  parseDownloadPercentage,
  shouldDownload,
} = require("../src/download-policy");

test("defaults to downloading on every visit", () => {
  assert.equal(parseDownloadPercentage(), 100);
});

test("accepts endpoints and decimal percentages", () => {
  for (const value of ["0", "30", "12.5", "100", " 50 "]) {
    assert.equal(parseDownloadPercentage(value), Number(value));
  }
});

test("rejects invalid percentages instead of silently changing the rate", () => {
  const invalidValues = [
    "", " ", "abc", "30%", "30junk", "NaN", "Infinity", "-1", "100.1",
  ];
  for (const value of invalidValues) {
    assert.throws(() => parseDownloadPercentage(value), /DOWNLOAD_PERCENTAGE/);
  }
});

test("0 never downloads and 100 always downloads", () => {
  for (const sample of [0, 0.3, 0.999999]) {
    assert.equal(shouldDownload(0, () => sample), false);
    assert.equal(shouldDownload(100, () => sample), true);
  }
});

test("selects downloads below the configured percentage", () => {
  assert.equal(shouldDownload(30, () => 0.2999), true);
  assert.equal(shouldDownload(30, () => 0.3), false);
  assert.equal(shouldDownload(12.5, () => 0.1249), true);
  assert.equal(shouldDownload(12.5, () => 0.125), false);
});
