// /api/admin/login.js
// POST { password } -> { ok: true, token: "..." } on success
//
// Frontend stores token in localStorage and sends as Authorization: Bearer <token>
// for every subsequent admin request.

import { timingSafeEqual } from 'crypto';
import { signToken, setAdminCors } from '../../lib/admin-auth.js';

export const config = {
  api: { bodyParser: { sizeLimit: '1kb' } }
};

export default async function handler(req, res) {
  setAdminCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const submitted = req.body?.password;
  const expected = process.env.ADMIN_PASSWORD;

  if (!expected) {
    console.error('ADMIN_PASSWORD env var not set');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  if (typeof submitted !== 'string' || submitted.length === 0) {
    return res.status(400).json({ error: 'Password required' });
  }

  // Timing-safe equality check
  const a = Buffer.from(submitted);
  const b = Buffer.from(expected);
  let ok = false;
  if (a.length === b.length) {
    try { ok = timingSafeEqual(a, b); } catch { ok = false; }
  }
  if (!ok) {
    // Slow down brute-force
    await new Promise(r => setTimeout(r, 250 + Math.random() * 250));
    return res.status(401).json({ error: 'Mot de passe incorrect' });
  }

  // Return token — frontend will stash it in localStorage
  const token = signToken();
  return res.status(200).json({ ok: true, token });
}
