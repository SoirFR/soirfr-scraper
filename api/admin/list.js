// /api/admin/list.js
// GET ?status=pending (default) | approved | rejected | all
// Returns submissions, with signed URLs for any uploaded files (so admin can view them).

import { createClient } from '@supabase/supabase-js';
import { requireAuth, setAdminCors } from '../../lib/admin-auth.js';

const SIGNED_URL_TTL = 60 * 60; // 1 hour — enough to review

export default async function handler(req, res) {
  setAdminCors(res, req.headers.origin);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const status = (req.query.status || 'pending').toLowerCase();
  const validStatuses = ['pending', 'approved', 'rejected', 'needs_edit', 'all'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status filter' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  let query = supabase
    .from('pending_events')
    .select('*')
    .order('submitted_at', { ascending: false })
    .limit(200);

  if (status !== 'all') {
    query = query.eq('status', status);
  }

  const { data, error } = await query;
  if (error) {
    console.error('List query failed:', error);
    return res.status(500).json({ error: 'Failed to load submissions' });
  }

  // Generate signed URLs for any uploaded files so the admin can preview them.
  // The bucket is private, so direct URLs wouldn't work.
  for (const row of data) {
    if (Array.isArray(row.uploaded_files) && row.uploaded_files.length) {
      for (const f of row.uploaded_files) {
        if (!f.path) continue;
        const { data: signed } = await supabase
          .storage
          .from('submissions')
          .createSignedUrl(f.path, SIGNED_URL_TTL);
        if (signed?.signedUrl) f.signed_url = signed.signedUrl;
      }
    }
  }

  return res.status(200).json({ submissions: data });
}
