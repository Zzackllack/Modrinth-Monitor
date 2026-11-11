const { OTHER_BUCKET, chooseBucket, pickOtherCountry } = require("../net/geo");

const MODES = new Set(["direct", "vpn", "proxy", "mixed"]);

/**
 * Decides the route for a single run without touching the network. Kept pure so
 * the distribution (US / DE / other, VPN / proxy) is directly testable.
 */
function planRoute({
  mode = "direct",
  vpnShare = 50,
  weights,
  otherCountries,
  preferred = [],
  random = Math.random,
} = {}) {
  if (!MODES.has(mode)) {
    throw new Error(`Unknown egress mode "${mode}".`);
  }

  const bucket = chooseBucket(weights, random);
  let kind;

  if (mode === "direct") {
    kind = "direct";
  } else if (mode === "vpn") {
    kind = "vpn";
  } else if (mode === "proxy") {
    kind = "proxy";
  } else {
    kind = random() * 100 < vpnShare ? "vpn" : "proxy";
  }

  const requestedCountry =
    kind === "vpn"
      ? bucket === OTHER_BUCKET
        ? pickOtherCountry(otherCountries, preferred, random)
        : bucket
      : bucket === OTHER_BUCKET
        ? null
        : bucket;

  return { kind, bucket, requestedCountry };
}

module.exports = { MODES, planRoute };
