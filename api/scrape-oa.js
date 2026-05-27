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
            source_url: ev.originAgenda?.uid ? `https://openagenda.com/agendas/${ev.originAgenda.uid}/events/${ev.slug}` : `https://openagenda.com/events/${ev.slug}-${ev.uid}`,
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

  // Job/recruitment — specific phrases only
  const junkPhrases = [
    'recrutement sans cv', 'recrute des ', 'recrute un ', 'recrutez sans',
    'manpower', 'adecco', 'france travail', 'pôle emploi',
    'job corner', 'job dating', 'job forum',
    'les mercredis de l'intérim', 'les mardis du transport',
    'mardis de l'intérim', 'mercredis de l'intérim',
    'ras interim', 'kelyps', 'interaction interim',
    'préparateur de commandes',
    'équipier de production industrielle',
    'conducteur de ligne en contrat',
    'formation en soudure', 'formation frigoriste',
    'aftral', 'keolis recrutement',
    'asimat', 'axdom', 'uimm',
    'document unique d'evaluation',
    'transfert de gros fichiers', 'les fichiers pdf',
    'découvrez facebook simplement', 'déchetterie mobile',
    'super u de ', 'u express de ',
    'poids lourd', 'conducteur de bus',
    'devenez chauffeur',
    'logistique recrutement', 'transport logistique recrutement',
    // Business/startup events
    'startbat', 'créateurs entreprise du secteur',
    'accompagnement des créateurs', 'secteur du bâtiment',
    'retouche photo', 'création d'entreprise',
    // More interim/job patterns
    'les mercredis de l'intérim', 'les mardis de l'intérim',
    'les mardis du transport', 'les mercredis du transport',
    'permanence de l'agence', 'permanence leader',
    'ras interim', 'kelyps', 'actual interim',
    'forum des métiers', 'forum emploi',
    'immersion professionnelle', 'découvrez nos métiers',
    'matinée découverte métier', 'journée découverte métier',
    // School internal events  
    'au collège ', 'du collège ', 'clg ',
    'réunion parents', 'conseil de classe',
    // Medical/admin
    'bilan de santé', 'permanence sociale',
    'permanence juridique', 'permanence administrative',
    // Social/retirement agency events
    'carsat', 'cnav', 'caf de ', 'caf du ',
    'mutualité française', 'cpam', 'urssaf',
    // Formation/training events — broad match
    ' formation ', 'de formation', 'en formation',
    'stage de ', 'atelier de formation',
    'session de formation', 'formation professionnelle',
  ];

  return junkPhrases.some(kw => t.includes(kw));
}

function mapCat(raw) {
  if(!raw) return 'patrimoine';
  const r = raw.toLowerCase();

  // Must match on WHOLE WORDS or clear phrases to avoid false positives
  if(/concert|jazz|rock|chanson|orchestre|piano|chorale|chant|fado|blues|gospel|opéra|récital|fanfare|bal |musique live|soirée musicale/.test(r)) return 'musique';
  if(/cinéma|ciné|film|projection|documentaire/.test(r)) return 'cinema';
  if(/théâtre|spectacle|comédie|danse|ballet|cirque|stand.up|one.man.show|impro/.test(r)) return 'theatre';
  if(/exposition|galerie|vernissage|peinture|sculpture|photo|exposition d|musée/.test(r)) return 'patrimoine';
  if(/enfants?|junior|jeunesse|conte|marionnette|jeune public/.test(r)) return 'enfants';
  if(/portes? ouvertes?|visite du domaine|visite de cave|visite guidée/.test(r)) return 'portes-ouvertes';
  // Degustation: only match wine/food tasting — NOT "cave" alone (too common in addresses)
  if(/dégustation|degustation|oenologie|vignoble|wine tasting|cave à vin|domaine viticole|vendanges/.test(r)) return 'degustation';
  if(/brocante|vide.grenier|vide grenier|puces|braderie/.test(r)) return 'brocante';
  if(/marché|marchés du/.test(r)) return 'marche';
  // Sport: only clear sports activities, NOT job events with transport/logistics keywords
  if(/yoga|marathon|trail|triathlon|cyclisme|natation|rugby|basket|tennis|football|volley|escalade|karaté|judo|tournoi sportif|compétition sportive|\bvélo\b|\bcycliste\b|balade vélo|vélo balade/.test(r)) return 'sport';
  if(/randonnée|balade|nature|forêt|jardin|botanique|faune|flore/.test(r)) return 'nature';
  if(/festival|fête|fête de|foire de|carnaval|kermesse/.test(r)) return 'fete';
  if(/atelier|workshop|initiation/.test(r)) return 'ateliers';
  if(/visite|patrimoine|archéol|cathédrale|abbaye|château|prieuré|médiéval/.test(r)) return 'patrimoine';
  if(/conférence|débat|causerie|colloque/.test(r)) return 'patrimoine';
  return 'patrimoine';
}
