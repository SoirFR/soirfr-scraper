// /api/admin/update.js
// PATCH { id, fields } -> updates the pending_events row.
// Use this to save edits before approving, or to fix things and come back later.

import { createClient } from '@supabase/supabase-js';
import { requireAuth, setAdminCors } from '../../lib/admin-auth.js';

// Whitelist of editable fields
const EDITABLE = [
  'title', 'description', 'starts_at', 'ends_at', 'category',
  'venue_name', 'address', 'postal_code', 'city',
  'lat', 'lng',
  'price_text', 'price_min', 'price_max', 'is_free',
  'source_url', 'booking_url', 'image_url',
  'moderator_notes'
];

export default async function handler(req, res) {
  setAdminCors(res, req.headers.origin);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== 'PATCH' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id, fields } = req.body || {};
  if (!id || typeof id !== 'number' && typeof id !== 'string') {
    return res.status(400).json({ error: 'id required' });
  }
  if (!fields || typeof fields !== 'object') {
    return res.status(400).json({ error: 'fields object required' });
  }

  // Whitelist + sanitize
  const update = {};
  for (const k of EDITABLE) {
    if (k in fields) {
      const v = fields[k];
      // empty strings -> null
      if (v === '' || v === undefined) update[k] = null;
      else update[k] = v;
    }
  }

  if (!Object.keys(update).length) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  const { data, error } = await supabase
    .from('pending_events')
    .update(update)
    .eq('id', id)
    .select('*')
    .single();

  if (error) {
    console.error('Update failed:', error);
    return res.status(500).json({ error: 'Update failed', detail: error.message });
  }

  return res.status(200).json({ ok: true, row: data });
}
