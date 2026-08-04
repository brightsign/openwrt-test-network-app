'use strict';

const { run } = require('./exec');

const CONFIG = 'netlab';
const SECTION = 'main';

// The complete set of options the API is allowed to touch. Anything outside
// this whitelist is rejected before it reaches uci.
const OPTIONS = new Set([
  'enabled',
  'wan_interface',
  'test_interface',
  'upload_rate',
  'upload_delay',
  'upload_jitter',
  'upload_loss',
  'download_rate',
  'download_delay',
  'download_jitter',
  'download_loss',
  'queue_limit',
]);

function assertOption(option) {
  if (!OPTIONS.has(option)) {
    throw new Error(`refusing to access unknown uci option "${option}"`);
  }
}

async function get(option) {
  assertOption(option);
  try {
    const { stdout } = await run('uci', [
      '-q',
      'get',
      `${CONFIG}.${SECTION}.${option}`,
    ]);
    return stdout.trim();
  } catch (err) {
    // uci exits non-zero when the option is unset.
    return null;
  }
}

async function set(option, value) {
  assertOption(option);
  await run('uci', ['set', `${CONFIG}.${SECTION}.${option}=${value}`]);
}

async function commit() {
  await run('uci', ['commit', CONFIG]);
}

/**
 * Read every managed option in one pass.
 * @returns {Promise<Object<string,string|null>>}
 */
async function getAll() {
  const out = {};
  for (const option of OPTIONS) {
    out[option] = await get(option);
  }
  return out;
}

module.exports = { get, set, commit, getAll, OPTIONS };
