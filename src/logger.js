const os = require('os');

const MASK_KEYS = ['PASSWORD', 'TOKEN', 'SECRET', 'KEY'];

function maskValue(key, value) {
  const upper = key.toUpperCase();
  if (MASK_KEYS.some((frag) => upper.includes(frag))) {
    return '***';
  }
  return value;
}

function dumpEnv() {
  const entries = Object.entries(process.env).map(([k, v]) => [
    k,
    maskValue(k, String(v)),
  ]);
  return Object.fromEntries(entries);
}

function dumpSystem() {
  return {
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    cpus: os.cpus()?.length,
    totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
    freeMemMB: Math.round(os.freemem() / 1024 / 1024),
    hostname: os.hostname(),
  };
}

function logAction(action, extra = {}) {
  const timestamp = new Date().toISOString();
  console.log(JSON.stringify({ ts: timestamp, action, ...extra }));
}

module.exports = {
  dumpEnv,
  dumpSystem,
  logAction,
};
