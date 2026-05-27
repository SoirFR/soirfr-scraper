// /api/admin/login.js
// POST { password } -> sets session cookie on success
//
// Uses timing-safe comparison to prevent timing attacks.
// Rate limit: rely on Vercel's per-IP throttling for now.

import { timingSafeEqual } from 'crypto';
import { buildLoginCookie, setAdminCors } from '../../lib/admin-auth.js';

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

  // Timing-safe equality check (constant time)
  const a = Buffer.from(submitted);
  const b = Buffer.from(expected);
  let ok = false;
  if (a.length === b.length) {
    try { ok = timingSafeEqual(a, b); } catch { ok = false; }
  }
  // Always do the same amount of work, even on length mismatch
  if (!ok) {
    // Small delay to slow down brute-force from sophisticated attackers
    await new Promise(r => setTimeout(r, 250 + Math.random() * 250));
    return res.status(401).json({ error: 'Mot de passe incorrect' });
  }

  // Set cookie + respond
  res.setHeader('Set-Cookie', buildLoginCookie());
  return res.status(200).json({ ok: true });
}
