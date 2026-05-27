// /api/admin/logout.js
// With token-based auth, logout is purely client-side (drop the token from
// localStorage). This endpoint exists for symmetry and as a hook for future
// token revocation, but currently just returns ok.

import { setAdminCors } from '../../lib/admin-auth.js';

export default async function handler(req, res) {
  setAdminCors(res, req.headers.origin);
  if (req.method === 'OPTIONS') return res.status(204).end();
  return res.status(200).json({ ok: true });
}
