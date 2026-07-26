// lib/admin-auth.js
// Token-based auth for admin endpoints.
//
// Login returns a signed token: "<timestamp>.<hmac>"
// Frontend stores it in localStorage and sends as Authorization: Bearer <token>
// Each admin endpoint calls requireAuth() to verify.
//
// No cookies = no cross-site browser headaches.

import { createHmac, timingSafeEqual, randomBytes, scryptSync } from 'crypto';

const TOKEN_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days in ms

/**
 * Hash a secret (password or recovery code) for storage.
 * Returns "<salt-hex>:<hash-hex>". Uses scrypt — no external deps.
 */
export function hashSecret(secret) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(secret, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Verify a secret against a stored "<salt>:<hash>" value. Timing-safe.
 */
export function verifySecret(secret, stored) {
  if (typeof secret !== 'string' || !secret.length) return false;
  if (!stored || typeof stored !== 'string') return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  try {
    const candidate = scryptSync(secret, salt, 64);
    const expected = Buffer.from(hash, 'hex');
    if (candidate.length !== expected.length) return false;
    return timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

/**
 * Build a signed token: "<timestamp>.<hmac>"
 */
export function signToken() {
  const secret = process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || 'fallback';
  const timestamp = String(Date.now());
  const hmac = createHmac('sha256', secret).update(timestamp).digest('hex');
  return `${timestamp}.${hmac}`;
}

/**
 * Verify a token. Returns true if signature valid and not expired.
 */
export function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const [timestamp, hmac] = token.split('.');
  if (!timestamp || !hmac) return false;

  const secret = process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || 'fallback';
  const expected = createHmac('sha256', secret).update(timestamp).digest('hex');

  try {
    const a = Buffer.from(hmac, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return false;
    if (!timingSafeEqual(a, b)) return false;
  } catch (e) {
    return false;
  }

  const age = Date.now() - parseInt(timestamp, 10);
  if (age > TOKEN_MAX_AGE) return false;
  if (age < 0) return false;

  return true;
}

const RESET_TOKEN_MAX_AGE = 60 * 60 * 1000; // 1 hour — short-lived on purpose

/**
 * Build a signed password-reset token: "<timestamp>.<hmac>"
 * Deliberately a distinct HMAC input ("reset.<ts>" vs signToken's bare
 * timestamp) so a reset token and a login session token can never be
 * confused for one another, even if one leaked.
 */
export function signResetToken() {
  const secret = process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || 'fallback';
  const timestamp = String(Date.now());
  const hmac = createHmac('sha256', secret).update(`reset.${timestamp}`).digest('hex');
  return `${timestamp}.${hmac}`;
}

/**
 * Verify a password-reset token. Short TTL (1h) since these get emailed.
 */
export function verifyResetToken(token) {
  if (!token || typeof token !== 'string') return false;
  const [timestamp, hmac] = token.split('.');
  if (!timestamp || !hmac) return false;

  const secret = process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || 'fallback';
  const expected = createHmac('sha256', secret).update(`reset.${timestamp}`).digest('hex');

  try {
    const a = Buffer.from(hmac, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return false;
    if (!timingSafeEqual(a, b)) return false;
  } catch (e) {
    return false;
  }

  const age = Date.now() - parseInt(timestamp, 10);
  if (age > RESET_TOKEN_MAX_AGE) return false;
  if (age < 0) return false;

  return true;
}

/**
 * Extract bearer token from Authorization header.
 */
export function getTokenFromRequest(req) {
  const auth = req.headers.authorization || req.headers.Authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  return auth.substring(7).trim();
}

/**
 * Middleware-style check: returns true if request is authenticated,
 * otherwise writes a 401 response and returns false.
 */
export function requireAuth(req, res) {
  const token = getTokenFromRequest(req);
  if (verifyToken(token)) return true;
  res.status(401).json({ error: 'Unauthorized' });
  return false;
}

/**
 * CORS for admin endpoints.
 * No credentials needed since we use Authorization header (not cookies).
 */
export function setAdminCors(res, origin) {
  const allowed = [
    'https://www.soirfr.com',
    'https://soirfr.com',
    'http://localhost:3000',
    'http://localhost:8080'
  ];
  if (allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', 'https://www.soirfr.com');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}
