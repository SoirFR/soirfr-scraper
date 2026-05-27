// lib/admin-auth.js
// Token-based auth for admin endpoints.
//
// Login returns a signed token: "<timestamp>.<hmac>"
// Frontend stores it in localStorage and sends as Authorization: Bearer <token>
// Each admin endpoint calls requireAuth() to verify.
//
// No cookies = no cross-site browser headaches.

import { createHmac, timingSafeEqual } from 'crypto';

const TOKEN_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days in ms

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
