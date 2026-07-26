// /api/admin/login.js
// Handles two things, both keyed by body shape, so we don't add a 13th
// serverless function (Vercel Hobby caps at 12 — we already hit that limit
// once from api/multipart.js and had to delete it; not repeating that):
//
//   POST { password }                       -> { ok: true, token } on success
//   POST { recoveryCode, newPassword }       -> { ok: true } — resets the
//                                               password using the recovery
//                                               code, no login required
//
// Password + recovery code are stored as hashes in the admin_auth table
// (single row, id=1), not in an env var — an env var can't be rewritten by
// a serverless function at runtime, a DB row can, which is what makes
// self-service recovery possible at all.
//
// Frontend stores the login token in localStorage and sends it as
// Authorization: Bearer <token> for every subsequent admin request.

import { createClient } from '@supabase/supabase-js';
import { signToken, verifySecret, hashSecret, setAdminCors } from '../../lib/admin-auth.js';

export const config = {
  api: { bodyParser: { sizeLimit: '1kb' } }
};

export default async function handler(req, res) {
  setAdminCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  // ── Password reset via recovery code ──────────────────────────────────
  if (typeof body.recoveryCode === 'string') {
    const { recoveryCode, newPassword } = body;
    if (!recoveryCode.trim()) {
      return res.status(400).json({ error: 'Code de récupération requis' });
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return res.status(400).json({ error: 'Le nouveau mot de passe doit faire au moins 8 caractères' });
    }

    const { data, error } = await supabase
      .from('admin_auth')
      .select('recovery_code_hash')
      .eq('id', 1)
      .single();

    if (error || !data) {
      console.error('admin_auth lookup failed:', error);
      return res.status(500).json({ error: 'Server misconfigured' });
    }

    const codeOk = verifySecret(recoveryCode.trim(), data.recovery_code_hash);
    if (!codeOk) {
      await new Promise(r => setTimeout(r, 250 + Math.random() * 250));
      return res.status(401).json({ error: 'Code de récupération incorrect' });
    }

    const newHash = hashSecret(newPassword);
    const { error: updateError } = await supabase
      .from('admin_auth')
      .update({ password_hash: newHash, updated_at: new Date().toISOString() })
      .eq('id', 1);

    if (updateError) {
      console.error('admin_auth update failed:', updateError);
      return res.status(500).json({ error: 'Échec de la mise à jour du mot de passe' });
    }

    return res.status(200).json({ ok: true, reset: true });
  }

  // ── Normal login ───────────────────────────────────────────────────────
  const submitted = body.password;
  if (typeof submitted !== 'string' || submitted.length === 0) {
    return res.status(400).json({ error: 'Password required' });
  }

  const { data, error } = await supabase
    .from('admin_auth')
    .select('password_hash')
    .eq('id', 1)
    .single();

  if (error || !data) {
    console.error('admin_auth lookup failed:', error);
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const ok = verifySecret(submitted, data.password_hash);
  if (!ok) {
    // Slow down brute-force
    await new Promise(r => setTimeout(r, 250 + Math.random() * 250));
    return res.status(401).json({ error: 'Mot de passe incorrect' });
  }

  const token = signToken();
  return res.status(200).json({ ok: true, token });
}
