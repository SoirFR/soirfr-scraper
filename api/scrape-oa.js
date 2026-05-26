// SoirFR — OpenAgenda only scraper (fast, <30 seconds)
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
      const params = new URLSearchParams({
        key: OA_KEY, size: 100,
        'timings[gte]': dateFrom,
        'timings[lte]': dateTo,
        'location[department]': dept,
        detailed: 1
      });
      const r = await fetch(`https://api.openagenda.com/v2/events?${params}`);
      if (!r.ok) { errors.push({ dept, status: r.status }); continue; }
      const data = await r.json();
      const events = data.events || [];
      let added = 0;
      for (const ev of events) {
        const t = ev.timings?.[0]; if (!t) continue;
        const ins = await insertEvent({
          title: ev.title?.fr || ev.title?.en || 'Événement',
          description: ev.description?.fr?.slice(0,1000),
          category: mapCat(ev.keywords?.fr?.[0] || ''),
          address: ev.location?.address,
          city: ev.location?.city,
          postcode: ev.location?.postalCode,
          department: dept,
          region: 'Bourgogne-Franche-Comté',
          lat: ev.location?.latitude,
          lng: ev.location?.longitude,
          starts_at: t.begin, ends_at: t.end,
          image_url: ev.image ? `${ev.image.base}${ev.image.filename}` : null,
          is_free: ev.conditions?.fr?.toLowerCase().includes('gratuit') || false,
          booking_url: ev.registration?.[0]?.value || null,
          source_url: `https://openagenda.com/events/${ev.slug}`,
          source_event_id: String(ev.uid),
          source_name: 'openagenda_api',
        });
        if (ins) added++;
      }
      results.push({ dept, found: events.length, added });
      await sleep(300);
    } catch(e) { errors.push({ dept, error: e.message }); }
  }

  const total_added = results.reduce((s,r) => s+(r.added||0), 0);
  const total_found = results.reduce((s,r) => s+(r.found||0), 0);
  return res.status(200).json({ success: true, total_added, total_found, results, errors });
};

async function insertEvent(ev) {
  if (!ev.title || !ev.starts_at) return false;
  if (ev.source_event_id) {
    const existing = await sbFetch(`events?source_name=eq.openagenda_api&source_event_id=eq.${ev.source_event_id}&select=id`, 'GET');
    if (existing?.length > 0) return false;
  }
  const lat = parseFloat(ev.lat), lng = parseFloat(ev.lng);
  const loc = (!isNaN(lat)&&!isNaN(lng)&&lat!==0&&lng!==0) ? `POINT(${lng} ${lat})` : null;
  return await sbFetch('events', 'POST', {
    title: String(ev.title).slice(0,500), description: ev.description||null,
    category: ev.category||'autre', address: ev.address||null,
    city: ev.city||null, postcode: ev.postcode||null,
    department: ev.department||null, region: ev.region||null, country: 'FR',
    location: loc, starts_at: ev.starts_at, ends_at: ev.ends_at||null,
    image_url: ev.image_url||null, is_free: ev.is_free||false,
    booking_url: ev.booking_url||null, source_type: 'scraper',
    source_name: ev.source_name, source_url: ev.source_url||null,
    source_event_id: ev.source_event_id||null,
    status: 'active', scraped_at: new Date().toISOString(),
  });
}

async function sbFetch(path, method='GET', body=null) {
  try {
    const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
      method, body: body ? JSON.stringify(body) : null,
      headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json', 'Prefer': method==='POST'?'return=minimal':'' }
    });
    if (method==='GET') return await res.json();
    return res.ok;
  } catch { return null; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
