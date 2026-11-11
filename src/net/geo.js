const OTHER_BUCKET = "other";

// Concrete server countries used when the "other" bucket has to resolve to a
// single country (VPN routes only). Free proxies are filtered by "not
// preferred" instead, so they do not need a country from this list.
const DEFAULT_OTHER_COUNTRIES = [
  "CA", "GB", "NL", "FR", "SE", "CH", "JP", "SG", "AU", "BR", "PL", "ES",
  "IT", "NO", "FI", "DK", "IE", "AT", "BE", "CZ", "RO", "ZA", "IN", "KR",
  "TW", "HK", "TR", "UA",
];

const COUNTRY_CODE = /^[A-Z]{2}$/;
const OTHER_ALIASES = new Set(["other", "others", "random", "any", "*"]);

function normalizeBucket(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (OTHER_ALIASES.has(raw.toLowerCase())) return OTHER_BUCKET;
  const code = raw.toUpperCase();
  return COUNTRY_CODE.test(code) ? code : null;
}

/**
 * Parses `US=1,DE=1,other=1` (also accepts `US:2`, bare `US`, semicolons or
 * whitespace as separators). Weights are relative, not percentages.
 */
function parseCountryWeights(raw = "US=1,DE=1,other=1") {
  const items = String(raw)
    .split(/[,;\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (!items.length) {
    throw new Error(
      "EGRESS_COUNTRY_WEIGHTS must define at least one country bucket."
    );
  }

  const merged = new Map();
  for (const item of items) {
    const [bucketPart, weightPart] = item.split(/[=:]/);
    const bucket = normalizeBucket(bucketPart);
    if (!bucket) {
      throw new Error(
        `Invalid bucket "${bucketPart}" in EGRESS_COUNTRY_WEIGHTS; use an ISO 3166-1 alpha-2 code or "other".`
      );
    }

    const weight = weightPart === undefined || weightPart === "" ? 1 : Number(weightPart);
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(
        `Invalid weight "${weightPart}" for ${bucket} in EGRESS_COUNTRY_WEIGHTS; weights must be non-negative numbers.`
      );
    }

    merged.set(bucket, (merged.get(bucket) || 0) + weight);
  }

  const total = [...merged.values()].reduce((sum, weight) => sum + weight, 0);
  if (!(total > 0)) {
    throw new Error("EGRESS_COUNTRY_WEIGHTS must have a positive total weight.");
  }

  return [...merged.entries()].map(([bucket, weight]) => ({
    bucket,
    weight,
    share: weight / total,
  }));
}

function preferredBuckets(weights) {
  return weights
    .map((entry) => entry.bucket)
    .filter((bucket) => bucket !== OTHER_BUCKET);
}

function chooseBucket(weights, random = Math.random) {
  const total = weights.reduce((sum, entry) => sum + entry.weight, 0);
  if (!(total > 0)) {
    throw new Error("Cannot choose a country bucket without positive weights.");
  }

  let roll = random() * total;
  let fallback;
  for (const entry of weights) {
    if (entry.weight <= 0) continue;
    fallback = entry.bucket;
    roll -= entry.weight;
    if (roll < 0) return entry.bucket;
  }

  return fallback;
}

/**
 * `bucket` is a configured bucket (`US`, `DE`, `other`), `countryCode` is an
 * observed exit country. Unknown countries only satisfy `other` when explicitly
 * allowed; the VPN path needs a definite match.
 */
function matchesBucket(bucket, countryCode, preferred, { allowUnknown = false } = {}) {
  const code = String(countryCode || "").trim().toUpperCase();

  if (bucket === OTHER_BUCKET) {
    if (!COUNTRY_CODE.test(code)) return allowUnknown;
    return !preferred.includes(code);
  }

  return COUNTRY_CODE.test(code) && code === bucket;
}

function pickOtherCountry(candidates, preferred, random = Math.random) {
  const pool = (candidates && candidates.length
    ? candidates
    : DEFAULT_OTHER_COUNTRIES
  )
    .map((code) => String(code).trim().toUpperCase())
    .filter((code) => COUNTRY_CODE.test(code) && !preferred.includes(code));

  if (!pool.length) {
    throw new Error(
      "No usable country for the \"other\" bucket; EGRESS_OTHER_COUNTRIES contains only preferred countries."
    );
  }

  return pool[Math.floor(random() * pool.length)] || pool[0];
}

module.exports = {
  DEFAULT_OTHER_COUNTRIES,
  OTHER_BUCKET,
  chooseBucket,
  matchesBucket,
  normalizeBucket,
  parseCountryWeights,
  pickOtherCountry,
  preferredBuckets,
};
