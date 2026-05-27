// /api/admin/approve.js
// POST { id } -> moves pending_events row into events table.
// - Re-geocodes if lat/lng missing (api-adresse.data.gouv.fr)
// - Copies uploaded image to public bucket and writes image_url
// - Builds PostGIS POINT geography for events.location
// - Inserts into events with source_type='user_submission'

import { createClient } from '@supabase/supabase-js';
import { requireAuth, setAdminCors } from '../../lib/admin-auth.js';

const PUBLIC_BUCKET = 'event-images';
const PRIVATE_BUCKET = 'submissions';

export default async function handler(req, res) {
  setAdminCors(res, req.headers.origin);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id required' });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  // 1. Load the pending row
  const { data: pending, error: loadErr } = await supabase
    .from('pending_events')
    .select('*')
    .eq('id', id)
    .single();

  if (loadErr || !pending) {
    return res.status(404).json({ error: 'Submission not found' });
  }
  if (pending.status === 'approved' && pending.approved_event_id) {
    return res.status(409).json({ error: 'Already approved', event_id: pending.approved_event_id });
  }

  // 2. Validation — events table requires title, category, starts_at
  if (!pending.title) {
    return res.status(400).json({
      error: 'Cannot approve: title is required. Edit the submission first.'
    });
  }
  if (!pending.starts_at) {
    return res.status(400).json({
      error: 'Cannot approve: start date is required. Edit the submission first.'
    });
  }

  // 3. Geocode if lat/lng missing
  let lat = pending.lat ? parseFloat(pending.lat) : null;
  let lng = pending.lng ? parseFloat(pending.lng) : null;
  if (!lat || !lng) {
    const addressParts = [
      pending.address,
      pending.postal_code,
      pending.city
    ].filter(Boolean).join(' ');
    if (addressParts) {
      try {
        const geo = await geocodeAddress(addressParts);
        if (geo) { lat = geo.lat; lng = geo.lng; }
      } catch (e) {
        console.warn('Geocoding failed:', e.message);
      }
    }
  }

  // 4. Move first image to public bucket (if any)
  let publicImageUrl = pending.image_url || null;
  if (!publicImageUrl && Array.isArray(pending.uploaded_files) && pending.uploaded_files.length) {
    const firstImage = pending.uploaded_files.find(f =>
      f.content_type?.startsWith('image/')
    );
    if (firstImage?.path) {
      publicImageUrl = await copyToPublicBucket(supabase, firstImage.path, firstImage.content_type);
    }
  }

  // 5. Build the description — fold venue_name into it since events table has no venue column
  let description = pending.description || '';
  if (pending.venue_name) {
    const venuePrefix = `Lieu : ${pending.venue_name}`;
    description = description
      ? `${venuePrefix}\n\n${description}`
      : venuePrefix;
  }

  // 6. Build the events row matching the real schema
  const eventRow = {
    title: pending.title,
    description: description || null,
    category: pending.category || 'autre',
    address: pending.address,
    city: pending.city,
    postcode: pending.postal_code,           // pending uses postal_code, events uses postcode
    country: 'France',
    starts_at: pending.starts_at,
    ends_at: pending.ends_at,
    image_url: publicImageUrl,
    price_min: pending.price_min,
    price_max: pending.price_max,
    is_free: pending.is_free,
    booking_url: pending.booking_url || pending.source_url,
    source_type: 'scraper',
    source_name: 'user_submission',
    source_url: pending.source_url,
    source_event_id: `submission-${pending.id}`,
    status: 'published',
    is_verified: true,
    is_recurring: false
  };

  // 7. PostGIS location — Supabase REST accepts WKT string for geography columns
  if (lat && lng) {
    eventRow.location = `POINT(${lng} ${lat})`;
  }

  // 8. Insert into events
  const { data: insertedEvent, error: insertErr } = await supabase
    .from('events')
    .insert(eventRow)
    .select('id')
    .single();

  if (insertErr) {
    console.error('Failed to insert event:', insertErr);
    return res.status(500).json({
      error: 'Failed to publish event',
      detail: insertErr.message
    });
  }

  // 9. Update pending row
  const { error: updateErr } = await supabase
    .from('pending_events')
    .update({
      status: 'approved',
      moderated_at: new Date().toISOString(),
      approved_event_id: insertedEvent.id,
      lat,
      lng,
      image_url: publicImageUrl
    })
    .eq('id', id);

  if (updateErr) {
    console.warn('Inserted event but failed to update pending row:', updateErr);
  }

  return res.status(200).json({
    ok: true,
    event_id: insertedEvent.id,
    image_url: publicImageUrl,
    lat, lng
  });
}

// ── Geocoder (French addresses) ────────────────────────────────────────────
async function geocodeAddress(text) {
  const url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(text)}&limit=1`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const d = await r.json();
  const f = d.features?.[0];
  if (!f) return null;
  return {
    lat: f.geometry.coordinates[1],
    lng: f.geometry.coordinates[0],
    label: f.properties.label
  };
}

// ── Copy from private to public bucket ─────────────────────────────────────
async function copyToPublicBucket(supabase, sourcePath, contentType) {
  try {
    const { data: fileData, error: dlErr } = await supabase
      .storage
      .from(PRIVATE_BUCKET)
      .download(sourcePath);
    if (dlErr || !fileData) {
      console.warn('Download from private bucket failed:', dlErr);
      return null;
    }

    const buffer = Buffer.from(await fileData.arrayBuffer());
    const { data: upload, error: upErr } = await supabase
      .storage
      .from(PUBLIC_BUCKET)
      .upload(sourcePath, buffer, {
        contentType: contentType || 'image/jpeg',
        upsert: true
      });
    if (upErr) {
      console.warn('Upload to public bucket failed:', upErr);
      return null;
    }

    const { data: pub } = supabase
      .storage
      .from(PUBLIC_BUCKET)
      .getPublicUrl(upload.path);

    return pub?.publicUrl || null;
  } catch (e) {
    console.error('copyToPublicBucket error:', e);
    return null;
  }
}
