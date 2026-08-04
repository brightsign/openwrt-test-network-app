'use strict';

const uci = require('./uci');
const { run } = require('./exec');

/**
 * Resolve the live Linux device backing an OpenWrt logical interface.
 * Mirrors `ubus call network.interface.<if> status | jsonfilter -e '@.l3_device'`.
 */
async function resolveDevice(iface) {
  try {
    const { stdout } = await run('ubus', [
      'call',
      `network.interface.${iface}`,
      'status',
    ]);
    const parsed = JSON.parse(stdout);
    return parsed.l3_device || parsed.device || null;
  } catch (err) {
    return null;
  }
}

/**
 * Parse the summary counter line emitted by `tc -s qdisc show`.
 * Example: "Sent 12345 bytes 67 pkt (dropped 2, overlimits 0 requeues 0)"
 */
function parseTcStats(text) {
  if (!text) return null;
  const stats = {};
  const sent = text.match(/Sent\s+(\d+)\s+bytes\s+(\d+)\s+pkt/);
  if (sent) {
    stats.sentBytes = parseInt(sent[1], 10);
    stats.sentPackets = parseInt(sent[2], 10);
  }
  const dropped = text.match(/dropped\s+(\d+)/);
  if (dropped) stats.dropped = parseInt(dropped[1], 10);
  const overlimits = text.match(/overlimits\s+(\d+)/);
  if (overlimits) stats.overlimits = parseInt(overlimits[1], 10);
  return stats;
}

async function qdiscForDevice(dev) {
  if (!dev) return { device: null, raw: null, stats: null };
  try {
    const { stdout } = await run('tc', ['-s', 'qdisc', 'show', 'dev', dev]);
    return {
      device: dev,
      raw: stdout.trim(),
      stats: parseTcStats(stdout),
    };
  } catch (err) {
    return { device: dev, raw: null, stats: null, error: err.message };
  }
}

/**
 * Full live status: which logical interfaces map to which devices, and the
 * current tc qdisc + counters on each.
 */
async function getStatus() {
  const wanIf = (await uci.get('wan_interface')) || 'wan';
  const testIf = (await uci.get('test_interface')) || 'lan';

  const [wanDev, testDev] = await Promise.all([
    resolveDevice(wanIf),
    resolveDevice(testIf),
  ]);

  const [uploadQdisc, downloadQdisc] = await Promise.all([
    qdiscForDevice(wanDev),
    qdiscForDevice(testDev),
  ]);

  return {
    interfaces: {
      wan: { logical: wanIf, device: wanDev },
      test: { logical: testIf, device: testDev },
    },
    // upload is shaped on WAN egress; download on the test bridge egress
    upload: uploadQdisc,
    download: downloadQdisc,
  };
}

module.exports = { getStatus, resolveDevice };
