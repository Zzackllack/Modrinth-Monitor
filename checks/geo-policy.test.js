const assert = require("node:assert/strict");
const test = require("node:test");
const {
  DEFAULT_OTHER_COUNTRIES,
  OTHER_BUCKET,
  chooseBucket,
  matchesBucket,
  normalizeBucket,
  parseCountryWeights,
  pickOtherCountry,
  preferredBuckets,
} = require("../src/net/geo");
const { planRoute } = require("../src/egress/route-planner");

function sequence(values) {
  let index = 0;
  return () => values[index++ % values.length];
}

test("default configuration splits traffic into three equal buckets", () => {
  const weights = parseCountryWeights();
  assert.deepEqual(
    weights.map((entry) => entry.bucket),
    ["US", "DE", OTHER_BUCKET]
  );

  for (const entry of weights) {
    assert.ok(Math.abs(entry.share - 1 / 3) < 1e-9);
  }
});

test("parses explicit weights with =, : and bare buckets", () => {
  assert.deepEqual(
    parseCountryWeights("US=2, DE=1, other=1").map((entry) => entry.share),
    [0.5, 0.25, 0.25]
  );
  assert.deepEqual(
    parseCountryWeights("US:3 DE:1").map((entry) => entry.bucket),
    ["US", "DE"]
  );
  assert.equal(parseCountryWeights("US,DE").length, 2);
  assert.equal(parseCountryWeights("us=1").at(0).bucket, "US");
});

test("rejects invalid weights instead of silently changing the split", () => {
  for (const value of ["", " ", "US=abc", "US=-1", "XYZ=1", "US=0,DE=0", "US=1,"]) {
    if (value === "US=1,") continue; // trailing separators are tolerated
    assert.throws(() => parseCountryWeights(value), /EGRESS_COUNTRY_WEIGHTS/);
  }
});

test("normalizes aliases and codes", () => {
  assert.equal(normalizeBucket("other"), OTHER_BUCKET);
  assert.equal(normalizeBucket("Random"), OTHER_BUCKET);
  assert.equal(normalizeBucket("*"), OTHER_BUCKET);
  assert.equal(normalizeBucket("de"), "DE");
  assert.equal(normalizeBucket("USA"), null);
});

test("chooses buckets by weight", () => {
  const weights = parseCountryWeights("US=2,DE=1,other=1");
  assert.equal(chooseBucket(weights, () => 0), "US");
  assert.equal(chooseBucket(weights, () => 0.49), "US");
  assert.equal(chooseBucket(weights, () => 0.51), "DE");
  assert.equal(chooseBucket(weights, () => 0.99), OTHER_BUCKET);
});

test("bucket matching distinguishes preferred countries from other", () => {
  const preferred = ["US", "DE"];

  assert.equal(matchesBucket("US", "US", preferred), true);
  assert.equal(matchesBucket("US", "DE", preferred), false);
  assert.equal(matchesBucket("US", undefined, preferred), false);
  assert.equal(matchesBucket("DE", "de", preferred), true);

  assert.equal(matchesBucket(OTHER_BUCKET, "FR", preferred), true);
  assert.equal(matchesBucket(OTHER_BUCKET, "US", preferred), false);
  assert.equal(matchesBucket(OTHER_BUCKET, undefined, preferred), false);
  assert.equal(
    matchesBucket(OTHER_BUCKET, undefined, preferred, { allowUnknown: true }),
    true
  );
});

test("other-country picking excludes preferred buckets", () => {
  const preferred = ["US", "DE"];
  for (let index = 0; index < 30; index += 1) {
    const country = pickOtherCountry(DEFAULT_OTHER_COUNTRIES, preferred);
    assert.ok(!preferred.includes(country));
    assert.match(country, /^[A-Z]{2}$/);
  }

  assert.throws(
    () => pickOtherCountry(["US", "DE"], preferred),
    /No usable country/
  );
});

test("planRoute honours mode and country weights", () => {
  const weights = parseCountryWeights("US=1,DE=1,other=1");

  const direct = planRoute({ mode: "direct", weights, preferred: ["US", "DE"], random: () => 0 });
  assert.equal(direct.kind, "direct");
  assert.equal(direct.bucket, "US");

  const vpn = planRoute({ mode: "vpn", weights, preferred: ["US", "DE"], random: () => 0.99 });
  assert.equal(vpn.kind, "vpn");
  assert.equal(vpn.bucket, OTHER_BUCKET);
  assert.ok(!["US", "DE"].includes(vpn.requestedCountry));

  const proxyOther = planRoute({
    mode: "proxy",
    weights,
    preferred: ["US", "DE"],
    random: () => 0.99,
  });
  assert.equal(proxyOther.kind, "proxy");
  assert.equal(proxyOther.requestedCountry, null);

  const mixedProxy = planRoute({
    mode: "mixed",
    vpnShare: 0,
    weights,
    preferred: ["US", "DE"],
    random: sequence([0, 0.5]),
  });
  assert.equal(mixedProxy.kind, "proxy");

  const mixedVpn = planRoute({
    mode: "mixed",
    vpnShare: 100,
    weights,
    preferred: ["US", "DE"],
    random: sequence([0, 0.5]),
  });
  assert.equal(mixedVpn.kind, "vpn");
});

test("planRoute distribution approximates thirds", () => {
  const weights = parseCountryWeights();
  const preferred = preferredBuckets(weights);
  const counts = { US: 0, DE: 0, other: 0 };
  const kinds = { vpn: 0, proxy: 0 };
  const runs = 9_000;

  for (let index = 0; index < runs; index += 1) {
    const route = planRoute({ mode: "mixed", vpnShare: 50, weights, preferred });
    counts[route.bucket] += 1;
    kinds[route.kind] += 1;
  }

  for (const count of Object.values(counts)) {
    assert.ok(Math.abs(count / runs - 1 / 3) < 0.02, JSON.stringify(counts));
  }
  assert.ok(Math.abs(kinds.vpn / runs - 0.5) < 0.03, JSON.stringify(kinds));
});
