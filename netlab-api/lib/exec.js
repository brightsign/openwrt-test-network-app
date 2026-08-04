'use strict';

const { execFile } = require('child_process');

/**
 * Run a command with an explicit argument array. No shell is involved, so the
 * arguments are never re-parsed and cannot be used for command injection.
 *
 * @param {string} file - executable to run (e.g. "uci", "tc", "ubus")
 * @param {string[]} args - argument vector
 * @param {object} [opts]
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function run(file, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: 10000, maxBuffer: 4 * 1024 * 1024, ...opts },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          err.command = `${file} ${args.join(' ')}`;
          return reject(err);
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

module.exports = { run };
