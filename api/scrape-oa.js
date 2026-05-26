// SoirFR — OpenAgenda fast scraper
// Batch dedup — much faster than per-event checks
const SB_URL = 'https://ebinsidruxvbzukobshf.supabase.co';
const SB_KEY = 'sb_publishable_QSnlPXEopb6x8m8N3K396Q_YPazJ0IM';

module.exports = async function handler(req, res) {
  const CRON_SECRET = process.env.CRON_SECRET;
  const OA_KEY = process.env.OPENAGENDA_API_KEY;
  if (CRON_SECRET && req.headers['authorization'] !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!OA_KEY) return res.status(500).json({ error: 'No OA key' });

  const dateFrom = new Date().toISOString().split('T')[0];
  const dateTo = new Date(Date.now() + 60 * 86400000).toISOString().split('T')[0];
  const results = [], errors = [];

  for (const dept of ['71','21','58','89']) {
    try {
      // Fetch 100 events from OpenAgenda
      const params = new URLSearchParams({
        key: OA_KEY, size: 100,
        'timings[gte]': dateFrom,
        'timings[lte]': dateTo,
        'location[department]': dept,
        detailed: 1,
        sort: 'timings.asc',
      });
      const r = await fetch(`https://api.openagenda.com/v2/events?${params}`);
      if (!r.ok) { errors.push({ dept, status: r.status }); continue; }
      const data = await r.json();
      const events = (data.events || []).filter(ev => ev.timings?.[0]);
      if (!events.length) { results.push({ dept, found: 0, added: 0 }); continue; }

      // Batch dedup — get all existing IDs for this dept in one query
      const uids = events.map(ev => String(ev.uid));
      const existingRes = await fetch(
        `${SB_URL}/rest/v1/events?source_name=eq.openagenda_api&select=source_event_id&limit=500`,
        { headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` } }
      );
      const existing = await existingRes.json();
      const existingIds = new Set((existing || []).map(e => e.source_event_id));

      // Filter to only new events
      const newEvents = events.filter(ev => !existingIds.has(String(ev.uid)));

      // Batch insert all new events at once
      let added = 0;
      if (newEvents.length > 0) {
        const rows = newEvents.map(ev => {
          const t = ev.timings[0];
          const lat = parseFloat(ev.location?.latitude);
          const lng = parseFloat(ev.location?.longitude);
          const loc = (!isNaN(lat)&&!isNaN(lng)&&lat!==0&&lng!==0) ? `POINT(${lng} ${lat})` : null;
          return {
            title: String(ev.title?.fr || ev.title?.en || 'Événement').slice(0,500),
            description: ev.description?.fr?.slice(0,1000) || null,
            category: mapCat(ev.keywords?.fr?.[0] || ''),
            address: ev.location?.address || null,
            city: ev.location?.city || null,
            postcode: ev.location?.postalCode || null,
            department: dept,
            region: 'Bourgogne-Franche-Comté',
            country: 'FR',
            location: loc,
            starts_at: t.begin,
            ends_at: t.end || null,
            image_url: ev.image ? `${ev.image.base}${ev.image.filename}` : null,
            is_free: ev.conditions?.fr?.toLowerCase().includes('gratuit') || false,
            booking_url: ev.registration?.[0]?.value || null,
            source_type: 'scraper',
            source_name: 'openagenda_api',
            source_url: `https://openagenda.com/events/${ev.slug}`,
            source_event_id: String(ev.uid),
            status: 'active',
            scraped_at: new Date().toISOString(),
          };
        });

        // Insert in batches of 50
        for (let i = 0; i < rows.length; i += 50) {
          const batch = rows.slice(i, i + 50);
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

      results.push({ dept, found: events.length, new: newEvents.length, added });
    } catch(e) { errors.push({ dept, error: e.message }); }
  }

  const total_added = results.reduce((s,r) => s+(r.added||0), 0);
  const total_found = results.reduce((s,r) => s+(r.found||0), 0);
  return res.status(200).json({ success: true, total_added, total_found, results, errors });
};

function mapCat(raw) {
  if (!raw) return 'autre'; const r = raw.toLowerCase();
  if (/concert|musique|jazz|rock|chanson|chant/.test(r)) return 'musique';
  if (/cin[eé]|film|projection/.test(r)) return 'cinema';
  if (/th[eé][aâ]tre|spectacle|danse|ballet/.test(r)) return 'theatre';
  if (/expo|exposition|galerie|mus[eé]e|vernissage/.test(r)) return 'expo';
  if (/enfant|famille|jeun|conte/.test(r)) return 'enfants';
  if (/portes.ouvertes|visite.cave|visite.domaine/.test(r)) return 'portes-ouvertes';
  if (/d[eé]gustation|vin\b|cave|vignoble|terroir/.test(r)) return 'degustation';
  if (/brocante|vide.grenier|puces/.test(r)) return 'brocante';
  if (/march[eé]/.test(r)) return 'marche';
  if (/sport|foot|tennis|marathon|yoga|v[eé]lo/.test(r)) return 'sport';
  if (/rando|nature|balade|for[eê]t|jardin/.test(r)) return 'nature';
  if (/festival|f[eê]te|fete|carnaval/.test(r)) return 'fete';
  if (/conf[eé]rence|d[eé]bat|atelier|formation/.test(r)) return 'conference';
  return 'autre';
}
