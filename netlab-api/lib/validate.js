'use strict';

/**
 * Input validation for the impairment API.
 *
 * Every value that ends up in a shell-adjacent command (uci/tc) is forced
 * through these checks first, so only well-formed numbers ever leave the API
 * layer. Combined with argument-array execution (lib/exec.js) this keeps the
 * unauthenticated endpoint safe from injection.
 */

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

const DIRECTIONS = ['upload', 'download'];
const DIRECTION_FIELDS = ['rateMbit', 'delayMs', 'jitterMs', 'lossPct'];

function isPlainObject(value) {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value)
  );
}

function num(value, field, { min, max, integer }) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`"${field}" must be a finite number`);
  }
  if (integer && !Number.isInteger(value)) {
    throw new ValidationError(`"${field}" must be an integer`);
  }
  if (min !== undefined && value < min) {
    throw new ValidationError(`"${field}" must be >= ${min}`);
  }
  if (max !== undefined && value > max) {
    throw new ValidationError(`"${field}" must be <= ${max}`);
  }
  return value;
}

function validateDirectionField(field, label, value) {
  switch (field) {
    case 'rateMbit':
      return num(value, label, { min: 0 });
    case 'delayMs':
      return num(value, label, { min: 0 });
    case 'jitterMs':
      return num(value, label, { min: 0 });
    case 'lossPct':
      return num(value, label, { min: 0, max: 100 });
    default:
      throw new ValidationError(`unknown field "${label}"`);
  }
}

function validateDirection(dir, obj, { partial }) {
  if (!isPlainObject(obj)) {
    throw new ValidationError(`"${dir}" must be an object`);
  }
  const out = {};
  for (const key of Object.keys(obj)) {
    if (!DIRECTION_FIELDS.includes(key)) {
      throw new ValidationError(`unknown field "${dir}.${key}"`);
    }
  }
  for (const field of DIRECTION_FIELDS) {
    if (obj[field] === undefined) {
      if (partial) continue;
      throw new ValidationError(`"${dir}.${field}" is required`);
    }
    out[field] = validateDirectionField(field, `${dir}.${field}`, obj[field]);
  }
  return out;
}

/**
 * Validate a profile body.
 *
 * @param {*} body - parsed JSON request body
 * @param {object} opts
 * @param {boolean} opts.partial - if true, missing fields are allowed (PATCH)
 * @returns {object} normalized profile fragment
 */
function validateProfile(body, { partial } = { partial: false }) {
  if (!isPlainObject(body)) {
    throw new ValidationError('request body must be a JSON object');
  }

  const allowed = ['enabled', 'queueLimit', 'upload', 'download'];
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      throw new ValidationError(`unknown field "${key}"`);
    }
  }

  const out = {};

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') {
      throw new ValidationError('"enabled" must be a boolean');
    }
    out.enabled = body.enabled;
  } else if (!partial) {
    out.enabled = true;
  }

  if (body.queueLimit !== undefined) {
    out.queueLimit = num(body.queueLimit, 'queueLimit', {
      min: 1,
      max: 1000000,
      integer: true,
    });
  } else if (!partial) {
    out.queueLimit = 1000;
  }

  for (const dir of DIRECTIONS) {
    if (body[dir] !== undefined) {
      out[dir] = validateDirection(dir, body[dir], { partial });
    } else if (!partial) {
      throw new ValidationError(`"${dir}" is required`);
    }
  }

  if (partial && Object.keys(out).length === 0) {
    throw new ValidationError('empty update: provide at least one field');
  }

  return out;
}

module.exports = {
  ValidationError,
  validateProfile,
  DIRECTIONS,
  DIRECTION_FIELDS,
};
