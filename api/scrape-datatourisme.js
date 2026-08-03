// SoirFR — DATAtourisme (national open tourism data, ADN Tourisme)
// Official API rather than a scrape: the offices de tourisme, agences
// départementales and comités régionaux publish here directly, so this is the
// same material as Décibelles Data without the markup in the way.
// Licence Ouverte 2.0 — free reuse, attribution required.
const SB_URL = 'https://ebinsidruxvbzukobshf.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'sb_publishable_QSnlPXEopb6x8m8N3K396Q_YPazJ0IM';
const API = 'https://api.datatourisme.fr/v1/entertainmentAndEvent';

// Only geo_distance actually narrows the result set. The documented filters
// on department and on takesPlaceAt dates are accepted and then ignored (they
// return the unfiltered total), so date and department are applied here after
// fetching. Verified against the live API, Aug 2026.
const ZONES = [
  { dept: '71', name: 'Saône-et-Loire', lat: 46.7806, lng: 4.8531, radius: '55km' },
  { dept: '21', name: "Côte-d'Or",      lat: 47.3220, lng: 5.0415, radius: '55km' },
  { dept: '89', name: 'Yonne',          lat: 47.7980, lng: 3.5670, radius: '50km' },
  { dept: '58', name: 'Nièvre',         lat: 46.9900, lng: 3.1590, radius: '50km' },
  { dept: '39', name: 'Jura',           lat: 46.6750, lng: 5.5540, radius: '50km' },
  { dept: '25', name: 'Doubs',          lat: 47.2380, lng: 6.0240, radius: '50km' },
  { dept: '70', name: 'Haute-Saône',    lat: 47.6220, lng: 6.1550, radius: '45km' },
  { dept: '90', name: 'Belfort',        lat: 47.6380, lng: 6.8630, radius: '25km' },
];

// Departments we keep. A circle drawn around one prefecture spills into its
// neighbours, so the postcode decides what is actually stored.
const KEEP_DEPTS = new Set(ZONES.map(z => z.dept));

// page[size] is capped at 20 server-side regardless of what we ask for, so
// paging is done through meta.next. Budgets keep the function inside its time
// limit; the daily cron picks up where the volume left off.
const PAGES_PER_ZONE = 20;   // 20 pages x 20 results = up to 400 examined per zone
const ADD_BUDGET = 400;      // max new rows inserted per run
let ADDS_USED = 0;

module.exports = async function handler(req, res) {
  const CRON_SECRET = process.env.CRON_SECRET;
  const DT_KEY = process.env.DATATOURISME_API_KEY;

  if (CRON_SECRET && req.headers['authorization'] !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!DT_KEY) return res.status(500).json({ error: 'No DATATOURISME_API_KEY' });

  ADDS_USED = 0;
  const today = new Date().toISOString().split('T')[0];
  const results = [], errors = [];

  // Existing ids once per run, then checked in memory.
  const existingIds = new Set();
  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/events?source_name=eq.datatourisme&select=source_event_id&limit=20000`,
      { headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` } }
    );
    for (const e of (await r.json()) || []) existingIds.add(String(e.source_event_id));
  } catch {}

  for (const zone of ZONES) {
    if (ADDS_USED >= ADD_BUDGET) break;
    try {
      const r = await harvestZone(zone, DT_KEY, today, existingIds);
      results.push({ source: `datatourisme_${zone.dept}`, ...r });
    } catch (e) {
      errors.push({ source: `datatourisme_${zone.dept}`, error: e.message });
    }
  }

  const total_added = results.reduce((s, r) => s + (r.added || 0), 0);
  const total_found = results.reduce((s, r) => s + (r.found || 0), 0);
  return res.status(200).json({ success: true, total_added, total_found, results, errors });
};

async function harvestZone(zone, key, today, existingIds) {
  let found = 0, kept = 0, added = 0, pages = 0;
  const params = new URLSearchParams({
    geo_distance: `${zone.lat},${zone.lng},${zone.radius}`,
    fields: 'label,takesPlaceAt,isLocatedAt,hasDescription,hasMainRepresentation,offers,hasBeenCreatedBy,hasContact,lastUpdate',
    'page[size]': '20',
  });
  let url = `${API}?${params}`;
  const rows = [];

  while (url && pages < PAGES_PER_ZONE && ADDS_USED + rows.length < ADD_BUDGET) {
    const res = await fetch(url, { headers: { 'X-API-Key': key } });
    if (!res.ok) break;
    const data = await res.json();
    const objects = data.objects || [];
    if (!objects.length) break;
    pages++;
    found += objects.length;

    for (const o of objects) {
      const row = mapPoi(o, today);
      if (!row) continue;
      if (!KEEP_DEPTS.has(row.department)) continue;
      if (existingIds.has(row.source_event_id)) continue;
      if (isJunk(row.title, row.description)) continue;
      existingIds.add(row.source_event_id);
      rows.push(row);
      kept++;
    }

    url = data.meta && data.meta.next ? data.meta.next : null;
    await sleep(150);                // well inside the 10 req/s guidance
  }

  for (let i = 0; i < rows.length; i += 50) {
    if (ADDS_USED >= ADD_BUDGET) break;
    const batch = rows.slice(i, i + 50);
    const ins = await fetch(`${SB_URL}/rest/v1/events`, {
      method: 'POST',
      headers: {
        'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json', 'Prefer': 'return=minimal'
      },
      body: JSON.stringify(batch)
    });
    if (ins.ok) { added += batch.length; ADDS_USED += batch.length; }
  }

  return { found, kept, added, pages };
}

// Turn one DATAtourisme POI into an events row, or null if it is unusable.
function mapPoi(o, today) {
  const title = pickLang(o.label);
  if (!title) return null;

  // takesPlaceAt lists every occurrence of a recurring event, so take the
  // soonest one that has not finished. Nothing live means nothing to show.
  const timing = (Array.isArray(o.takesPlaceAt) ? o.takesPlaceAt : [])
    .filter(t => t && (t.endDate || t.startDate) && (t.endDate || t.startDate) >= today)
    .sort((a, b) => String(a.startDate || a.endDate).localeCompare(String(b.startDate || b.endDate)))[0];
  if (!timing || !timing.startDate) return null;

  const place = (o.isLocatedAt || [])[0] || {};
  const addr = (place.address || [])[0] || {};
  const postcode = addr.postalCode || null;
  const department = postcode ? String(postcode).slice(0, 2) : null;
  if (!department) return null;

  const lat = place.geo ? parseFloat(place.geo.latitude) : NaN;
  const lng = place.geo ? parseFloat(place.geo.longitude) : NaN;
  const location = (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0)
    ? `POINT(${lng} ${lat})` : null;

  const desc = (o.hasDescription || [])[0] || {};
  const description = (pickLang(desc.description) || pickLang(desc.shortDescription) || '')
    .replace(/\s+/g, ' ').trim().slice(0, 1000) || null;

  const price = firstPrice(o.offers);

  return {
    title: String(title).slice(0, 500),
    description,
    category: mapCat(`${title} ${description || ''} ${(o.type || []).join(' ')}`),
    address: Array.isArray(addr.streetAddress) ? addr.streetAddress[0] : (addr.streetAddress || null),
    city: addr.addressLocality || null,
    postcode,
    department,
    region: 'Bourgogne-Franche-Comté',
    country: 'FR',
    location,
    starts_at: timing.startTime ? `${timing.startDate}T${pad(timing.startTime)}` : timing.startDate,
    ends_at: timing.endDate || null,
    image_url: firstImage(o.hasMainRepresentation),
    price_min: price,
    is_free: price === 0,
    booking_url: firstHomepage(o.hasContact) || firstHomepage(o.hasBeenCreatedBy) || null,
    source_type: 'scraper',
    source_name: 'datatourisme',
    source_url: firstHomepage(o.hasContact) || firstHomepage(o.hasBeenCreatedBy) || null,
    source_event_id: String(o.uuid || o.uri || '').slice(0, 200),
    status: 'active',
    scraped_at: new Date().toISOString(),
  };
}

// Values arrive as { "@fr": "...", "@en": "..." }; French first, then anything.
function pickLang(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  return v['@fr'] || v['@en'] || Object.values(v)[0] || null;
}

function pad(t) {
  const m = String(t).match(/^(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}:00` : '00:00:00';
}

function firstPrice(offers) {
  for (const o of (offers || [])) {
    for (const p of (o.priceSpecification || [])) {
      const v = Array.isArray(p.minPrice) ? p.minPrice[0] : p.minPrice;
      const n = parseFloat(v);
      if (!isNaN(n)) return n;
    }
  }
  return null;
}

function firstImage(reps) {
  for (const r of (reps || [])) {
    for (const res of (r.hasRelatedResource || [])) {
      const loc = Array.isArray(res.locator) ? res.locator[0] : res.locator;
      if (loc) return String(loc);
    }
  }
  return null;
}

function firstHomepage(node) {
  if (!node) return null;
  const list = Array.isArray(node) ? node : [node];
  for (const n of list) {
    const hp = n && n.homepage;
    const url = Array.isArray(hp) ? hp[0] : hp;
    if (url) return String(url);
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Blocklist — reject clearly commercial/junk events ────────────────────
function isJunk(title, description) {
  if (!title) return true;
  const t = title.toLowerCase();

  const junkPhrases = [
    'recrutement sans cv', 'recrute des ', 'recrute un ', 'recrutez sans',
    'manpower', 'adecco', 'france travail', 'pôle emploi',
    'job corner', 'job dating', 'job forum',
    "mardis de l'intérim", "mercredis de l'intérim",
    'les mardis du transport', 'les mercredis du transport',
    'ras interim', 'kelyps', 'interaction interim', 'actual interim',
    "permanence de l'agence", 'permanence leader',
    'forum des métiers', 'forum emploi',
    'immersion professionnelle', 'découvrez nos métiers',
    'préparateur de commandes',
    'formation en soudure', 'formation frigoriste',
    'aftral', 'keolis recrutement',
    'bilan de santé', 'permanence sociale',
    'permanence juridique', 'permanence administrative',
    'carsat', 'cnav', 'caf de ', 'caf du ',
    'mutualité française', 'cpam', 'urssaf',
    ' formation ', 'de formation', 'en formation',
    'stage de ', 'session de formation', 'formation professionnelle',
  ];

  return junkPhrases.some(kw => t.includes(kw));
}

function mapCat(raw) {
  if (!raw) return 'patrimoine';
  const r = raw.toLowerCase();

  if (/balade enchant/.test(r)) return 'patrimoine';
  if (/\bconcert\b|\bjazz\b|\brock\b|\bchanson\b|\borchestre\b|\bpiano\b|\bchorale\b|\bchant\b|\bblues\b|\bgospel\b|\bopéra\b|\brécital\b|\bfanfare\b|musique live|soirée musicale|musicevent/.test(r)) return 'musique';
  if (/\bcinéma\b|\bciné\b|\bfilm\b|\bprojection\b|\bdocumentaire\b|screeningevent/.test(r)) return 'cinema';
  if (/\bthéâtre\b|\bspectacle\b|\bcomédie\b|\bdanse\b|\bballet\b|\bcirque\b|stand.up|theaterevent|danceevent/.test(r)) return 'theatre';
  if (/\bexposition\b|\bgalerie\b|\bvernissage\b|\bpeinture\b|\bsculpture\b|\bmusée\b|exhibitionevent/.test(r)) return 'expo';
  if (/\benfants?\b|\bjeunesse\b|\bconte\b|\bmarionnette\b|jeune public|childrensevent/.test(r)) return 'enfants';
  if (/portes? ouvertes?|visite du domaine|visite de cave|visite guidée/.test(r)) return 'portes-ouvertes';
  if (/\bdégustation\b|degustation|\boenolog|\bvignoble\b|cave à vin|domaine viticole|vendanges|millésime/.test(r)) return 'degustation';
  if (/gastronom|culinaire|\bgourmand\b|\bbanquet\b|\bbrunch\b|marché gourmand|foodevent/.test(r)) return 'gastronomie';
  if (/\bbrocante\b|vide.grenier|\bpuces\b|\bbraderie\b/.test(r)) return 'brocante';
  if (/\bmarché\b|marchés du/.test(r)) return 'marche';
  if (/\byoga\b|\bmarathon\b|\btrail\b|\btriathlon\b|\bcyclisme\b|\bnatation\b|\brugby\b|\bbasket\b|\btennis\b|\bfootball\b|\bescalade\b|\bjudo\b|tournoi sportif|sportsevent/.test(r)) return 'sport';
  if (/randonnée|\bbalade\b|\bnature\b|\bforêt\b|\bjardin\b|\bbotanique\b|bain de forêt/.test(r)) return 'nature';
  if (/\bfestival\b|\bfête\b|foire de|\bcarnaval\b|\bkermesse\b|festivalevent/.test(r)) return 'fete';
  if (/\batelier\b|\bworkshop\b|\binitiation\b|traininevent/.test(r)) return 'ateliers';
  if (/\bvisite\b|\bpatrimoine\b|\barchéol|\bcathédrale\b|\babbaye\b|\bchâteau\b|\bmédiéval\b/.test(r)) return 'patrimoine';
  if (/\bconférence\b|\bdébat\b|\bcolloque\b/.test(r)) return 'patrimoine';
  return 'patrimoine';
}
