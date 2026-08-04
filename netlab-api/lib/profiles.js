'use strict';

/**
 * Preset impairment profiles from Section 9 of the setup guide.
 * Delay, jitter, and loss are "each way" and therefore applied identically to
 * both the upload and download directions. Rate differs per direction.
 */

function makeProfile({ upMbit, downMbit, delayMs, jitterMs, lossPct }) {
  return {
    enabled: true,
    queueLimit: 1000,
    upload: { rateMbit: upMbit, delayMs, jitterMs, lossPct },
    download: { rateMbit: downMbit, delayMs, jitterMs, lossPct },
  };
}

const PRESETS = {
  'clean-constrained': {
    name: 'clean-constrained',
    description: 'Bandwidth-only behavior',
    profile: makeProfile({ upMbit: 10, downMbit: 50, delayMs: 10, jitterMs: 2, lossPct: 0 }),
  },
  'good-lte': {
    name: 'good-lte',
    description: 'Typical mobile path',
    profile: makeProfile({ upMbit: 10, downMbit: 40, delayMs: 35, jitterMs: 8, lossPct: 0.2 }),
  },
  'poor-lte': {
    name: 'poor-lte',
    description: 'Unstable field connection',
    profile: makeProfile({ upMbit: 2, downMbit: 8, delayMs: 100, jitterMs: 30, lossPct: 2 }),
  },
  'satellite-like': {
    name: 'satellite-like',
    description: 'High-latency application testing',
    profile: makeProfile({ upMbit: 5, downMbit: 25, delayMs: 300, jitterMs: 20, lossPct: 0.5 }),
  },
  'severe-failure': {
    name: 'severe-failure',
    description: 'Timeout and recovery logic (256/512 kbit)',
    profile: makeProfile({ upMbit: 0.256, downMbit: 0.512, delayMs: 250, jitterMs: 100, lossPct: 10 }),
  },
};

function list() {
  return Object.values(PRESETS).map(({ name, description, profile }) => ({
    name,
    description,
    profile,
  }));
}

function get(name) {
  return PRESETS[name] || null;
}

module.exports = { list, get, PRESETS };
