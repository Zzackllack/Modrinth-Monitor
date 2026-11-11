const net = require("node:net");

function stripBrackets(host) {
  const value = String(host ?? "").trim();
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

function isIPv6(host) {
  return net.isIPv6(stripBrackets(host));
}

/** WHATWG `URL` needs IPv6 literals wrapped in brackets. */
function formatHostForUrl(host) {
  const value = stripBrackets(host);
  return isIPv6(value) ? `[${value}]` : value;
}

module.exports = {
  formatHostForUrl,
  isIPv6,
  stripBrackets,
};
