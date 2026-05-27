// SoirFR — Recurring sources scraper
// Reads recurring_sources table and generates events for next 8 weeks

const SB_URL = 'https://ebinsidruxvbzukobshf.supabase.co';
const SB_KEY = 'sb_publishable_QSnlPXEopb6x8m8N3K396Q_YPazJ0IM';

module.exports = async function handler(req, res) {
  const CRON_SECRET = process.env.CRON_SECRET;
  if (CRON_SECRET && req.headers['authorization'] !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Fetch all active recurring sources
  const srcRes = await fetch(
    `${SB_URL}/rest/v1/recurring_sources?active=eq.true&select=*`,
    { headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` } }
  );
  const sources = await srcRes.json();
  if (!sources?.length) return res.status(200).json({ success: true, total_added: 0, message: 'No recurring sources found' });

  // Get existing recurring event IDs
  const existingRes = await fetch(
    `${SB_URL}/rest/v1/events?source_name=eq.recurring&select=source_event_id&limit=5000`,
    { headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` } }
  );
  const existing = await existingRes.json();
  const existingIds = new Set((existing || []).map(e => e.source_event_id));

  const now = new Date();
  const today = now.toISOString().split('T')[0];
  let totalAdded = 0;
  const results = [];

  for (const src of sources) {
    let added = 0;
    const events = [];

    // Generate dates for next 8 weeks
    for (let weekOffset = 0; weekOffset < 8; weekOffset++) {
      for (const dayNum of (src.schedule_days || [])) {
        const date = new Date(now);
        const currentDay = date.getDay();
        let daysUntil = (dayNum - currentDay + 7) % 7;
        if (daysUntil === 0 && weekOffset === 0) daysUntil = 7;
        date.setDate(date.getDate() + daysUntil + (weekOffset * 7));

        const dateStr = date.toISOString().split('T')[0];
        if (dateStr < today) continue;

        // Check season bounds
        if (src.season_start && dateStr < src.season_start) continue;
        if (src.season_end && dateStr > src.season_end) continue;

        const startTime = src.schedule_time_start || '09:00';
        const endTime = src.schedule_time_end || '18:00';
        const sourceId = `rec_${src.id}_${dateStr}`;

        if (existingIds.has(sourceId)) continue;

        // Build location
        const loc = (src.lat && src.lng) ? `POINT(${src.lng} ${src.lat})` : null;

        events.push({
          title: src.name,
          description: src.description || null,
          category: src.category,
          address: src.address || null,
          city: src.city || null,
          department: src.city ? null : null,
          region: 'Bourgogne-Franche-Comté',
          country: 'FR',
          location: loc,
          starts_at: `${dateStr}T${startTime}:00`,
          ends_at: `${dateStr}T${endTime}:00`,
          image_url: src.image_url || null,
          booking_url: src.booking_url || null,
          source_url: src.source_url || null,
          source_name: 'recurring',
          source_event_id: sourceId,
          status: 'active',
          scraped_at: new Date().toISOString(),
          is_free: false,
        });
        existingIds.add(sourceId);
      }
    }

    if (events.length > 0) {
      // Batch insert
      for (let i = 0; i < events.length; i += 50) {
        const batch = events.slice(i, i + 50);
        const ins = await fetch(`${SB_URL}/rest/v1/events`, {
          method: 'POST',
          headers: {
            'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`,
            'Content-Type': 'application/json', 'Prefer': 'return=minimal'
          },
          body: JSON.stringify(batch)
        });
        if (ins.ok) added += batch.length;
      }
    }

    totalAdded += added;
    results.push({ name: src.name, generated: events.length, added });
  }

  return res.status(200).json({ success: true, total_added: totalAdded, sources: results });
};
