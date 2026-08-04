'use strict';

const uci = require('./uci');
const { run } = require('./exec');

const INIT_SCRIPT = '/etc/init.d/netlab';

// ---------------------------------------------------------------------------
// Unit conversion: API JSON numbers <-> UCI/netem strings
// ---------------------------------------------------------------------------

function rateToUci(mbit) {
  // 0 means "unlimited"; the init script skips a rate of "0".
  if (!mbit || mbit <= 0) return '0';
  // Keep it simple and lossless: express everything in mbit.
  return `${mbit}mbit`;
}

function rateFromUci(str) {
  if (!str) return 0;
  const s = String(str).trim().toLowerCase();
  if (s === '0') return 0;
  const m = s.match(/^([0-9]*\.?[0-9]+)\s*(gbit|mbit|kbit|bit)?$/);
  if (!m) return 0;
  const value = parseFloat(m[1]);
  switch (m[2]) {
    case 'gbit':
      return value * 1000;
    case 'kbit':
      return value / 1000;
    case 'bit':
      return value / 1e6;
    case 'mbit':
    default:
      return value;
  }
}

function msToUci(ms) {
  return `${ms || 0}ms`;
}

function msFromUci(str) {
  if (!str) return 0;
  const m = String(str).match(/([0-9]*\.?[0-9]+)/);
  return m ? parseFloat(m[1]) : 0;
}

function lossToUci(pct) {
  return `${pct || 0}%`;
}

function lossFromUci(str) {
  if (!str) return 0;
  const m = String(str).match(/([0-9]*\.?[0-9]+)/);
  return m ? parseFloat(m[1]) : 0;
}

// ---------------------------------------------------------------------------
// Profile <-> UCI mapping
// ---------------------------------------------------------------------------

function directionToUci(prefix, dir) {
  const out = {};
  if (dir.rateMbit !== undefined) out[`${prefix}_rate`] = rateToUci(dir.rateMbit);
  if (dir.delayMs !== undefined) out[`${prefix}_delay`] = msToUci(dir.delayMs);
  if (dir.jitterMs !== undefined) out[`${prefix}_jitter`] = msToUci(dir.jitterMs);
  if (dir.lossPct !== undefined) out[`${prefix}_loss`] = lossToUci(dir.lossPct);
  return out;
}

/**
 * Convert a normalized profile fragment into a flat map of uci options.
 * Only the fields present in the fragment are emitted (supports PATCH).
 */
function profileToUci(profile) {
  const out = {};
  if (profile.enabled !== undefined) out.enabled = profile.enabled ? '1' : '0';
  if (profile.queueLimit !== undefined) out.queue_limit = String(profile.queueLimit);
  if (profile.upload) Object.assign(out, directionToUci('upload', profile.upload));
  if (profile.download) Object.assign(out, directionToUci('download', profile.download));
  return out;
}

/**
 * Build the structured API profile from the raw uci option map.
 */
function profileFromUci(raw) {
  return {
    enabled: raw.enabled === '1',
    queueLimit: raw.queue_limit ? parseInt(raw.queue_limit, 10) : 1000,
    upload: {
      rateMbit: rateFromUci(raw.upload_rate),
      delayMs: msFromUci(raw.upload_delay),
      jitterMs: msFromUci(raw.upload_jitter),
      lossPct: lossFromUci(raw.upload_loss),
    },
    download: {
      rateMbit: rateFromUci(raw.download_rate),
      delayMs: msFromUci(raw.download_delay),
      jitterMs: msFromUci(raw.download_jitter),
      lossPct: lossFromUci(raw.download_loss),
    },
  };
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

async function readProfile() {
  const raw = await uci.getAll();
  return profileFromUci(raw);
}

async function reload() {
  await run(INIT_SCRIPT, ['reload']);
}

async function stop() {
  await run(INIT_SCRIPT, ['stop']);
}

/**
 * Persist a (possibly partial) profile fragment to UCI, commit, and reapply.
 */
async function writeProfile(fragment) {
  const options = profileToUci(fragment);
  for (const [option, value] of Object.entries(options)) {
    await uci.set(option, value);
  }
  await uci.commit();
  await reload();
  return readProfile();
}

/**
 * Clear all impairment: disable, commit, and tear down live qdiscs.
 */
async function clear() {
  await uci.set('enabled', '0');
  await uci.commit();
  await stop();
  return readProfile();
}

module.exports = {
  readProfile,
  writeProfile,
  clear,
  reload,
  profileToUci,
  profileFromUci,
};
