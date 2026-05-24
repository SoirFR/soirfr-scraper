// SoirFR — Full Scraper v5 with verified URLs
// eTerritoire, AgendaCulturel71 RSS, Infolocale, Brocabrac, calendrier-des-brocantes,
// Vide-greniers, JDS, Bourgogne Tourisme, OpenAgenda API, Paris Open Data, Ticketmaster

const SB_URL = 'https://ebinsidruxvbzukobshf.supabase.co';
const SB_KEY = 'sb_publishable_QSnlPXEopb6x8m8N3K396Q_YPazJ0IM';

module.exports = async function handler(req, res) {
  const CRON_SECRET = process.env.CRON_SECRET;
  const OA_KEY = process.env.OPENAGENDA_API_KEY;
  const TM_KEY = process.env.TICKETMASTER_API_KEY;

  if (CRON_SECRET && req.headers['authorization'] !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const results = [], errors = [];
  const dateFrom = new Date().toISOString().split('T')[0];
  const dateTo = new Date(Date.now() + 60 * 86400000).toISOString().split('T')[0];

  // ── 1. eTerritoire Bourgogne-Franche-Comté ──────────────────────────────
  // Confirmed: 4,528 events for dept 71 alone, paginated at /2 /3 etc.
  try { results.push(await scrapeETerritoire(dateFrom)); }
  catch (e) { errors.push({ source: 'eterritoire', error: e.message }); }

  // ── 2. Agenda Culturel 71 — RSS feed ───────────────────────────────────
  // Confirmed RSS format: https://71.agendaculturel.fr/rss/[category]/
  try { results.push(await scrapeAgendaCulturel71(dateFrom)); }
  catch (e) { errors.push({ source: 'agenda_culturel_71', error: e.message }); }

  // ── 3. Infolocale ──────────────────────────────────────────────────────
  try { results.push(await scrapeInfolocale(dateFrom)); }
  catch (e) { errors.push({ source: 'infolocale', error: e.message }); }

  // ── 4. Calendrier des Brocantes (returns real JSON with lat/lng) ────────
  try { results.push(await scrapeCalendrierBrocantes(dateFrom)); }
  catch (e) { errors.push({ source: 'calendrier_brocantes', error: e.message }); }

  // ── 5. Brocabrac dept 71 + 21 ─────────────────────────────────────────
  try { results.push(await scrapeBrocabrac(['71', '21'], dateFrom)); }
  catch (e) { errors.push({ source: 'brocabrac', error: e.message }); }

  // ── 6. Vide-Greniers.org dept 71 ──────────────────────────────────────
  try { results.push(await scrapeVideGreniers(dateFrom)); }
  catch (e) { errors.push({ source: 'vide_greniers', error: e.message }); }

  // ── 7. JDS Saône-et-Loire (JSON-LD) ───────────────────────────────────
  try { results.push(await scrapeJDS(dateFrom)); }
  catch (e) { errors.push({ source: 'jds', error: e.message }); }

  // ── 8. Bourgogne Tourisme web ─────────────────────────────────────────
  try { results.push(await scrapeJsonLdPage('https://www.bourgogne-tourisme.com/sejourner/agenda/', null, 'Bourgogne-Franche-Comté', 'bourgogne_tourisme', dateFrom)); }
  catch (e) { errors.push({ source: 'bourgogne_tourisme', error: e.message }); }

  // ── 9. OpenAgenda API — geographic Burgundy ───────────────────────────
  if (OA_KEY) {
    try { results.push(await scrapeOAApi(OA_KEY, ['71','21','58','89'], dateFrom, dateTo)); }
    catch (e) { errors.push({ source: 'oa_api', error: e.message }); }
  }

  // ── 10. Paris Open Data ───────────────────────────────────────────────
  try { results.push(await scrapeParisOpenData(dateFrom)); }
  catch (e) { errors.push({ source: 'paris', error: e.message }); }

  // ── 11. Ticketmaster France ───────────────────────────────────────────
  if (TM_KEY) {
    try { results.push(await scrapeTicketmaster(TM_KEY, dateFrom, dateTo)); }
    catch (e) { errors.push({ source: 'ticketmaster', error: e.message }); }
  }

  const total_added = results.reduce((s,r) => s+(r.added||0), 0);
  const total_found = results.reduce((s,r) => s+(r.found||0), 0);

  await sbFetch('scrape_logs', 'POST', {
    source_name: 'all_v5', finished_at: new Date().toISOString(),
    events_found: total_found, events_added: total_added,
    status: errors.length === 0 ? 'success' : 'partial',
    error_message: errors.length ? JSON.stringify(errors.slice(0,10)) : null,
  });

  return res.status(200).json({ success: true, total_added, total_found, results, errors });
};

// ── eTerritoire scraper ───────────────────────────────────────────────────
// Pages at /evenements/france,bourgogne-franche-comte,saone-et-loire/
// Event detail page has structured data with full info
async function scrapeETerritoire(dateFrom) {
  let added = 0, found = 0;
  const BASE = 'https://www.eterritoire.fr';
  const PAGES = [
    `${BASE}/evenements/france,bourgogne-franche-comte,saone-et-loire/`,
    `${BASE}/evenements/france,bourgogne-franche-comte,saone-et-loire//2`,
    `${BASE}/evenements/france,bourgogne-franche-comte,saone-et-loire//3`,
    `${BASE}/evenements/france,bourgogne-franche-comte,cote-d-or/`,
    `${BASE}/evenements/france,bourgogne-franche-comte,cote-d-or//2`,
  ];

  for (const pageUrl of PAGES) {
    try {
      const res = await fetch(pageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'fr-FR,fr;q=0.9',
          'Referer': 'https://www.eterritoire.fr/'
        }
      });
      if (!res.ok) continue;
      const html = await res.text();

      // Try JSON-LD on the listing page itself
      const r = await extractJsonLd(html, '71', 'Bourgogne-Franche-Comté', 'eterritoire', pageUrl, dateFrom, null);
      found += r.found; added += r.added;

      // Also extract event blocks directly from listing HTML
      // eTerritoire listing shows: title, date, city, category, image in each card
      const cards = [...html.matchAll(/href="(\/detail\/([^"]+))"[\s\S]*?<h2[^>]*>([^<]+)<\/h2>[\s\S]*?Le (\d{2}\/\d{2}\/\d{4})/g)];
      for (const card of cards) {
        const detailPath = card[1];
        const slug = card[2];
        const title = card[3].trim();
        const rawDate = card[4]; // DD/MM/YYYY
        const parts = rawDate.split('/');
        const startDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
        if (startDate < dateFrom) continue;
        found++;
        const ins = await insertEvent({
          title,
          category: mapCat(slug.split('/')[0] + ' ' + title),
          department: '71',
          region: 'Bourgogne-Franche-Comté',
          starts_at: startDate,
          source_url: 'https://www.eterritoire.fr' + detailPath,
          source_event_id: (title + startDate).replace(/[^a-z0-9]/gi,'_').slice(0,200),
          source_name: 'eterritoire',
        });
        if (ins) added++;
      }
    } catch {}
    await sleep(600);
  }
  return { source: 'eTerritoire BFC', found, added };
}

function parseETerritorePage(html, url) {
  // Extract title
  const titleM = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  if (!titleM) return null;

  // Extract date — format "Le DD/MM/YYYY"
  const dateM = html.match(/Le (\d{2})\/(\d{2})\/(\d{4})/);
  if (!dateM) return null;
  const startDate = `${dateM[3]}-${dateM[2]}-${dateM[1]}`;

  // Extract city
  const cityM = html.match(/class="[^"]*commune[^"]*"[^>]*>([^<]+)<\//) ||
                html.match(/<span[^>]*>([A-ZÀÂÉÈÊËÙÛ][a-zàâéèêëùû\-]+(?:\s[A-ZÀÂÉÈÊËÙÛ][a-zàâéèêëùû\-]+)*)<\/span>/);

  // Extract image
  const imgM = html.match(/<img[^>]+src="(https:\/\/www\.eterritoire\.fr\/img\/fThumbs\/[^"]+)"/);

  // Extract description
  const descM = html.match(/<div[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const desc = descM ? descM[1].replace(/<[^>]+>/g, '').trim().slice(0, 500) : null;

  // Extract category from URL
  const catFromUrl = url.split('/')[4] || '';

  return {
    title: titleM[1].trim(),
    description: desc,
    category: mapCat(catFromUrl + ' ' + titleM[1]),
    city: cityM ? cityM[1].trim() : null,
    starts_at: startDate,
    image_url: imgM ? imgM[1] : null,
    source_event_id: url.split('/').slice(-2).join('_'),
  };
}

// ── Agenda Culturel 71 — RSS ───────────────────────────────────────────────
// RSS feed format confirmed: https://71.agendaculturel.fr/rss/[category]/
async function scrapeAgendaCulturel71(dateFrom) {
  let added = 0, found = 0;
  const RSS_FEEDS = [
    'https://71.agendaculturel.fr/rss/',
    'https://71.agendaculturel.fr/rss/concert/',
    'https://71.agendaculturel.fr/rss/theatre/',
    'https://71.agendaculturel.fr/rss/exposition/',
    'https://71.agendaculturel.fr/rss/festival/',
    'https://71.agendaculturel.fr/rss/spectacle/',
  ];

  for (const feedUrl of RSS_FEEDS) {
    try {
      const res = await fetch(feedUrl, {
        headers: { 'User-Agent': 'SoirFR/1.0 (contact@soirfr.com)', 'Accept': 'application/rss+xml, application/xml, text/xml' }
      });
      if (!res.ok) continue;
      const xml = await res.text();

      // Parse RSS items
      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
      for (const item of items) {
        const content = item[1];
        const title = getXmlText(content, 'title');
        const link = getXmlText(content, 'link');
        const pubDate = getXmlText(content, 'pubDate');
        const desc = getXmlText(content, 'description');
        const category = getXmlText(content, 'category');

        if (!title || !link) continue;
        found++;

        // Parse date from pubDate (RFC 2822 format)
        let startDate = null;
        if (pubDate) {
          const d = new Date(pubDate);
          if (!isNaN(d)) startDate = d.toISOString().split('T')[0];
        }
        if (!startDate || startDate < dateFrom) continue;

        // Try to get city from description or link
        const cityM = desc?.match(/à ([A-ZÀÂÉÈÊËÙÛ][a-zàâéèêëùû\-]+(?:\s[A-ZÀÂÉÈÊËÙÛ][a-zàâéèêëùû\-]+)*)/);

        const ins = await insertEvent({
          title,
          description: desc?.replace(/<[^>]+>/g,'').trim().slice(0,500),
          category: mapCat(category + ' ' + title),
          city: cityM ? cityM[1] : null,
          department: '71',
          region: 'Bourgogne-Franche-Comté',
          starts_at: startDate,
          booking_url: link,
          source_url: link,
          source_event_id: link,
          source_name: 'agenda_culturel_71',
        });
        if (ins) added++;
      }
      await sleep(400);
    } catch {}
  }
  return { source: 'Agenda Culturel 71', found, added };
}

function getXmlText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i')) ||
            xml.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i'));
  return m ? m[1].trim() : null;
}

// ── Infolocale ────────────────────────────────────────────────────────────
async function scrapeInfolocale(dateFrom) {
  let added = 0, found = 0;
  // Infolocale URL structure — department pages
  const URLS = [
    'https://www.infolocale.fr/agenda/saone-et-loire/',
    'https://www.infolocale.fr/agenda/cote-d-or/',
  ];

  for (const url of URLS) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
      });
      if (!res.ok) continue;
      const html = await res.text();

      // Try JSON-LD first
      const r = await extractJsonLd(html, '71', 'Bourgogne-Franche-Comté', 'infolocale', url, dateFrom, null);
      found += r.found; added += r.added;

      // Also try structured event blocks
      if (r.found === 0) {
        const eventBlocks = html.matchAll(/class="[^"]*event[^"]*"[^>]*>([\s\S]*?)(?=class="[^"]*event[^"]*"|<\/section>)/gi);
        for (const block of eventBlocks) {
          const content = block[1];
          const titleM = content.match(/<h[23][^>]*>([^<]+)<\/h[23]>/i);
          const dateM = content.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
          const cityM = content.match(/\b([A-ZÀÂÉÈÊËÙÛ][a-zàâéèêëùû\-]+)\b/);
          if (!titleM) continue;
          found++;
          let startDate = dateM ? `${dateM[3]}-${dateM[2].padStart(2,'0')}-${dateM[1].padStart(2,'0')}` : null;
          if (!startDate || startDate < dateFrom) continue;
          const ins = await insertEvent({
            title: titleM[1].trim(),
            category: mapCat(titleM[1]),
            city: cityM ? cityM[1] : null,
            department: '71',
            region: 'Bourgogne-Franche-Comté',
            starts_at: startDate,
            source_url: url,
            source_event_id: titleM[1] + startDate,
            source_name: 'infolocale',
          });
          if (ins) added++;
        }
      }
    } catch {}
    await sleep(600);
  }
  return { source: 'Infolocale', found, added };
}

// ── Calendrier des Brocantes (real JSON with lat/lng!) ────────────────────
async function scrapeCalendrierBrocantes(dateFrom) {
  // This site returns actual JSON objects with lat/long for each event
  const url = 'https://calendrier-des-brocantes.com/vide-greniers-brocante/saone-et-loire-departement/';
  let added = 0, found = 0;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'SoirFR/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    // The site embeds JSON directly in the page — extract all JSON arrays/objects with event data
    const jsonMatches = html.matchAll(/\[\s*\{[^}]*"url"\s*:[^}]*"lat"\s*:[^}]*\}/gs);
    for (const match of jsonMatches) {
      try {
        // Clean and parse — may be truncated, extract individual objects
        const jsonStr = match[0].endsWith(']') ? match[0] : match[0] + '}]';
        const events = JSON.parse(jsonStr);
        for (const ev of events) {
          found++;
          if (!ev.url || !ev.localite) continue;
          // Extract date from URL — format date=DD.MM.YYYY
          const dateM = ev.url.match(/date=(\d{2})\.(\d{2})\.(\d{4})/);
          const startDate = dateM ? `${dateM[3]}-${dateM[2]}-${dateM[1]}` : null;
          if (!startDate || startDate < dateFrom) continue;

          const ins = await insertEvent({
            title: ev.nom || 'Brocante / Vide-grenier',
            category: mapCat(ev.category || 'brocante'),
            address: ev.lieu,
            city: ev.localite,
            postcode: ev.zip_code,
            department: '71',
            region: 'Bourgogne-Franche-Comté',
            lat: ev.lat,
            lng: ev.long,
            starts_at: startDate,
            source_url: ev.url,
            source_event_id: ev.url,
            source_name: 'calendrier_brocantes',
          });
          if (ins) added++;
        }
      } catch {}
    }

    // Also try JSON-LD
    const r = await extractJsonLd(html, '71', 'Bourgogne-Franche-Comté', 'calendrier_brocantes', url, dateFrom, 'brocante');
    found += r.found; added += r.added;

  } catch (e) {}
  return { source: 'Calendrier des Brocantes', found, added };
}

// ── Brocabrac ─────────────────────────────────────────────────────────────
async function scrapeBrocabrac(depts, dateFrom) {
  let added = 0, found = 0;
  for (const dept of depts) {
    try {
      // Real URL confirmed: brocabrac.fr/71/ (with trailing slash)
      const res = await fetch(`https://brocabrac.fr/${dept}/`, { headers: { 'User-Agent': 'SoirFR/1.0' } });
      if (!res.ok) continue;
      const html = await res.text();
      const r = await extractJsonLd(html, dept, 'Bourgogne-Franche-Comté', 'brocabrac', `https://brocabrac.fr/${dept}/`, dateFrom, 'brocante');
      found += r.found; added += r.added;
    } catch {}
    await sleep(600);
  }
  return { source: 'Brocabrac', found, added };
}

// ── Vide-Greniers.org ─────────────────────────────────────────────────────
async function scrapeVideGreniers(dateFrom) {
  let added = 0, found = 0;
  const PAGES = [
    { url: 'https://www.vide-greniers.org/71-Saone-et-Loire.htm', dept: '71' },
    { url: 'https://www.vide-greniers.org/21-Cote-dOr.htm', dept: '21' },
  ];
  for (const { url, dept } of PAGES) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'SoirFR/1.0' } });
      if (!res.ok) continue;
      const html = await res.text();
      const r = await extractJsonLd(html, dept, 'Bourgogne-Franche-Comté', 'vide_greniers', url, dateFrom, 'brocante');
      found += r.found; added += r.added;
    } catch {}
    await sleep(500);
  }
  return { source: 'Vide-Greniers.org', found, added };
}

// ── JDS Saône-et-Loire ────────────────────────────────────────────────────
async function scrapeJDS(dateFrom) {
  const URLS = [
    'https://www.jds.fr/saone-et-loire/agenda/',
    'https://www.jds.fr/saone-et-loire/agenda/concerts/',
    'https://www.jds.fr/saone-et-loire/agenda/expos/',
    'https://www.jds.fr/saone-et-loire/agenda/spectacles/',
    'https://www.jds.fr/saone-et-loire/agenda/brocantes/',
    'https://www.jds.fr/saone-et-loire/agenda/marches/',
  ];
  let added = 0, found = 0;
  for (const url of URLS) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'SoirFR/1.0' } });
      if (!res.ok) continue;
      const html = await res.text();
      const r = await extractJsonLd(html, '71', 'Bourgogne-Franche-Comté', 'jds_71', url, dateFrom, null);
      found += r.found; added += r.added;
    } catch {}
    await sleep(500);
  }
  return { source: 'JDS Saône-et-Loire', found, added };
}

// ── Generic JSON-LD page scraper ──────────────────────────────────────────
async function scrapeJsonLdPage(url, dept, region, sourceName, dateFrom) {
  const res = await fetch(url, { headers: { 'User-Agent': 'SoirFR/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const r = await extractJsonLd(html, dept, region, sourceName, url, dateFrom, null);
  return { source: sourceName, found: r.found, added: r.added };
}

// ── OpenAgenda API ────────────────────────────────────────────────────────
async function scrapeOAApi(key, depts, dateFrom, dateTo) {
  const events = [];
  for (const dept of depts) {
    const params = new URLSearchParams({ key, size: 100, 'timings[gte]': dateFrom, 'timings[lte]': dateTo, 'location[department]': dept, detailed: 1 });
    try {
      const r = await fetch(`https://api.openagenda.com/v2/events?${params}`);
      if (r.ok) { const d = await r.json(); events.push(...(d.events||[]).map(e=>({...e,_dept:dept}))); }
    } catch {}
    await sleep(300);
  }
  let added = 0;
  for (const ev of events) {
    const t = ev.timings?.[0]; if (!t) continue;
    const ins = await insertEvent({
      title: ev.title?.fr||ev.title?.en||'Événement',
      description: ev.description?.fr?.slice(0,1000),
      category: mapCat(ev.keywords?.fr?.[0]||''),
      address: ev.location?.address, city: ev.location?.city,
      postcode: ev.location?.postalCode, department: ev._dept,
      region: 'Bourgogne-Franche-Comté',
      lat: ev.location?.latitude, lng: ev.location?.longitude,
      starts_at: t.begin, ends_at: t.end,
      image_url: ev.image ? ev.image.base+ev.image.filename : null,
      is_free: ev.conditions?.fr?.toLowerCase().includes('gratuit')||false,
      booking_url: ev.registration?.[0]?.value||null,
      source_url: `https://openagenda.com/events/${ev.slug}`,
      source_event_id: String(ev.uid), source_name: 'openagenda_api',
    });
    if (ins) added++;
  }
  return { source: `OpenAgenda API (${depts.join(',')})`, found: events.length, added };
}

// ── Paris Open Data ───────────────────────────────────────────────────────
async function scrapeParisOpenData(dateFrom) {
  const params = new URLSearchParams({ limit: 100, where: `date_start >= '${dateFrom}'`, order_by: 'date_start ASC' });
  const res = await fetch(`https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/que-faire-a-paris-/records?${params}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  let added = 0;
  for (const ev of (data.results||[])) {
    const ins = await insertEvent({
      title: ev.title, description: ev.lead_text?.slice(0,1000),
      category: mapCat(ev.category||''), city: 'Paris',
      postcode: ev.address_zipcode, department: '75', region: 'Île-de-France',
      lat: ev.lat_lon?.lat, lng: ev.lat_lon?.lon,
      starts_at: ev.date_start, ends_at: ev.date_end,
      image_url: ev.cover_url, is_free: ev.price_type==='free',
      booking_url: ev.url, source_url: ev.url,
      source_event_id: String(ev.id), source_name: 'ot_paris',
    });
    if (ins) added++;
  }
  return { source: 'Paris Open Data', found: data.results?.length||0, added };
}

// ── Ticketmaster ──────────────────────────────────────────────────────────
async function scrapeTicketmaster(key, dateFrom, dateTo) {
  const params = new URLSearchParams({ apikey: key, countryCode: 'FR', startDateTime: new Date(dateFrom).toISOString().replace('.000',''), endDateTime: new Date(dateTo).toISOString().replace('.000',''), size: 200, sort: 'date,asc' });
  const res = await fetch(`https://app.ticketmaster.com/discovery/v2/events.json?${params}`);
  if (!res.ok) return { source: 'Ticketmaster', found: 0, added: 0 };
  const data = await res.json();
  const events = data?._embedded?.events||[];
  let added = 0;
  for (const ev of events) {
    const v=ev._embedded?.venues?.[0], p=ev.priceRanges?.[0], d=ev.dates?.start;
    const ins = await insertEvent({
      title: ev.name, description: ev.info?.slice(0,1000),
      category: mapCat(ev.classifications?.[0]?.segment?.name||''),
      address: v?.address?.line1, city: v?.city?.name, postcode: v?.postalCode, country: 'FR',
      lat: parseFloat(v?.location?.latitude)||null, lng: parseFloat(v?.location?.longitude)||null,
      starts_at: d?.dateTime||d?.localDate,
      image_url: ev.images?.find(i=>i.ratio==='16_9'&&i.width>500)?.url,
      price_min: p?.min, is_free: p?.min===0,
      booking_url: ev.url, source_url: ev.url, source_event_id: ev.id,
      source_name: 'ticketmaster_france',
    });
    if (ins) added++;
  }
  return { source: 'Ticketmaster', found: events.length, added };
}

// ── Generic JSON-LD extractor ─────────────────────────────────────────────
async function extractJsonLd(html, dept, region, sourceName, baseUrl, dateFrom, defaultCat) {
  let added = 0, found = 0;
  for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) {
    try {
      const schema = JSON.parse(match[1]);
      const items = [].concat(schema?.['@graph']||schema);
      for (const item of items) {
        const type = String([].concat(item['@type']).join(' '));
        if (!type.includes('Event')) continue;
        found++;
        if (item.startDate && item.startDate < dateFrom) continue;
        const ins = await insertEvent({
          title: item.name,
          description: item.description?.slice(0,1000),
          category: defaultCat || mapCat(item.name+' '+(item.description||'')),
          address: item.location?.address?.streetAddress,
          city: item.location?.address?.addressLocality,
          postcode: item.location?.address?.postalCode,
          department: dept, region,
          lat: item.location?.geo?.latitude,
          lng: item.location?.geo?.longitude,
          starts_at: item.startDate, ends_at: item.endDate,
          image_url: Array.isArray(item.image)?item.image[0]:item.image,
          is_free: item.isAccessibleForFree===true,
          booking_url: item.url,
          source_url: item.url||baseUrl,
          source_event_id: item.url||item.name,
          source_name: sourceName,
        });
        if (ins) added++;
      }
    } catch {}
  }
  return { found, added };
}

// ── Insert with dedup ─────────────────────────────────────────────────────
async function insertEvent(ev) {
  if (!ev.title||!ev.starts_at) return false;
  if (ev.source_event_id&&ev.source_name) {
    const id = String(ev.source_event_id).slice(0,200);
    const existing = await sbFetch(`events?source_name=eq.${encodeURIComponent(ev.source_name)}&source_event_id=eq.${encodeURIComponent(id)}&select=id`, 'GET');
    if (existing?.length>0) return false;
  }
  const lat=parseFloat(ev.lat), lng=parseFloat(ev.lng);
  const loc=(!isNaN(lat)&&!isNaN(lng)&&lat!==0&&lng!==0)?`POINT(${lng} ${lat})`:null;
  return await sbFetch('events','POST',{
    title: String(ev.title).slice(0,500), description: ev.description||null,
    category: ev.category||'autre', address: ev.address||null,
    city: ev.city||null, postcode: ev.postcode||null,
    department: ev.department||null, region: ev.region||null, country: ev.country||'FR',
    location: loc, starts_at: ev.starts_at, ends_at: ev.ends_at||null,
    image_url: ev.image_url||null, price_min: ev.price_min??null,
    is_free: ev.is_free||false, booking_url: ev.booking_url||null,
    source_type: 'scraper', source_name: ev.source_name,
    source_url: ev.source_url||null,
    source_event_id: ev.source_event_id?String(ev.source_event_id).slice(0,200):null,
    status: 'active', scraped_at: new Date().toISOString(),
  });
}

async function sbFetch(path,method='GET',body=null) {
  try {
    const res=await fetch(`${SB_URL}/rest/v1/${path}`,{
      method, body: body?JSON.stringify(body):null,
      headers:{'apikey':SB_KEY,'Authorization':`Bearer ${SB_KEY}`,'Content-Type':'application/json','Prefer':method==='POST'?'return=minimal':''},
    });
    if(method==='GET') return await res.json();
    return res.ok;
  } catch { return null; }
}

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

function mapCat(raw) {
  if(!raw) return 'autre'; const r=raw.toLowerCase();
  if(/concert|musique|music|jazz|rock|chanson|orchestre|piano|chorale|chant|variété|festival.*music/.test(r)) return 'musique';
  if(/cin[eé]|film|projection|documentaire/.test(r)) return 'cinema';
  if(/th[eé][aâ]tre|spectacle|com[eé]die|danse|ballet|cirque|stand.up|conte|lecture/.test(r)) return 'theatre';
  if(/expo|exposition|galerie|mus[eé]e|vernissage|peinture|sculpture|photo|c[eé]ramique/.test(r)) return 'expo';
  if(/enfant|famille|kid|jeun|b[eé]b[eé]|marionnette|atelier.enfant/.test(r)) return 'enfants';
  if(/portes.ouvertes|porte.ouverte|visite.domaine|visite.cave/.test(r)) return 'portes-ouvertes';
  if(/d[eé]gustation|repas|vin\b|vins\b|cave|vignoble|terroir|gastronomie|fromage|oenologie/.test(r)) return 'degustation';
  if(/brocante|vide.grenier|vide grenier|puces|braderie|antiquit/.test(r)) return 'brocante';
  if(/march[eé]/.test(r)) return 'marche';
  if(/sport|foot|basket|tennis|course|marathon|yoga|natation|rugby|v[eé]lo|cyclisme|randonn|balade/.test(r)) return 'sport';
  if(/nature|for[eê]t|jardin|[eé]cologie/.test(r)) return 'nature';
  if(/festival|f[eê]te\b|fete|carnaval|foire\b/.test(r)) return 'fete';
  if(/conf[eé]rence|d[eé]bat|atelier\b|formation|colloque|patrimoine|histoire/.test(r)) return 'conference';
  return 'autre';
}
