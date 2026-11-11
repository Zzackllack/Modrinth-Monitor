const fs = require("node:fs");
const path = require("node:path");

const MASK_KEYS = new Set(["password", "username", "token", "secret", "authorization"]);

function maskFields(fields) {
  const masked = {};
  for (const [key, value] of Object.entries(fields || {})) {
    masked[key] = MASK_KEYS.has(key.toLowerCase()) ? "***" : value;
  }
  return masked;
}

/**
 * Per-request audit trail: which route (VPN country or proxy), attempt number,
 * observed exit country and error. Written to stdout and appended to a JSONL
 * file so the history survives container restarts.
 */
class EgressJournal {
  constructor({ file = null, logAction, maxBytes = 5 * 1024 * 1024 } = {}) {
    this.file = file || null;
    this.logAction = logAction || (() => {});
    this.maxBytes = maxBytes;
    this.fileDisabled = false;

    if (this.file) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
      } catch (error) {
        this.fileDisabled = true;
        this.logAction("egress.journal.unavailable", {
          file: this.file,
          error: error.message,
        });
      }
    }
  }

  record(event, fields = {}) {
    const safeFields = maskFields(fields);
    this.logAction(event, safeFields);

    if (!this.file || this.fileDisabled) return;

    const line = `${JSON.stringify({
      ts: new Date().toISOString(),
      action: event,
      ...safeFields,
    })}\n`;

    try {
      this.rotateIfNeeded(Buffer.byteLength(line));
      fs.appendFileSync(this.file, line, { mode: 0o600 });
    } catch (error) {
      this.fileDisabled = true;
      this.logAction("egress.journal.write_failed", {
        file: this.file,
        error: error.message,
      });
    }
  }

  rotateIfNeeded(incomingBytes) {
    try {
      const stats = fs.statSync(this.file);
      if (stats.size + incomingBytes <= this.maxBytes) return;
      const rotated = `${this.file}.1`;
      fs.rmSync(rotated, { force: true });
      fs.renameSync(this.file, rotated);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

module.exports = { EgressJournal, maskFields };
