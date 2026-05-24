// SoirFR — Burgundy Scraper v5
// 25+ sources covering all of Saône-et-Loire, Côte-d'Or and wider Burgundy

const SB_URL = 'https://ebinsidruxvbzukobshf.supabase.co';
const SB_KEY = 'sb_publishable_QSnlPXEopb6x8m8N3K396Q_YPazJ0IM';

module.exports = async function handler(req, res) {
  const CRON_SECRET = process.env.CRON_SECRET;
  const OA_KEY = process.env.OPENAGENDA_API_KEY;
  const TM_KEY = process.env.TICKETMASTER_API_KEY;

  const auth = req.headers['authorization'];
  if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const results = [];
  const errors = [];
  const dateFrom = new Date().toISOString().split('T')[0];
  const dateTo = new Date(Date.now() + 60 * 86400000).toISOString().split('T')[0];

  // ── TIER 1: OpenAgenda public JSON feeds (no key needed) ─────────────────
  const OA_AGENDAS = [
    { slug: 'bourgogne-tourisme',            name: 'Bourgogne Tourisme',           dept: null, region: 'Bourgogne-Franche-Comté' },
    { slug: 'destination-saone-et-loire',    name: 'Destination Saône-et-Loire',   dept: '71', region: 'Bourgogne-Franche-Comté' },
    { slug: 'agenda-saone-et-loire',         name: 'Agenda Saône-et-Loire',        dept: '71', region: 'Bourgogne-Franche-Comté' },
    { slug: 'tourisme-beaune-cote-et-sud',   name: 'OT Beaune Côte et Sud',        dept: '21', region: 'Bourgogne-Franche-Comté' },
    { slug: 'cluny-sud-bourgogne-tourisme',  name: 'OT Cluny Sud Bourgogne',       dept: '71', region: 'Bourgogne-Franche-Comté' },
    { slug: 'macon-tourisme',                name: 'OT Mâcon',                     dept: '71', region: 'Bourgogne-Franche-Comté' },
    { slug: 'chalon-sur-saone-tourisme',     name: 'OT Chalon-sur-Saône',          dept: '71', region: 'Bourgogne-Franche-Comté' },
    { slug: 'autun-morvan-tourisme',         name: 'OT Autun Morvan',              dept: '71', region: 'Bourgogne-Franche-Comté' },
    { slug: 'creusot-montceau-tourisme',     name: 'OT Creusot Montceau',          dept: '71', region: 'Bourgogne-Franche-Comté' },
    { slug: 'tourisme-saone-et-grosne',      name: 'Tourisme Saône et Grosne',     dept: '71', region: 'Bourgogne-Franche-Comté' },
    { slug: 'pays-charolais-brionnais',      name: 'Pays Charolais-Brionnais',     dept: '71', region: 'Bourgogne-Franche-Comté' },
    { slug: 'sud-bourgogne-tourisme',        name: 'Sud Bourgogne Tourisme',       dept: '71', region: 'Bourgogne-Franche-Comté' },
    { slug: 'tourisme-sud-cote-chalonnaise', name: 'Sud Côte Chalonnaise',         dept: '71', region: 'Bourgogne-Franche-Comté' },
    { slug: 'verts-vallons-sud-bourgogne',   name: 'Verts Vallons Sud Bourgogne',  dept: '71', region: 'Bourgogne-Franche-Comté' },
    { slug: 'agenda-culturel-71',            name: 'Agenda Culturel 71',           dept: '71', region: 'Bourgogne-Franche-Comté' },
    { slug: 'sortez-chez-vous-bourgogne',    name: 'Sortez Chez Vous Bourgogne',   dept: null, region: 'Bourgogne-Franche-Comté' },
    { slug: 'eterritoire-bfc',               name: 'eTerritoire BFC',              dept: null, region: 'Bourgogne-Franche-Comté' },
    { slug: 'agenda-du-morvan',              name: 'Agenda du Morvan',             dept: null, region: 'Bourgogne-Franche-Comté' },
    { slug: 'infolocale-saone-et-loire',     name: 'Infolocale Saône-et-Loire',    dept: '71', region: 'Bourgogne-Franche-Comté' },
    { slug: 'sabradou-bourgogne',            name: 'Sabradou Bourgogne',           dept: null, region: 'Bourgogne-Franche-Comté' },
  ];

  for (const agenda of OA_AGENDAS) {
    try {
      const result = await scrapeOpenAgendaPublic(agenda, dateFrom, dateTo);
      results.push(result);
    } catch (e) {
      errors.push({ source: agenda.name, error: e.message });
    }
    await sleep(400);
  }

  // ── TIER 2: OpenAgenda API geographic search ──────────────────────────────
  if (OA_KEY) {
    try {
      results.push(await scrapeOpenAgendaAPI(OA_KEY, dateFrom, dateTo));
    } catch (e) {
      errors.push({ source: 'openagenda_api', error: e.message });
    }
  }

  // ── TIER 3: JDS Saône-et-Loire ────────────────────────────────────────────
  try { results.push(await scrapeJDS(dateFrom)); }
  catch (e) { errors.push({ source: 'jds', error: e.message }); }

  // ── TIER 4: Brocabrac (depts 71 + 21) ────────────────────────────────────
  try { results.push(await scrapeBrocabrac(['71','21'], dateFrom)); }
  catch (e) { errors.push({ source: 'brocabrac', error: e.message }); }

  // ── TIER 5: Vide-Greniers.org ─────────────────────────────────────────────
  try { results.push(await scrapeVideGreniers('71', dateFrom)); }
  catch (e) { errors.push({ source: 'vide_greniers', error: e.message }); }

  // ── TIER 6: Destination Saône-et-Loire direct ────────────────────────────
  try { results.push(await scrapeDestinationSaoneLoire(dateFrom)); }
  catch (e) { errors.push({ source: 'destination_71', error: e.message }); }

  // ── TIER 7: Ticketmaster BFC ──────────────────────────────────────────────
  if (TM_KEY) {
    try { results.push(await scrapeTicketmaster(TM_KEY, dateFrom, dateTo)); }
    catch (e) { errors.push({ source: 'ticketmaster', error: e.message }); }
  }

  const total_added = results.reduce((s,r) => s+(r.added||0), 0);
  const total_found = results.reduce((s,r) => s+(r.found||0), 0);

  await sbFetch('scrape_logs', 'POST', {
    source_name: 'burgundy_all',
    finished_at: new Date().toISOString(),
    events_found: total_found,
    events_added: total_added,
    status: errors.length === 0 ? 'success' : 'partial',
    error_message: errors.length ? JSON.stringify(errors) : null,
  });

  return res.status(200).json({ success: true, total_added, total_found, results, errors });
};

// ── OpenAgenda public JSON feed ───────────────────────────────────────────
async function scrapeOpenAgendaPublic(agenda, dateFrom, dateTo) {
  const url = `https://openagenda.com/agendas/${agenda.slug}/events.json?` +
    `oaq[after]=${dateFrom}&oaq[before]=${dateTo}&lang=fr&size=100`;
  const res = await fetch(url, { headers: { 'User-Agent': 'SoirFR/1.0', 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const events = data.events || data.items || [];
  let added = 0;
  for (const ev of events) {
    const timing = ev.timings?.[0];
    const startDate = timing?.begin || ev.firstDate;
    if (!startDate) continue;
    const inserted = await insertEvent({
      title: ev.title?.fr || ev.title?.en || ev.title || 'Événement',
      description: (ev.description?.fr || ev.description || '').slice(0, 1000),
      category: mapCategory(ev.keywords?.fr?.join(' ') || ev.tags?.join(' ') || ''),
      address: ev.location?.address || ev.place?.address,
      city: ev.location?.city || ev.place?.city,
      postcode: ev.location?.postalCode || ev.place?.postalCode,
      department: agenda.dept,
      region: agenda.region,
      lat: ev.location?.latitude || ev.place?.latitude,
      lng: ev.location?.longitude || ev.place?.longitude,
      starts_at: startDate,
      ends_at: timing?.end || ev.lastDate,
      image_url: ev.image?.filename ? `https://cibul.s3.amazonaws.com/${ev.image.filename}` : ev.thumbnail,
      is_free: ev.conditions?.fr?.toLowerCase().includes('gratuit') || ev.free === true,
      booking_url: ev.registration?.[0]?.value || ev.ticketingUrl,
      source_url: `https://openagenda.com/agendas/${agenda.slug}/events/${ev.slug||ev.uid}`,
      source_event_id: String(ev.uid || ev.id || ev.slug),
      source_name: `oa_${agenda.slug}`,
    });
    if (inserted) added++;
  }
  return { source: agenda.name, found: events.length, added };
}

// ── OpenAgenda API geographic ─────────────────────────────────────────────
async function scrapeOpenAgendaAPI(key, dateFrom, dateTo) {
  const events = [];
  for (const dept of ['71','21','58','89']) {
    const params = new URLSearchParams({ key, size: 100, 'timings[gte]': dateFrom, 'timings[lte]': dateTo, 'location[department]': dept, detailed: 1 });
    const res = await fetch(`https://api.openagenda.com/v2/events?${params}`);
    if (res.ok) { const d = await res.json(); events.push(...(d.events||[])); }
    await sleep(300);
  }
  let added = 0;
  for (const ev of events) {
    const timing = ev.timings?.[0];
    if (!timing) continue;
    const ins = await insertEvent({
      title: ev.title?.fr || ev.title?.en || 'Événement',
      description: ev.description?.fr?.slice(0,1000),
      category: mapCategory(ev.keywords?.fr?.[0] || ''),
      address: ev.location?.address,
      city: ev.location?.city,
      postcode: ev.location?.postalCode,
      department: ev.location?.department,
      region: 'Bourgogne-Franche-Comté',
      lat: ev.location?.latitude,
      lng: ev.location?.longitude,
      starts_at: timing.begin,
      ends_at: timing.end,
      image_url: ev.image ? ev.image.base + ev.image.filename : null,
      is_free: ev.conditions?.fr?.toLowerCase().includes('gratuit')||false,
      booking_url: ev.registration?.[0]?.value||null,
      source_url: `https://openagenda.com/events/${ev.slug}`,
      source_event_id: String(ev.uid),
      source_name: 'openagenda_api',
    });
    if (ins) added++;
  }
  return { source: 'OpenAgenda API', found: events.length, added };
}

// ── JDS Saône-et-Loire ────────────────────────────────────────────────────
async function scrapeJDS(dateFrom) {
  const urls = [
    'https://www.jds.fr/saone-et-loire/agenda/',
    'https://www.jds.fr/saone-et-loire/agenda/concerts/',
    'https://www.jds.fr/saone-et-loire/agenda/expos/',
    'https://www.jds.fr/saone-et-loire/agenda/spectacles/',
    'https://www.jds.fr/saone-et-loire/agenda/brocantes/',
    'https://www.jds.fr/saone-et-loire/agenda/marches/',
  ];
  let added = 0, found = 0;
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'SoirFR/1.0' } });
      if (!res.ok) continue;
      const html = await res.text();
      const jsonLdMatches = html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi);
      for (const match of jsonLdMatches) {
        try {
          const items = [].concat(JSON.parse(match[1]));
          for (const item of items) {
            if (item['@type'] !== 'Event') continue;
            found++;
            if (item.startDate && item.startDate < dateFrom) continue;
            const ins = await insertEvent({
              title: item.name,
              description: item.description?.slice(0,1000),
              category: mapCategory(item.name+' '+(item.description||'')),
              address: item.location?.address?.streetAddress,
              city: item.location?.address?.addressLocality,
              postcode: item.location?.address?.postalCode,
              department: '71',
              region: 'Bourgogne-Franche-Comté',
              lat: item.location?.geo?.latitude,
              lng: item.location?.geo?.longitude,
              starts_at: item.startDate,
              ends_at: item.endDate,
              image_url: item.image,
              is_free: item.isAccessibleForFree===true,
              booking_url: item.url,
              source_url: item.url,
              source_event_id: item.url||item.name,
              source_name: 'jds_saone_et_loire',
            });
            if (ins) added++;
          }
        } catch {}
      }
      await sleep(500);
    } catch {}
  }
  return { source: 'JDS Saône-et-Loire', found, added };
}

// ── Brocabrac ─────────────────────────────────────────────────────────────
async function scrapeBrocabrac(depts, dateFrom) {
  let added = 0, found = 0;
  for (const dept of depts) {
    try {
      const res = await fetch(`https://www.brocabrac.fr/${dept}/`, { headers: { 'User-Agent': 'SoirFR/1.0' } });
      if (!res.ok) continue;
      const html = await res.text();
      const jsonLdMatches = html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi);
      for (const match of jsonLdMatches) {
        try {
          const items = [].concat(JSON.parse(match[1]));
          for (const item of items) {
            if (!String(item['@type']).includes('Event')) continue;
            found++;
            const ins = await insertEvent({
              title: item.name||'Brocante / Vide-grenier',
              description: item.description?.slice(0,500),
              category: 'brocante',
              address: item.location?.address?.streetAddress,
              city: item.location?.address?.addressLocality,
              postcode: item.location?.address?.postalCode,
              department: dept,
              region: 'Bourgogne-Franche-Comté',
              lat: item.location?.geo?.latitude,
              lng: item.location?.geo?.longitude,
              starts_at: item.startDate,
              ends_at: item.endDate,
              source_url: item.url||`https://www.brocabrac.fr/${dept}/`,
              source_event_id: item.url||item.name,
              source_name: 'brocabrac',
            });
            if (ins) added++;
          }
        } catch {}
      }
      await sleep(600);
    } catch {}
  }
  return { source: 'Brocabrac', found, added };
}

// ── Vide-Greniers.org ─────────────────────────────────────────────────────
async function scrapeVideGreniers(dept) {
  const url = `https://www.vide-greniers.org/${dept}-Saone-et-Loire.htm`;
  let added = 0, found = 0;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'SoirFR/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const jsonLdMatches = html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi);
    for (const match of jsonLdMatches) {
      try {
        const items = [].concat(JSON.parse(match[1]));
        for (const item of items) {
          if (item['@type'] !== 'Event') continue;
          found++;
          const ins = await insertEvent({
            title: item.name||'Vide-grenier',
            category: 'brocante',
            address: item.location?.address?.streetAddress,
            city: item.location?.address?.addressLocality,
            postcode: item.location?.address?.postalCode,
            department: dept,
            region: 'Bourgogne-Franche-Comté',
            lat: item.location?.geo?.latitude,
            lng: item.location?.geo?.longitude,
            starts_at: item.startDate,
            ends_at: item.endDate,
            source_url: item.url||url,
            source_event_id: item.url||item.name,
            source_name: 'vide_greniers',
          });
          if (ins) added++;
        }
      } catch {}
    }
  } catch {}
  return { source: 'Vide-Greniers.org', found, added };
}

// ── Destination Saône-et-Loire ────────────────────────────────────────────
async function scrapeDestinationSaoneLoire() {
  const url = 'https://www.destination-saone-et-loire.fr/fr/les-evenements-en-saone-et-loire.html';
  let added = 0, found = 0;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'SoirFR/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const jsonLdMatches = html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi);
    for (const match of jsonLdMatches) {
      try {
        const schema = JSON.parse(match[1]);
        const items = [].concat(schema['@graph']||schema);
        for (const item of items) {
          if (item['@type'] !== 'Event') continue;
          found++;
          const ins = await insertEvent({
            title: item.name,
            description: item.description?.slice(0,1000),
            category: mapCategory(item.name+' '+(item.description||'')),
            address: item.location?.address?.streetAddress,
            city: item.location?.address?.addressLocality,
            postcode: item.location?.address?.postalCode,
            department: '71',
            region: 'Bourgogne-Franche-Comté',
            lat: item.location?.geo?.latitude,
            lng: item.location?.geo?.longitude,
            starts_at: item.startDate,
            ends_at: item.endDate,
            image_url: Array.isArray(item.image)?item.image[0]:item.image,
            is_free: item.isAccessibleForFree,
            booking_url: item.url,
            source_url: item.url||url,
            source_event_id: item.url||item.name,
            source_name: 'destination_saone_et_loire',
          });
          if (ins) added++;
        }
      } catch {}
    }
  } catch {}
  return { source: 'Destination Saône-et-Loire', found, added };
}

// ── Ticketmaster ──────────────────────────────────────────────────────────
async function scrapeTicketmaster(key, dateFrom, dateTo) {
  const params = new URLSearchParams({
    apikey: key, countryCode: 'FR',
    startDateTime: new Date(dateFrom).toISOString().replace('.000',''),
    endDateTime: new Date(dateTo).toISOString().replace('.000',''),
    size: 100, sort: 'date,asc',
    city: 'Mâcon,Chalon-sur-Saône,Dijon,Beaune,Autun',
  });
  const res = await fetch(`https://app.ticketmaster.com/discovery/v2/events.json?${params}`);
  if (!res.ok) return { source: 'Ticketmaster', found: 0, added: 0 };
  const data = await res.json();
  const events = data?._embedded?.events||[];
  let added = 0;
  for (const ev of events) {
    const venue = ev._embedded?.venues?.[0];
    const price = ev.priceRanges?.[0];
    const date = ev.dates?.start;
    const ins = await insertEvent({
      title: ev.name,
      description: ev.info?.slice(0,1000),
      category: mapCategory(ev.classifications?.[0]?.segment?.name||''),
      address: venue?.address?.line1,
      city: venue?.city?.name,
      postcode: venue?.postalCode,
      region: 'Bourgogne-Franche-Comté',
      lat: parseFloat(venue?.location?.latitude)||null,
      lng: parseFloat(venue?.location?.longitude)||null,
      starts_at: date?.dateTime||date?.localDate,
      image_url: ev.images?.find(i=>i.ratio==='16_9'&&i.width>500)?.url,
      price_min: price?.min,
      price_max: price?.max,
      is_free: price?.min===0,
      booking_url: ev.url,
      source_url: ev.url,
      source_event_id: ev.id,
      source_name: 'ticketmaster_france',
    });
    if (ins) added++;
  }
  return { source: 'Ticketmaster', found: events.length, added };
}

// ── Core helpers ──────────────────────────────────────────────────────────
async function insertEvent(ev) {
  if (!ev.title||!ev.starts_at) return false;
  if (ev.source_event_id&&ev.source_name) {
    const existing = await sbFetch(`events?source_name=eq.${encodeURIComponent(ev.source_name)}&source_event_id=eq.${encodeURIComponent(ev.source_event_id)}&select=id`,'GET');
    if (existing?.length>0) return false;
  }
  const lat=parseFloat(ev.lat),lng=parseFloat(ev.lng);
  const loc=(!isNaN(lat)&&!isNaN(lng)&&lat!==0&&lng!==0)?`POINT(${lng} ${lat})`:null;
  return await sbFetch('events','POST',{
    title: ev.title.slice(0,500),
    description: ev.description||null,
    category: ev.category||'autre',
    address: ev.address||null,
    city: ev.city||null,
    postcode: ev.postcode||null,
    department: ev.department||null,
    region: ev.region||null,
    location: loc,
    starts_at: ev.starts_at,
    ends_at: ev.ends_at||null,
    image_url: ev.image_url||null,
    price_min: ev.price_min??null,
    price_max: ev.price_max??null,
    is_free: ev.is_free||false,
    booking_url: ev.booking_url||null,
    source_type: 'scraper',
    source_name: ev.source_name,
    source_url: ev.source_url||null,
    source_event_id: ev.source_event_id||null,
    status: 'active',
    scraped_at: new Date().toISOString(),
  });
}

async function sbFetch(path,method='GET',body=null) {
  const url=`${SB_URL}/rest/v1/${path}`;
  const headers={'apikey':SB_KEY,'Authorization':`Bearer ${SB_KEY}`,'Content-Type':'application/json','Prefer':method==='POST'?'return=minimal':''};
  try {
    const res=await fetch(url,{method,headers,body:body?JSON.stringify(body):null});
    if(method==='GET')return await res.json();
    return res.ok;
  } catch {return null;}
}

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

function mapCategory(raw) {
  if(!raw)return 'autre';
  const r=raw.toLowerCase();
  if(/concert|musique|music|jazz|rock|chanson|orchestre|piano|chorale|chant/.test(r))return 'musique';
  if(/cin[eé]|film|projection|documentaire/.test(r))return 'cinema';
  if(/th[eé][aâ]tre|spectacle|com[eé]die|danse|ballet|cirque|stand.up/.test(r))return 'theatre';
  if(/expo|exposition|galerie|mus[eé]e|vernissage|peinture|sculpture/.test(r))return 'expo';
  if(/enfant|famille|kid|jeun|b[eé]b[eé]|conte|marionnette/.test(r))return 'enfants';
  if(/portes.ouvertes|porte.ouverte|journée.portes/.test(r))return 'portes-ouvertes';
  if(/d[eé]gustation|vin\b|vins\b|cave|vignoble|terroir|gastronomie|fromage/.test(r))return 'degustation';
  if(/brocante|vide.grenier|vide grenier|puces|braderie|antiquit/.test(r))return 'brocante';
  if(/march[eé]/.test(r))return 'marche';
  if(/sport|foot|basket|tennis|course|marathon|yoga|natation|rugby|vélo|cyclisme/.test(r))return 'sport';
  if(/rando|nature|balade|forêt|jardin|écologie|plante/.test(r))return 'nature';
  if(/festival|fête|fete|carnaval|foire\b/.test(r))return 'fete';
  if(/conf[eé]rence|d[eé]bat|atelier|formation|colloque/.test(r))return 'conference';
  return 'autre';
}
