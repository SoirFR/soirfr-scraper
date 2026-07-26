// /api/admin/login.js
// Handles four things, all keyed by body shape, so we don't add a 13th
// serverless function (Vercel Hobby caps at 12 — we already hit that limit
// once from api/multipart.js and had to delete it; not repeating that):
//
//   POST { password }                    -> { ok: true, token } on success
//   POST { requestReset: true }          -> emails a one-hour reset link
//                                            to Liza's inbox (primary path)
//   POST { resetToken, newPassword }     -> consumes that emailed link's
//                                            token, sets the new password
//   POST { recoveryCode, newPassword }   -> fallback path — resets using
//                                            ANY of 5 unused single-use
//                                            recovery codes, for when email
//                                            isn't reachable. Not the
//                                            default UI path anymore, but
//                                            kept so there's more than one
//                                            way back in.
//
// Password is stored as a hash in admin_auth (single row, id=1), not in an
// env var — an env var can't be rewritten by a serverless function at
// runtime, a DB row can, which is what makes self-service recovery possible
// at all.
//
// Frontend stores the login token in localStorage and sends it as
// Authorization: Bearer <token> for every subsequent admin request.

import { createClient } from '@supabase/supabase-js';
import {
  signToken,
  verifySecret,
  hashSecret,
  signResetToken,
  verifyResetToken,
  setAdminCors
} from '../../lib/admin-auth.js';

// Where reset-link emails go. bonjour@soirfr.com is Squarespace domain
// forwarding (receive-only, no real SMTP mailbox behind it) — it forwards
// to this inbox, so we send straight here instead. Sending "from" is
// Resend's shared onboarding domain, no DNS setup required; RESEND_API_KEY
// is a Vercel env var, never touched by this codebase directly.
const RESET_EMAIL_TO = 'lvoloshin@gmail.com';
const RESET_EMAIL_FROM = process.env.RESEND_FROM || 'SoirFR Admin <onboarding@resend.dev>';

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

  // ── Request an emailed reset link (primary recovery path) ─────────────
  if (body.requestReset === true) {
    const token = signResetToken();
    const resetUrl = `https://www.soirfr.com/admin.html?reset=${encodeURIComponent(token)}`;

    if (process.env.RESEND_API_KEY) {
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.RESEND_API_KEY}`
          },
          body: JSON.stringify({
            from: RESET_EMAIL_FROM,
            to: RESET_EMAIL_TO,
            subject: 'Réinitialiser le mot de passe admin SoirFR',
            html: `<p>Un lien pour réinitialiser le mot de passe de l'espace admin SoirFR :</p>
                   <p><a href="${resetUrl}">${resetUrl}</a></p>
                   <p>Valable 1 heure. Si vous n'avez rien demandé, ignorez cet email.</p>`
          })
        });
      } catch (emailError) {
        console.error('Resend send failed:', emailError);
      }
    } else {
      console.error('RESEND_API_KEY not set — reset email not sent');
    }

    // Same response either way — don't leak whether sending succeeded.
    return res.status(200).json({ ok: true });
  }

  // ── Consume an emailed reset link ──────────────────────────────────────
  if (typeof body.resetToken === 'string') {
    const { resetToken, newPassword } = body;
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return res.status(400).json({ error: 'Le nouveau mot de passe doit faire au moins 8 caractères' });
    }
    if (!verifyResetToken(resetToken)) {
      return res.status(401).json({ error: 'Lien invalide ou expiré' });
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

  // ── Password reset via recovery code (fallback path) ───────────────────
  if (typeof body.recoveryCode === 'string') {
    const { recoveryCode, newPassword } = body;
    if (!recoveryCode.trim()) {
      return res.status(400).json({ error: 'Code de récupération requis' });
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return res.status(400).json({ error: 'Le nouveau mot de passe doit faire au moins 8 caractères' });
    }

    const { data: codes, error: codesError } = await supabase
      .from('admin_recovery_codes')
      .select('id, code_hash')
      .is('used_at', null);

    if (codesError) {
      console.error('admin_recovery_codes lookup failed:', codesError);
      return res.status(500).json({ error: 'Server misconfigured' });
    }

    const trimmed = recoveryCode.trim();
    const matched = (codes || []).find(c => verifySecret(trimmed, c.code_hash));
    if (!matched) {
      await new Promise(r => setTimeout(r, 250 + Math.random() * 250));
      return res.status(401).json({ error: 'Code de récupération incorrect ou déjà utilisé' });
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

    // Burn only the one code that was used — the others stay valid.
    await supabase
      .from('admin_recovery_codes')
      .update({ used_at: new Date().toISOString() })
      .eq('id', matched.id);

    const remaining = (codes || []).length - 1;
    return res.status(200).json({ ok: true, reset: true, codesRemaining: remaining });
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
