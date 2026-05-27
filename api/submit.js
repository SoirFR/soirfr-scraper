// /api/submit.js
// Receives user submissions from /submit.html
// - Parses multipart form data (submitter info, event details, file uploads)
// - Uploads files to Supabase Storage bucket "submissions"
// - If any image/PDF files attached, sends them to Claude Vision to extract event info
// - Merges Vision-extracted data with user-provided fields (user wins on conflict)
// - Inserts row into pending_events table
// - Returns success JSON

import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'crypto';
import { extractFromFiles } from '../lib/vision.js';
import { parseMultipart } from '../lib/multipart.js';

// Vercel serverless config — increase body size and time for file uploads
export const config = {
  api: {
    bodyParser: false,        // we parse multipart manually
    responseLimit: false
  },
  maxDuration: 60             // up to 60s for Vision calls
};

// CORS — allow soirfr.com (frontend) to POST here
function setCors(res, origin) {
  const allowed = [
    'https://www.soirfr.com',
    'https://soirfr.com',
    'http://localhost:3000',  // local dev
    'http://localhost:8080'
  ];
  if (allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', 'https://www.soirfr.com');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // ── 1. Parse multipart form ─────────────────────────────────────────
    const { fields, files } = await parseMultipart(req);

    let submitter, eventData;
    try {
      submitter = JSON.parse(fields.submitter || '{}');
      eventData = JSON.parse(fields.event || '{}');
    } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON in form fields' });
    }

    // ── 2. Validate submitter (name + email required) ──────────────────
    if (!submitter.name || typeof submitter.name !== 'string' || !submitter.name.trim()) {
      return res.status(400).json({ error: 'submitter.name is required' });
    }
    if (!submitter.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(submitter.email)) {
      return res.status(400).json({ error: 'submitter.email is required and must be valid' });
    }

    // ── 3. Validate at least file OR some content ──────────────────────
    const hasFiles = Array.isArray(files) && files.length > 0;
    const hasContent = eventData.title || eventData.city || eventData.venue_name;
    if (!hasFiles && !hasContent) {
      return res.status(400).json({
        error: 'Provide at least one file or some event details (title, city, or venue)'
      });
    }

    // ── 4. Connect to Supabase ─────────────────────────────────────────
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } }
    );

    // ── 5. Upload files to Supabase Storage ────────────────────────────
    const uploadedFiles = [];
    if (hasFiles) {
      const submissionId = randomUUID();
      for (const f of files) {
        // Skip files larger than 20 MB
        if (f.size > 20 * 1024 * 1024) {
          console.warn(`Skipping ${f.filename} — too large (${f.size} bytes)`);
          continue;
        }
        // Sanitize filename: keep extension, replace rest with UUID
        const ext = (f.filename.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
        const safeName = `${submissionId}/${randomUUID()}${ext}`;

        const { data: upload, error: uploadErr } = await supabase
          .storage
          .from('submissions')
          .upload(safeName, f.data, {
            contentType: f.contentType || 'application/octet-stream',
            upsert: false
          });

        if (uploadErr) {
          console.error('Upload failed:', uploadErr);
          continue;
        }

        uploadedFiles.push({
          path: upload.path,
          original_name: f.filename,
          content_type: f.contentType,
          size: f.size
        });
      }
    }

    // ── 6. Call Vision on attached files (if any) ──────────────────────
    let visionData = null;
    let visionUsed = false;
    if (hasFiles && process.env.ANTHROPIC_API_KEY) {
      try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        visionData = await extractFromFiles(anthropic, files);
        visionUsed = true;
      } catch (e) {
        console.error('Vision extraction failed:', e.message);
        // Don't fail the submission — moderator can still process it manually
      }
    }

    // ── 7. Merge: user fields take precedence over Vision ──────────────
    const merged = mergeEventData(eventData, visionData);

    // ── 8. Insert into pending_events ──────────────────────────────────
    const row = {
      submitter_name: submitter.name.trim(),
      submitter_email: submitter.email.trim().toLowerCase(),
      submitter_phone: submitter.phone?.trim() || null,
      submitter_org: submitter.organization?.trim() || null,

      title: merged.title,
      description: merged.description,
      starts_at: merged.starts_at,
      ends_at: merged.ends_at,
      category: merged.category,
      venue_name: merged.venue_name,
      address: merged.address,
      postal_code: merged.postal_code,
      city: merged.city,
      price_text: merged.price_text,
      price_min: merged.price_min,
      price_max: merged.price_max,
      is_free: merged.is_free,
      source_url: merged.source_url,
      booking_url: merged.booking_url,

      uploaded_files: uploadedFiles,
      vision_raw: visionData,
      vision_used: visionUsed,

      status: 'pending',
      submitted_at: new Date().toISOString(),
      submitted_ip: getClientIp(req),
      user_agent: req.headers['user-agent']?.substring(0, 500) || null
    };

    const { data: inserted, error: insertErr } = await supabase
      .from('pending_events')
      .insert(row)
      .select('id')
      .single();

    if (insertErr) {
      console.error('DB insert failed:', insertErr);
      return res.status(500).json({ error: 'Failed to save submission' });
    }

    // ── 9. Done ────────────────────────────────────────────────────────
    return res.status(200).json({
      ok: true,
      id: inserted.id,
      files_uploaded: uploadedFiles.length,
      vision_used: visionUsed
    });

  } catch (err) {
    console.error('Submit handler error:', err);
    return res.status(500).json({
      error: 'Internal server error',
      detail: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || null;
}

/**
 * Merge user-provided form data with Vision-extracted data.
 * User fields always win when present (non-empty). Vision fills the gaps.
 *
 * eventData = what the user typed in the form
 * visionData = { events: [...] } from Claude Vision (first event used)
 */
function mergeEventData(eventData, visionData) {
  const vision = (visionData?.events?.[0]) || {};
  const pick = (userVal, visionVal) => {
    if (userVal !== null && userVal !== undefined && userVal !== '') return userVal;
    return visionVal ?? null;
  };

  // Compute is_free / price_min from price_text if user gave one
  const priceText = pick(eventData.price_text, vision.price_text);
  let isFree = null, priceMin = null, priceMax = null;
  if (priceText) {
    const t = priceText.toLowerCase();
    if (/(gratuit|libre|free|entrée libre)/i.test(t)) isFree = true;
    const nums = (priceText.match(/(\d+(?:[.,]\d+)?)/g) || [])
      .map(n => parseFloat(n.replace(',', '.')));
    if (nums.length === 1) priceMin = nums[0];
    if (nums.length >= 2) { priceMin = Math.min(...nums); priceMax = Math.max(...nums); }
    if (priceMin === 0) isFree = true;
  }
  // Vision-extracted price values override the parsed ones only if user didn't provide text
  if (!eventData.price_text) {
    if (vision.is_free !== undefined && vision.is_free !== null) isFree = vision.is_free;
    if (vision.price_min !== undefined && vision.price_min !== null) priceMin = vision.price_min;
    if (vision.price_max !== undefined && vision.price_max !== null) priceMax = vision.price_max;
  }

  return {
    title:        pick(eventData.title,        vision.title),
    description:  pick(eventData.description,  vision.description),
    starts_at:    pick(eventData.starts_at,    vision.starts_at),
    ends_at:      pick(eventData.ends_at,      vision.ends_at),
    category:     pick(eventData.category,     vision.category),
    venue_name:   pick(eventData.venue_name,   vision.venue_name),
    address:      pick(eventData.address,      vision.address),
    postal_code:  pick(eventData.postal_code,  vision.postal_code),
    city:         pick(eventData.city,         vision.city),
    price_text:   priceText,
    price_min:    priceMin,
    price_max:    priceMax,
    is_free:      isFree,
    source_url:   pick(eventData.source_url,   vision.source_url),
    booking_url:  pick(eventData.booking_url,  vision.booking_url || vision.website)
  };
}
