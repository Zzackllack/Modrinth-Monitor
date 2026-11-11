const INTERESTING = /Error:|ERR_[A-Z_]+|net::|Timeout \d+ms exceeded|ECONN|ETIMEDOUT/;

/**
 * Playwright prints the useful reason in the middle of its report. Keep the
 * journal line short but retain the actual cause, e.g.
 * `net::ERR_PROXY_CERTIFICATE_INVALID`, instead of just "exited with code 1".
 */
function summarizePlaywrightFailure(output) {
  const cleaned = String(output || "").replace(/\x1b\[[0-9;]*m/g, "");
  const lines = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) return "";

  const interesting = lines.filter((line) => INTERESTING.test(line));
  const chosen = interesting.length ? interesting.slice(-2) : lines.slice(-1);

  return chosen.join(" | ").replace(/\s+/g, " ").slice(0, 400);
}

module.exports = { summarizePlaywrightFailure };
