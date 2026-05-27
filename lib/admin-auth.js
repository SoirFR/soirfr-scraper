// lib/admin-auth.js
// Shared session-cookie auth for admin endpoints.
//
// On login, we set a cookie containing an HMAC-signed token.
// Each admin endpoint calls requireAuth() to verify the cookie.

import { createHmac, timingSafeEqual } from 'crypto';

const COOKIE_NAME = 'soirfr_admin';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds

/**
 * Build a signed cookie value: "<timestamp>.<hmac>"
 * The HMAC is computed over the timestamp using ADMIN_SESSION_SECRET.
 */
export function signSession() {
  const secret = process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || 'fallback';
  const timestamp = String(Date.now());
  const hmac = createHmac('sha256', secret).update(timestamp).digest('hex');
  return `${timestamp}.${hmac}`;
}

/**
 * Verify a cookie value. Returns true if signature valid and not expired.
 */
export function verifySession(cookieValue) {
  if (!cookieValue || typeof cookieValue !== 'string') return false;
  const [timestamp, hmac] = cookieValue.split('.');
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

  // Check expiry
  const age = (Date.now() - parseInt(timestamp, 10)) / 1000;
  if (age > COOKIE_MAX_AGE) return false;
  if (age < 0) return false;

  return true;
}

/**
 * Build the Set-Cookie header for a fresh login.
 */
export function buildLoginCookie() {
  const value = signSession();
  return `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`;
}

/**
 * Build the Set-Cookie header for logout (expires immediately).
 */
export function buildLogoutCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/**
 * Parse cookies from a request and return the admin session value, if present.
 */
export function getSessionFromRequest(req) {
  const cookieHeader = req.headers.cookie || '';
  const cookies = {};
  cookieHeader.split(';').forEach(c => {
    const [k, ...rest] = c.trim().split('=');
    if (k) cookies[k] = rest.join('=');
  });
  return cookies[COOKIE_NAME] || null;
}

/**
 * Middleware-style check: returns true if request is authenticated,
 * otherwise writes a 401 response and returns false.
 */
export function requireAuth(req, res) {
  const session = getSessionFromRequest(req);
  if (verifySession(session)) return true;
  res.status(401).json({ error: 'Unauthorized' });
  return false;
}

/**
 * CORS for admin endpoints — only allow soirfr.com, with credentials.
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
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
