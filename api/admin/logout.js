// /api/admin/logout.js
// Clears the admin session cookie.

import { buildLogoutCookie, setAdminCors } from '../../lib/admin-auth.js';

export default async function handler(req, res) {
  setAdminCors(res, req.headers.origin);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Set-Cookie', buildLogoutCookie());
  return res.status(200).json({ ok: true });
}
