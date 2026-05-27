// /api/admin/reject.js
// POST { id, reason? } -> marks submission as rejected.

import { createClient } from '@supabase/supabase-js';
import { requireAuth, setAdminCors } from '../../lib/admin-auth.js';

export default async function handler(req, res) {
  setAdminCors(res, req.headers.origin);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id, reason } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id required' });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  const { error } = await supabase
    .from('pending_events')
    .update({
      status: 'rejected',
      moderated_at: new Date().toISOString(),
      moderator_notes: reason || null
    })
    .eq('id', id);

  if (error) {
    return res.status(500).json({ error: 'Reject failed', detail: error.message });
  }

  return res.status(200).json({ ok: true });
}
