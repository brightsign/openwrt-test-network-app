'use strict';

/**
 * netlab REST API
 *
 * A zero-dependency HTTP server (Node built-in `http` only) that runs on the
 * OpenWrt router and exposes per-direction latency / jitter / packet loss /
 * bandwidth control by driving the `netlab` UCI config + init script.
 *
 * Configuration via environment variables:
 *   NETLAB_API_HOST  (default 0.0.0.0)
 *   NETLAB_API_PORT  (default 8080)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const netem = require('./lib/netem');
const status = require('./lib/status');
const profiles = require('./lib/profiles');
const { validateProfile, ValidationError } = require('./lib/validate');

const HOST = process.env.NETLAB_API_HOST || '0.0.0.0';
const PORT = parseInt(process.env.NETLAB_API_PORT || '8080', 10);
const OPENAPI_PATH = path.join(__dirname, 'openapi.yaml');
const MAX_BODY_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Small HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, statusCode, code, message) {
  sendJson(res, statusCode, { error: { code, message } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ValidationError('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new ValidationError('request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleGetImpairment(req, res) {
  const profile = await netem.readProfile();
  sendJson(res, 200, profile);
}

async function handleReplaceImpairment(req, res) {
  const body = await readBody(req);
  const fragment = validateProfile(body, { partial: false });
  const updated = await netem.writeProfile(fragment);
  sendJson(res, 200, updated);
}

async function handlePatchImpairment(req, res) {
  const body = await readBody(req);
  const fragment = validateProfile(body, { partial: true });
  const updated = await netem.writeProfile(fragment);
  sendJson(res, 200, updated);
}

async function handleClearImpairment(req, res) {
  const updated = await netem.clear();
  sendJson(res, 200, updated);
}

async function handleStatus(req, res) {
  const live = await status.getStatus();
  sendJson(res, 200, live);
}

async function handleListProfiles(req, res) {
  sendJson(res, 200, { profiles: profiles.list() });
}

async function handleApplyProfile(req, res, name) {
  const preset = profiles.get(name);
  if (!preset) {
    return sendError(res, 404, 'not_found', `unknown profile "${name}"`);
  }
  const updated = await netem.writeProfile(preset.profile);
  sendJson(res, 200, { applied: preset.name, profile: updated });
}

function handleOpenApi(req, res) {
  fs.readFile(OPENAPI_PATH, (err, data) => {
    if (err) {
      return sendError(res, 500, 'internal_error', 'openapi spec unavailable');
    }
    res.writeHead(200, {
      'Content-Type': 'application/yaml',
      'Content-Length': data.length,
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const APPLY_PROFILE_RE = /^\/api\/v1\/profiles\/([A-Za-z0-9._-]+)\/apply$/;

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;
  const method = req.method;

  if (method === 'GET' && pathname === '/healthz') {
    return sendJson(res, 200, { status: 'ok' });
  }
  if (method === 'GET' && (pathname === '/openapi.yaml' || pathname === '/openapi.yml')) {
    return handleOpenApi(req, res);
  }
  if (pathname === '/api/v1/impairment') {
    if (method === 'GET') return handleGetImpairment(req, res);
    if (method === 'PUT') return handleReplaceImpairment(req, res);
    if (method === 'PATCH') return handlePatchImpairment(req, res);
    if (method === 'DELETE') return handleClearImpairment(req, res);
    return sendError(res, 405, 'method_not_allowed', `${method} not allowed`);
  }
  if (pathname === '/api/v1/status' && method === 'GET') {
    return handleStatus(req, res);
  }
  if (pathname === '/api/v1/profiles' && method === 'GET') {
    return handleListProfiles(req, res);
  }
  const applyMatch = pathname.match(APPLY_PROFILE_RE);
  if (applyMatch && method === 'POST') {
    return handleApplyProfile(req, res, applyMatch[1]);
  }

  return sendError(res, 404, 'not_found', `no route for ${method} ${pathname}`);
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    if (err instanceof ValidationError) {
      return sendError(res, 400, 'validation_error', err.message);
    }
    const detail = err && err.stderr ? String(err.stderr).trim() : err.message;
    // eslint-disable-next-line no-console
    console.error(`[netlab-api] error handling ${req.method} ${req.url}:`, err);
    sendError(res, 500, 'internal_error', detail || 'internal error');
  });
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[netlab-api] listening on http://${HOST}:${PORT}`);
});

module.exports = server;
