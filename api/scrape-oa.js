// SoirFR — OpenAgenda scraper with geographic bounding box
// Uses lat/lng coordinates to ensure only real Burgundy events are pulled
const SB_URL = 'https://ebinsidruxvbzukobshf.supabase.co';
const SB_KEY = 'sb_publishable_QSnlPXEopb6x8m8N3K396Q_YPazJ0IM';

// Burgundy bounding box — tight around BFC region
const REGIONS = [
  { name: 'Saône-et-Loire',  latMin: 46.15, latMax: 47.10, lngMin: 3.90, lngMax: 5.40, dept: '71' },
  { name: 'Côte-d\'Or',      latMin: 46.90, latMax: 47.95, lngMin: 4.00, lngMax: 5.60, dept: '21' },
  { name: 'Nièvre',          latMin: 46.55, latMax: 47.60, lngMin: 2.90, lngMax: 4.20, dept: '58' },
  { name: 'Yonne',           latMin: 47.30, latMax: 48.40, lngMin: 2.80, lngMax: 4.40, dept: '89' },
];

module.exports = async function handler(req, res) {
  const CRON_SECRET = process.env.CRON_SECRET;
  const OA_KEY = process.env.OPENAGENDA_API_KEY;
  if (CRON_SECRET && req.headers['authorization'] !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!OA_KEY) return res.status(500).json({ error: 'No OA key' });

  // Start from day after latest stored event
  let dateFrom = new Date().toISOString().split('T')[0];
  try {
    const latestRes = await fetch(
      `${SB_URL}/rest/v1/events?source_name=eq.openagenda_api&select=starts_at&order=starts_at.desc&limit=1`,
      { headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` } }
    );
    const latest = await latestRes.json();
    if (latest?.[0]?.starts_at) {
      const d = new Date(latest[0].starts_at);
      d.setDate(d.getDate() + 1);
      dateFrom = d.toISOString().split('T')[0];
    }
  } catch {}
  const dateTo = new Date(Date.now() + 365 * 86400000).toISOString().split('T')[0];
  const results = [], errors = [];

  // Get existing IDs once for batch dedup
  const existingRes = await fetch(
    `${SB_URL}/rest/v1/events?source_name=eq.openagenda_api&select=source_event_id&limit=2000`,
    { headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` } }
  );
  const existing = await existingRes.json();
  const existingIds = new Set((existing || []).map(e => e.source_event_id));

  for (const region of REGIONS) {
    try {
      // Use geographic bounding box — guarantees events are physically in Burgundy
      const params = new URLSearchParams({
        key: OA_KEY,
        size: 100,
        'timings[gte]': dateFrom,
        'timings[lte]': dateTo,
        'geo[northEast][lat]': region.latMax,
        'geo[northEast][lng]': region.lngMax,
        'geo[southWest][lat]': region.latMin,
        'geo[southWest][lng]': region.lngMin,
        detailed: 1,
        sort: 'timings.asc',
      });

      const r = await fetch(`https://api.openagenda.com/v2/events?${params}`);
      if (!r.ok) { errors.push({ region: region.name, status: r.status }); continue; }
      const data = await r.json();
      const events = (data.events || []).filter(ev => ev.timings?.[0]);
      if (!events.length) { results.push({ region: region.name, found: 0, added: 0 }); continue; }

      // Filter to only new events
      const newEvents = events.filter(ev => !existingIds.has(String(ev.uid)));

      let added = 0;
      if (newEvents.length > 0) {
        // Filter out junk events before building rows
        const cleanEvents = newEvents.filter(ev => 
          !isJunk(ev.title?.fr || ev.title?.en || '', ev.description?.fr || '')
        );

        const rows = cleanEvents.map(ev => {
          const t = ev.timings[0];
          const lat = parseFloat(ev.location?.latitude);
          const lng = parseFloat(ev.location?.longitude);
          // Double-check coords are actually within Burgundy bounding box
          const inRegion = lat >= region.latMin && lat <= region.latMax &&
                           lng >= region.lngMin && lng <= region.lngMax;
          const loc = (inRegion) ? `POINT(${lng} ${lat})` : null;
          // Add to existingIds to avoid dupes within same run
          existingIds.add(String(ev.uid));
          return {
            title: String(ev.title?.fr || ev.title?.en || 'Événement').slice(0, 500),
            description: ev.description?.fr?.slice(0, 1000) || null,
            category: mapCat(ev.keywords?.fr?.[0] || ''),
            address: ev.location?.address || null,
            city: ev.location?.city || null,
            postcode: ev.location?.postalCode || null,
            department: region.dept,
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
        }).filter(r => r !== null && r.location !== null); // only insert if we have real coords

        // Batch insert
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

      results.push({ region: region.name, found: events.length, new: newEvents.length, added });
    } catch(e) { errors.push({ region: region.name, error: e.message }); }
  }

  const total_added = results.reduce((s,r) => s+(r.added||0), 0);
  const total_found = results.reduce((s,r) => s+(r.found||0), 0);
  return res.status(200).json({ success: true, total_added, total_found, dateFrom, results, errors });
};

// ── Blocklist — reject clearly commercial/junk events ────────────────────
function isJunk(title, description) {
  if (!title) return true;
  const t = title.toLowerCase();

  // Unambiguous job/recruitment events
  const junkTerms = [
    // Recruitment platforms and agencies
    'manpower', 'adecco', 'france travail', 'pôle emploi',
    'job corner', 'job dating', 'job forum',
    // Clearly job-focused titles
    'recrutement sans cv', 'recrutez sans cv',
    'découvrez les métiers de l'armée',
    'présentation des métiers de l'armée',
    'préparateur de commandes',
    'équipier de production industrielle',
    'conducteur de ligne en contrat',
    'formation en soudure',
    'formation frigoriste',
    'formation agent d'accueil',
    // Specific junk orgs
    'uimm', 'asimat', 'axdom', 'plie ',
    // Admin/bureaucratic junk
    'document unique d'evaluation des risques',
    'transfert de gros fichiers',
    'les fichiers pdf',
    'découvrez facebook simplement',
    'déchetterie mobile',
    // Supermarket promos — only very specific brand names
    'super u de ', 'u express ', 'u express de ',
  ];

  return junkTerms.some(kw => t.includes(kw));
}

function mapCat(raw) {
  if (!raw) return 'expo'; const r = raw.toLowerCase();
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
  return 'expo';
}
