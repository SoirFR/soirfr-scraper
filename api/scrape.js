// SoirFR — Full Scraper v5 with verified URLs
// eTerritoire, AgendaCulturel71 RSS, Infolocale, Brocabrac, calendrier-des-brocantes,
// Vide-greniers, JDS, Bourgogne Tourisme, OpenAgenda API, Paris Open Data, Ticketmaster

const SB_URL = 'https://ebinsidruxvbzukobshf.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'sb_publishable_QSnlPXEopb6x8m8N3K396Q_YPazJ0IM';

// Central-eastern France: Burgundy + adjacent rural departments
// Burgundy core (21,71,89,58) + western/northern edges (03,18,45,10,52)
// + Jura/Franche-Comté (39,25,70) + south toward Lyon (01,69)
const DEPTS_REGION = ['21','71','89','58','03','18','45','10','52','39','25','70','01','69'];
// Île-de-France: Paris (75) + petite couronne (92, 93, 94) + grande couronne (77, 78, 91, 95)
const DEPTS_IDF = ['75','77','78','91','92','93','94','95'];
// Depts to scrape for brocantes/vide-greniers (BFC + IdF)
const DEPTS_BROCANTE = [...DEPTS_REGION, ...DEPTS_IDF];

// Map a dept code to its region name (used to tag events correctly)
function regionForDept(dept) {
  if (DEPTS_IDF.includes(dept)) return 'Île-de-France';
  return 'Bourgogne-Franche-Comté';
}

// Mapping from dept code to slugified name used in vide-greniers.org URLs
const DEPT_VG_SLUG = {
  '01': '01-Ain', '03': '03-Allier', '10': '10-Aube', '18': '18-Cher',
  '21': '21-Cote-dOr', '25': '25-Doubs', '39': '39-Jura', '45': '45-Loiret',
  '52': '52-Haute-Marne', '58': '58-Nievre', '69': '69-Rhone',
  '70': '70-Haute-Saone', '71': '71-Saone-et-Loire', '89': '89-Yonne',
  // Île-de-France
  '75': '75-Paris', '77': '77-Seine-et-Marne', '78': '78-Yvelines',
  '91': '91-Essonne', '92': '92-Hauts-de-Seine', '93': '93-Seine-Saint-Denis',
  '94': '94-Val-de-Marne', '95': '95-Val-dOise'
};

// Per-run cap on NEW inserts so the function always finishes within its time
// limit. Re-running the scraper (or the nightly cron) backfills the rest.
const ADD_BUDGET = 500;
let ADDS_USED = 0;
// Per-source set of existing source_event_ids, loaded once per run (see insertEvent).
let KNOWN_BY_SOURCE = {};

module.exports = async function handler(req, res) {
  const CRON_SECRET = process.env.CRON_SECRET;
  const OA_KEY = process.env.OPENAGENDA_API_KEY;
  const TM_KEY = process.env.TICKETMASTER_API_KEY;

  if (CRON_SECRET && req.headers['authorization'] !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const results = [], errors = [];
  ADDS_USED = 0;
  KNOWN_BY_SOURCE = {};
  const dateFrom = new Date().toISOString().split('T')[0];
  const dateTo = new Date(Date.now() + 365 * 86400000).toISOString().split('T')[0];

  // ── 0. Maintenance: expire finished events ─────────────────────────────
  // An event is over when its end date has passed, or — if it has no end
  // date — when its start date has passed. Keeps the active table honest;
  // without this, past events pile up forever (10k+ found in July 2026).
  try {
    const expired = await expireOldEvents(dateFrom);
    results.push({ source: 'expire_maintenance', found: expired, added: 0 });
  } catch (e) { errors.push({ source: 'expire_maintenance', error: e.message }); }

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

  // ── 5. Brocabrac — 14 rural/regional departments ───────────────────────
  try { results.push(await scrapeBrocabrac(DEPTS_BROCANTE, dateFrom)); }
  catch (e) { errors.push({ source: 'brocabrac', error: e.message }); }

  // ── 6. Vide-Greniers.org dept 71 ──────────────────────────────────────
  try { results.push(await scrapeVideGreniers(dateFrom)); }
  catch (e) { errors.push({ source: 'vide_greniers', error: e.message }); }

  // ── 7. JDS Saône-et-Loire (JSON-LD) ───────────────────────────────────
  try { results.push(await scrapeJDS(dateFrom)); }
  catch (e) { errors.push({ source: 'jds', error: e.message }); }

  // ── 8. Bourgogne Tourisme web — TEMPORARILY DISABLED ──────────────────
  // Their event pages respond slowly and were consuming the whole run before
  // OpenAgenda (below) could insert. Re-enable once OpenAgenda is restored.
  // try { results.push(await scrapeBourgogneTourisme(dateFrom)); }
  // catch (e) { errors.push({ source: 'bourgogne_tourisme', error: e.message }); }

  // ── 9. OpenAgenda API — 14 rural/regional departments ─────────────────
  if (OA_KEY) {
    try { results.push(await scrapeOAApi(OA_KEY, DEPTS_REGION, dateFrom, dateTo)); }
    catch (e) { errors.push({ source: 'oa_api', error: e.message }); }
  }

  // ── 10. Paris Open Data — DISABLED (too random, off-brand for now) ────
  // try { results.push(await scrapeParisOpenData(dateFrom)); }
  // catch (e) { errors.push({ source: 'paris', error: e.message }); }

  // ── 11. Ticketmaster France ───────────────────────────────────────────
  if (TM_KEY) {
    try { results.push(await scrapeTicketmaster(TM_KEY, dateFrom, dateTo)); }
    catch (e) { errors.push({ source: 'ticketmaster', error: e.message }); }
  }

  // ── 12. Seat À La Table — premium curated French food/wine experiences ─
  try { results.push(await scrapeSeatALaTable(dateFrom)); }
  catch (e) { errors.push({ source: 'seat_a_la_table', error: e.message }); }

  // Geocode any events missing coordinates using city/postcode
  try {
    const geocoded = await geocodeMissingEvents();
    results.push({ source: 'geocoder', found: geocoded, added: geocoded });
  } catch(e) { errors.push({ source: 'geocoder', error: e.message }); }

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
  // All 8 departments in Bourgogne-Franche-Comté, with deeper pagination.
  // The same regex matches whether the URL targets a region or a department.
  const PAGES = [
    // Region-wide (catches anything not pinned to a department)
    `${BASE}/evenements/france,bourgogne-franche-comte/`,
    `${BASE}/evenements/france,bourgogne-franche-comte/2`,
    `${BASE}/evenements/france,bourgogne-franche-comte/3`,
    `${BASE}/evenements/france,bourgogne-franche-comte/4`,
    `${BASE}/evenements/france,bourgogne-franche-comte/5`,
    // Saône-et-Loire (71) — primary focus
    `${BASE}/evenements/france,bourgogne-franche-comte,saone-et-loire/`,
    `${BASE}/evenements/france,bourgogne-franche-comte,saone-et-loire//2`,
    `${BASE}/evenements/france,bourgogne-franche-comte,saone-et-loire//3`,
    `${BASE}/evenements/france,bourgogne-franche-comte,saone-et-loire//4`,
    // Côte-d'Or (21) — Beaune, Dijon
    `${BASE}/evenements/france,bourgogne-franche-comte,cote-d-or/`,
    `${BASE}/evenements/france,bourgogne-franche-comte,cote-d-or//2`,
    `${BASE}/evenements/france,bourgogne-franche-comte,cote-d-or//3`,
    `${BASE}/evenements/france,bourgogne-franche-comte,cote-d-or//4`,
    // Yonne (89)
    `${BASE}/evenements/france,bourgogne-franche-comte,yonne/`,
    `${BASE}/evenements/france,bourgogne-franche-comte,yonne/2`,
    `${BASE}/evenements/france,bourgogne-franche-comte,yonne/3`,
    `${BASE}/evenements/france,bourgogne-franche-comte,yonne/4`,
    // Nièvre (58)
    `${BASE}/evenements/france,bourgogne-franche-comte,nievre/`,
    `${BASE}/evenements/france,bourgogne-franche-comte,nievre/2`,
    `${BASE}/evenements/france,bourgogne-franche-comte,nievre/3`,
    // Doubs (25)
    `${BASE}/evenements/france,bourgogne-franche-comte,doubs/`,
    `${BASE}/evenements/france,bourgogne-franche-comte,doubs/2`,
    // Jura (39)
    `${BASE}/evenements/france,bourgogne-franche-comte,jura/`,
    `${BASE}/evenements/france,bourgogne-franche-comte,jura/2`,
    // Haute-Saône (70)
    `${BASE}/evenements/france,bourgogne-franche-comte,haute-saone/`,
    `${BASE}/evenements/france,bourgogne-franche-comte,haute-saone/2`,
    // Territoire de Belfort (90)
    `${BASE}/evenements/france,bourgogne-franche-comte,territoire-de-belfort/`,
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

      // Build an image lookup: scan all <a href="/detail/..."> positions and
      // record the nearest preceding <img src="..."> for each. This lets us
      // attach images to cards without changing the card-matching logic.
      const imagesByDetail = new Map();
      const linkPositions = [...html.matchAll(/<a[^>]+href="(\/detail\/[^"]+)"/g)];
      const imgMatches = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)];
      for (const lp of linkPositions) {
        const detailPath = lp[1];
        const linkIdx = lp.index;
        // Find the nearest <img> that appears BEFORE this link
        let nearestImg = null, nearestIdx = -1;
        for (const im of imgMatches) {
          if (im.index < linkIdx && im.index > nearestIdx) {
            nearestIdx = im.index;
            nearestImg = im[1];
          }
        }
        if (nearestImg) {
          // Sanity: must be reasonably close (not from a totally different section).
          // Eterritoire cards typically have img within ~2000 chars before the href.
          if (linkIdx - nearestIdx < 2000) {
            // Make absolute if relative
            let url = nearestImg;
            if (url.startsWith('/')) url = BASE + url;
            imagesByDetail.set(detailPath, url);
          }
        }
      }

      // Also extract event blocks directly from listing HTML
      // eTerritoire listing shows: title, date, city, category in each card
      // Cards show either "Le DD/MM/YYYY" (one day) or "Du DD/MM/YYYY au DD/MM/YYYY"
      // (exhibitions, festivals). The old regex only matched "Le …", so every
      // date-range event — including running exhibitions — was silently dropped.
      const cards = [...html.matchAll(/href="(\/detail\/([^"]+))"[\s\S]*?<h2[^>]*>([^<]+)<\/h2>[\s\S]*?(?:Le (\d{2}\/\d{2}\/\d{4})|Du (\d{2}\/\d{2}\/\d{4})\s+au (\d{2}\/\d{2}\/\d{4}))/g)];
      const frDate = s => { const p = s.split('/'); return `${p[2]}-${p[1]}-${p[0]}`; };
      for (const card of cards) {
        const detailPath = card[1];
        const slug = card[2];
        const title = card[3].trim();
        const startDate = frDate(card[4] || card[5]);
        const endDate = card[6] ? frDate(card[6]) : null;
        // Skip only if the event is fully over
        if ((endDate || startDate) < dateFrom) continue;
        found++;
        // Look up image (may be undefined, that's OK — falls back to null)
        const imageUrl = imagesByDetail.get(detailPath) || null;
        // The detail URL ends with ",town(postcode)" e.g. ",matour(71520)".
        let city = null, postcode = null, department = '71';
        const locM = detailPath.match(/,([^,\/]+?)\((\d{5})\)\s*$/);
        if (locM) {
          postcode = locM[2];
          department = postcode.slice(0, 2);
          city = locM[1].split('-')
            .map(w => w ? w.charAt(0).toUpperCase() + w.slice(1) : w)
            .join('-');
        }
        const ins = await insertEvent({
          title,
          category: mapCat(slug.split('/')[0] + ' ' + title),
          city,
          postcode,
          department,
          region: 'Bourgogne-Franche-Comté',
          starts_at: startDate,
          ends_at: endDate,
          image_url: imageUrl,
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

        // Image extraction — try multiple patterns common in French event RSS:
        // 1. <enclosure url="..." type="image/...">
        // 2. <media:content url="..." medium="image">  or  <media:thumbnail url="...">
        // 3. <img src="..."> inside the description HTML (CDATA-wrapped)
        let imageUrl = null;
        const enclosureM = content.match(/<enclosure[^>]+url="([^"]+)"[^>]*type="image\//i);
        if (enclosureM) imageUrl = enclosureM[1];
        if (!imageUrl) {
          const mediaM = content.match(/<media:(?:content|thumbnail)[^>]+url="([^"]+)"/i);
          if (mediaM) imageUrl = mediaM[1];
        }
        if (!imageUrl && desc) {
          const imgM = desc.match(/<img[^>]+src="([^"]+)"/i);
          if (imgM) imageUrl = imgM[1];
        }
        // Make relative URLs absolute
        if (imageUrl && imageUrl.startsWith('/')) {
          imageUrl = 'https://71.agendaculturel.fr' + imageUrl;
        }

        // The RSS <pubDate> is the PUBLICATION date, not the event date — using
        // it stamped ~100 events with wrong dates (all in the past within weeks).
        // Parse the real event date out of the title/description text instead;
        // no parseable date → skip rather than store garbage.
        const startDate = parseFrenchEventDate(`${title} ${desc || ''}`, dateFrom);
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
          image_url: imageUrl,
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

// Parse a French event date out of free text: "12 septembre 2026",
// "samedi 12 septembre" (year inferred), "12/09/2026". Returns YYYY-MM-DD or null.
function parseFrenchEventDate(text, dateFrom) {
  if (!text) return null;
  const t = text.toLowerCase().replace(/1er\b/g, '1');
  const MONTHS = { janvier:1, 'février':2, fevrier:2, mars:3, avril:4, mai:5, juin:6,
    juillet:7, 'août':8, aout:8, septembre:9, octobre:10, novembre:11, 'décembre':12, decembre:12 };
  // "12 septembre 2026" or "12 septembre" (year optional)
  const m = t.match(new RegExp(`\\b(\\d{1,2})\\s+(${Object.keys(MONTHS).join('|')})(?:\\s+(\\d{4}))?`, 'i'));
  if (m) {
    const day = String(parseInt(m[1])).padStart(2, '0');
    const mon = String(MONTHS[m[2]]).padStart(2, '0');
    let year = m[3] ? parseInt(m[3]) : parseInt(dateFrom.slice(0, 4));
    let iso = `${year}-${mon}-${day}`;
    // No explicit year and the date already passed → it means next year
    if (!m[3] && iso < dateFrom) iso = `${year + 1}-${mon}-${day}`;
    return iso;
  }
  // "12/09/2026"
  const n = t.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (n) return `${n[3]}-${String(parseInt(n[2])).padStart(2,'0')}-${String(parseInt(n[1])).padStart(2,'0')}`;
  return null;
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
      const r = await extractJsonLd(html, dept, regionForDept(dept), 'brocabrac', `https://brocabrac.fr/${dept}/`, dateFrom, 'brocante');
      found += r.found; added += r.added;
    } catch {}
    await sleep(600);
  }
  return { source: 'Brocabrac', found, added };
}

// ── Vide-Greniers.org ─────────────────────────────────────────────────────
async function scrapeVideGreniers(dateFrom) {
  let added = 0, found = 0;
  for (const dept of DEPTS_BROCANTE) {
    const slug = DEPT_VG_SLUG[dept];
    if (!slug) continue;
    const url = `https://www.vide-greniers.org/${slug}.htm`;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'SoirFR/1.0' } });
      if (!res.ok) continue;
      const html = await res.text();
      const r = await extractJsonLd(html, dept, 'France', 'vide_greniers', url, dateFrom, 'brocante');
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

// ── Bourgogne Tourisme ─────────────────────────────────────────────────────
// The agenda listing links to each event's own page (/agenda/<slug>). We grab
// those links, then read each event page — which carries full, correct
// structured data INCLUDING its own URL. (The old approach read only the
// listing page's sparse embedded data, so it returned a few events with no
// real per-event link, defaulting to the generic agenda page.)
async function scrapeBourgogneTourisme(dateFrom) {
  const BASE = 'https://www.bourgogne-tourisme.com';
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
  const res = await fetch(`${BASE}/sejourner/agenda/`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  // Links may be absolute (https://www.bourgogne-tourisme.com/agenda/<slug>) or
  // relative (/agenda/<slug>) — capture the /agenda/<slug> path from either form.
  const paths = [...new Set(
    [...html.matchAll(/href="(?:https?:\/\/[^"\/]*bourgogne-tourisme\.com)?(\/agenda\/[a-z0-9][a-z0-9-]*)"/gi)].map(m => m[1])
  )];

  // Skip event pages already stored so each run advances onto new ones.
  let known = new Set();
  try {
    const existing = await sbFetch('events?source_name=eq.bourgogne_tourisme&select=source_url', 'GET');
    known = new Set((existing || []).map(e => e.source_url));
  } catch {}

  let found = 0, added = 0, pages = 0;
  for (const path of paths) {
    if (pages >= 12) break;                  // cap fetches per run (time budget)
    if (known.has(BASE + path)) continue;    // already have this event
    try {
      const er = await fetch(BASE + path, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
      if (!er.ok) continue;
      pages++;
      const ehtml = await er.text();
      // Reuse the proven JSON-LD reader; baseUrl is the event page itself, so
      // source_url resolves to the real event page even if the markup omits it.
      const r = await extractJsonLd(ehtml, '21', 'Bourgogne-Franche-Comté', 'bourgogne_tourisme', BASE + path, dateFrom, null);
      found += r.found; added += r.added;
    } catch {}
    await sleep(250);
  }
  return { source: `Bourgogne Tourisme (${pages} pages read, ${paths.length} links found)`, found, added };
}

// ── OpenAgenda API ────────────────────────────────────────────────────────
// Build a valid public OpenAgenda URL. Events live UNDER their agenda, so the
// bare /events/<slug> form returns a 403 "not associated to any agenda".
// OpenAgenda exposes the real URL as `canonicalUrl`; if that's ever missing,
// rebuild it from the origin agenda. Returns null rather than a dead link.
function oaEventUrl(ev) {
  if (ev.canonicalUrl) return ev.canonicalUrl;
  const ag = ev.originAgenda || ev.origin || ev.agenda || null;
  if (ag && ev.slug) {
    const base = ag.oaUrl || ag.url || (ag.slug ? `https://openagenda.com/${ag.slug}` : null);
    if (base) return `${base.replace(/\/+$/, '')}/events/${ev.slug}`;
  }
  return null; // no link is better than a dead link
}

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
    // OpenAgenda lists every session of a recurring event, oldest first, so
    // ev.timings[0] is often years in the past. Pick the soonest session that
    // hasn't finished yet (upcoming or ongoing); skip events with no live one.
    const now = Date.now();
    const t = (Array.isArray(ev.timings) ? ev.timings : [])
      .filter(x => x && x.begin && x.end && new Date(x.end).getTime() >= now)
      .sort((a, b) => new Date(a.begin) - new Date(b.begin))[0];
    if (!t) continue;
    const ins = await insertEvent({
      title: ev.title?.fr||ev.title?.en||'Événement',
      description: ev.description?.fr?.slice(0,1000),
      category: mapCat((ev.title?.fr||ev.title?.en||'')+' '+(ev.keywords?.fr?.join(' ')||'')),
      address: ev.location?.address, city: ev.location?.city,
      postcode: ev.location?.postalCode, department: ev._dept,
      region: 'Bourgogne-Franche-Comté',
      lat: ev.location?.latitude, lng: ev.location?.longitude,
      starts_at: t.begin, ends_at: t.end,
      image_url: ev.image ? ev.image.base+ev.image.filename : null,
      is_free: ev.conditions?.fr?.toLowerCase().includes('gratuit')||false,
      booking_url: ev.registration?.[0]?.value||null,
      source_url: oaEventUrl(ev),
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
  // Geo-targeted queries instead of one nationwide list: countryCode=FR sorted
  // by date returned mostly out-of-coverage events (8 total inserts ever).
  // One circle over Burgundy/Franche-Comté, one over Île-de-France.
  const ZONES = [
    { latlong: '47.32,4.89', radius: '160' },   // Dijon-centred, covers BFC
    { latlong: '48.85,2.35', radius: '60'  },   // Paris + couronnes
  ];
  const events = [];
  const seenIds = new Set();
  for (const z of ZONES) {
    const params = new URLSearchParams({ apikey: key, countryCode: 'FR',
      latlong: z.latlong, radius: z.radius, unit: 'km',
      startDateTime: new Date(dateFrom).toISOString().replace('.000',''),
      endDateTime: new Date(dateTo).toISOString().replace('.000',''),
      size: 200, sort: 'date,asc' });
    try {
      const res = await fetch(`https://app.ticketmaster.com/discovery/v2/events.json?${params}`);
      if (!res.ok) continue;
      const data = await res.json();
      for (const ev of (data?._embedded?.events || [])) {
        if (seenIds.has(ev.id)) continue;
        seenIds.add(ev.id);
        events.push(ev);
      }
    } catch {}
    await sleep(300);
  }
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

// ── Seat À La Table (Shopify storefront) ──────────────────────────────────
// Premium curated French food/wine "Epicurean Adventures" + supper clubs.
// Uses Shopify's built-in /products.json endpoint for structured data.
// Map a Seat À La Table region/venue mention to a representative town + coords.
// Their events always name the region in the title or description, so we scan
// that text. Most specific (town/château) matches win over broad region names.
function seatLocation(text) {
  const t = (text || '').toLowerCase();
  const PLACES = [
    [/\bpommard\b/,                              { city: 'Pommard',         region: 'Bourgogne-Franche-Comté', lat: 46.9742, lng: 4.7950 }],
    [/\bbeaune\b|côte de beaune|armand heitz/,   { city: 'Beaune',          region: 'Bourgogne-Franche-Comté', lat: 47.0257, lng: 4.8397 }],
    [/\bbourgogne\b|\bburgundy\b/,               { city: 'Beaune',          region: 'Bourgogne-Franche-Comté', lat: 47.0257, lng: 4.8397 }],
    [/martillac|smith haut.?lafitte/,            { city: 'Martillac',       region: 'Nouvelle-Aquitaine',      lat: 44.7197, lng: -0.5556 }],
    [/\bbordeaux\b|\bmédoc\b|saint.?émilion/,    { city: 'Bordeaux',        region: 'Nouvelle-Aquitaine',      lat: 44.8378, lng: -0.5792 }],
    [/\bépernay\b|\bepernay\b/,                  { city: 'Épernay',         region: 'Grand Est',               lat: 49.0440, lng: 3.9597 }],
    [/\breims\b|\bchampagne\b|edouard duval/,    { city: 'Reims',           region: 'Grand Est',               lat: 49.2583, lng: 4.0317 }],
    [/montdomaine|\bvouvray\b|\bchinon\b|\bloire\b/,{ city: 'Tours',        region: 'Centre-Val de Loire',     lat: 47.3941, lng: 0.6848 }],
    [/\bversailles\b/,                           { city: 'Versailles',      region: 'Île-de-France',           lat: 48.8014, lng: 2.1301 }],
    [/\bprovence\b|luberon|\baix\b/,             { city: 'Aix-en-Provence', region: "Provence-Alpes-Côte d'Azur", lat: 43.5297, lng: 5.4474 }],
    [/\brouen\b|normandie|normandy|couronne/,    { city: 'Rouen',           region: 'Normandie',               lat: 49.4432, lng: 1.0993 }],
    [/alsace|elsass|strasbourg/,                 { city: 'Strasbourg',      region: 'Grand Est',               lat: 48.5734, lng: 7.7521 }],
    [/lapérouse|laperouse|\bparis\b/,            { city: 'Paris',           region: 'Île-de-France',           lat: 48.8566, lng: 2.3522 }],
    [/zermatt|st.?\s*moritz|switzerland|suisse/, { city: 'Zermatt',         region: 'Valais',                  lat: 46.0207, lng: 7.7491 }],
  ];
  for (const [re, loc] of PLACES) if (re.test(t)) return loc;
  return null;
}


async function scrapeSeatALaTable(dateFrom) {
  let found = 0, added = 0;
  const BASE = 'https://seatalatable.com';
  // French month names for date parsing (used in product descriptions/titles)
  const MOIS = {
    'janvier':0,'jan':0,'février':1,'fevrier':1,'fév':1,'fev':1,
    'mars':2,'avril':3,'avr':3,'mai':4,'juin':5,
    'juillet':6,'juil':6,'août':7,'aout':7,'aoû':7,
    'septembre':8,'sept':8,'sep':8,'octobre':9,'oct':9,
    'novembre':10,'nov':10,'décembre':11,'decembre':11,'déc':11,'dec':11
  };

  // Try to parse a date from text like "30 May 2026", "30 mai 2026", "30/05/2026"
  function parseEventDate(text) {
    if (!text) return null;
    const t = text.toLowerCase();
    // English month name: "30 May 2026"
    const enMonths = ['january','february','march','april','may','june','july','august','september','october','november','december'];
    for (let i = 0; i < enMonths.length; i++) {
      const re = new RegExp(`(\\d{1,2})\\s+${enMonths[i]}\\s+(\\d{4})`, 'i');
      const m = t.match(re);
      if (m) {
        const d = new Date(Date.UTC(parseInt(m[2]), i, parseInt(m[1])));
        if (!isNaN(d)) return d.toISOString();
      }
    }
    // French month name: "30 mai 2026"
    for (const [name, idx] of Object.entries(MOIS)) {
      const re = new RegExp(`(\\d{1,2})\\s+${name}\\s+(\\d{4})`, 'i');
      const m = t.match(re);
      if (m) {
        const d = new Date(Date.UTC(parseInt(m[2]), idx, parseInt(m[1])));
        if (!isNaN(d)) return d.toISOString();
      }
    }
    // Numeric: "30/05/2026" or "30-05-2026"
    const num = t.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
    if (num) {
      const d = new Date(Date.UTC(parseInt(num[3]), parseInt(num[2])-1, parseInt(num[1])));
      if (!isNaN(d)) return d.toISOString();
    }
    return null;
  }

  // Pull products from the upcoming-events collection JSON
  for (let page = 1; page <= 5; page++) {
    try {
      const url = `${BASE}/collections/upcoming-events/products.json?limit=50&page=${page}`;
      const res = await fetch(url, { headers: { 'User-Agent': 'SoirFR/1.0' } });
      if (!res.ok) break;
      const data = await res.json();
      const products = data.products || [];
      if (!products.length) break;
      found += products.length;

      for (const p of products) {
        // Build searchable text from title + description body to find the date
        const bodyText = (p.body_html || '').replace(/<[^>]+>/g, ' ');
        const searchText = `${p.title} ${bodyText}`;
        const startsAt = parseEventDate(searchText);
        if (!startsAt) continue; // skip "Register Interest" events with no date

        // Category: wine/champagne/dégustation → degustation, otherwise gastronomie
        const tLower = p.title.toLowerCase();
        let category = 'gastronomie';
        if (/champagne|wine|vin|degustation|dégustation|terroir|vignoble|château/i.test(tLower)) {
          category = 'degustation';
        }

        // Location: these events always name their region/town in the title or
        // description. Read it out and map to coordinates so they can be placed.
        const loc = seatLocation(searchText);

        // Price from first variant
        const variant = p.variants?.[0];
        const priceMin = variant?.price ? parseFloat(variant.price) : null;

        const ins = await insertEvent({
          title: p.title,
          description: bodyText.slice(0, 1000).trim() || null,
          category,
          city: loc?.city || null,
          region: loc?.region || null,
          lat: loc?.lat, lng: loc?.lng,
          country: 'FR',
          starts_at: startsAt,
          image_url: p.images?.[0]?.src || null,
          price_min: priceMin,
          is_free: false,
          booking_url: `${BASE}/products/${p.handle}`,
          source_url: `${BASE}/products/${p.handle}`,
          source_event_id: String(p.id),
          source_name: 'seat_a_la_table',
        });
        if (ins) added++;
      }

      // Stop if fewer than 50 returned (last page)
      if (products.length < 50) break;
      await sleep(500);
    } catch { break; }
  }
  return { source: 'Seat À La Table', found, added };
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
        // Skip only events that are fully OVER. An exhibition that started last
        // month but runs until September is live — judge by endDate when present.
        const liveRef = String(item.endDate || item.startDate || '').slice(0, 10);
        if (liveRef && liveRef < dateFrom) continue;
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
  if (isJunk(ev.title, ev.description)) return false;
  if (ADDS_USED >= ADD_BUDGET) return false;   // per-run insert cap (time budget)

  // Same-source dedup: load this source's existing IDs once per run (one query),
  // then check in memory. Avoids a database round-trip for every single event.
  if (ev.source_event_id&&ev.source_name) {
    const id = String(ev.source_event_id).slice(0,200);
    if (!KNOWN_BY_SOURCE[ev.source_name]) {
      const rows = await sbFetch(`events?source_name=eq.${encodeURIComponent(ev.source_name)}&select=source_event_id&limit=20000`, 'GET');
      KNOWN_BY_SOURCE[ev.source_name] = new Set((rows||[]).map(r => String(r.source_event_id)));
    }
    if (KNOWN_BY_SOURCE[ev.source_name].has(id)) return false;
  }

  // Cross-source duplicates are caught at the database level by the dedup_key
  // unique index (added during the duplicate cleanup), so no per-event spatial
  // lookup is needed here — that check was making every new insert ~3x slower.
  const lat=parseFloat(ev.lat), lng=parseFloat(ev.lng);

  const loc=(!isNaN(lat)&&!isNaN(lng)&&lat!==0&&lng!==0)?`POINT(${lng} ${lat})`:null;
  const _inserted = await sbFetch('events','POST',{
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
  if (_inserted) {
    ADDS_USED++;
    if (ev.source_name && ev.source_event_id) {
      (KNOWN_BY_SOURCE[ev.source_name] ||= new Set()).add(String(ev.source_event_id).slice(0,200));
    }
  }
  return _inserted;
}

async function sbFetch(path,method='GET',body=null) {
  try {
    // RPC calls need the response body back; standard POSTs (table inserts) use return=minimal
    const isRpc = path.startsWith('rpc/');
    const wantsBody = method === 'GET' || isRpc;
    const res=await fetch(`${SB_URL}/rest/v1/${path}`,{
      method, body: body?JSON.stringify(body):null,
      headers:{
        'apikey':SB_KEY,
        'Authorization':`Bearer ${SB_KEY}`,
        'Content-Type':'application/json',
        'Prefer': (method==='POST' && !isRpc) ? 'return=minimal' : ''
      },
    });
    if (wantsBody) return await res.json();
    return res.ok;
  } catch { return null; }
}

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

// ── Expire events whose dates have passed ─────────────────────────────────
// PATCH active rows to status='expired' when (ends_at < today) or
// (no ends_at and starts_at < today). Returns how many rows were expired.
async function expireOldEvents(today) {
  const filter = `status=eq.active&or=(and(ends_at.is.null,starts_at.lt.${today}),and(ends_at.not.is.null,ends_at.lt.${today}))`;
  const res = await fetch(`${SB_URL}/rest/v1/events?${filter}`, {
    method: 'PATCH',
    headers: {
      'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal, count=exact'
    },
    body: JSON.stringify({ status: 'expired' })
  });
  if (!res.ok) throw new Error(`expire HTTP ${res.status}`);
  const range = res.headers.get('content-range') || '';
  const m = range.match(/\/(\d+)/);
  return m ? parseInt(m[1]) : 0;
}

// ── Geocode events missing coordinates ───────────────────────────────────
async function geocodeMissingEvents() {
  // Get events with no location but have city or postcode
  const missing = await sbFetch(
    "events?select=id,city,postcode,address&location=is.null&status=eq.active&limit=100",
    'GET'
  );
  if (!missing || !missing.length) return 0;

  let geocoded = 0;
  for (const ev of missing) {
    const query = [ev.address, ev.city, ev.postcode, 'France']
      .filter(Boolean).join(' ');
    if (!query.trim()) continue;

    try {
      const r = await fetch(
        `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(query)}&limit=1`
      );
      if (!r.ok) continue;
      const data = await r.json();
      const feat = data.features?.[0];
      if (!feat) continue;

      const lng = feat.geometry.coordinates[0];
      const lat = feat.geometry.coordinates[1];
      const city = feat.properties.city || feat.properties.municipality || ev.city;

      // Update via PATCH
      const res = await fetch(`${SB_URL}/rest/v1/events?id=eq.${ev.id}`, {
        method: 'PATCH',
        headers: {
          'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`,
          'Content-Type': 'application/json', 'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          location: `POINT(${lng} ${lat})`,
          city: ev.city || city,
        })
      });
      if (res.ok) geocoded++;
      await sleep(100); // be gentle with the geocoding API
    } catch {}
  }
  return geocoded;
}

function isJunk(title, description) {
  if (!title) return true;
  const t = title.toLowerCase();

  // Job/recruitment — specific phrases only
  const junkPhrases = [
    'recrutement sans cv', 'recrute des ', 'recrute un ', 'recrutez sans',
    'manpower', 'adecco', 'france travail', 'pôle emploi',
    'job corner', 'job dating', 'job forum',
    "les mercredis de l'intérim", 'les mardis du transport',
    "mardis de l'intérim", "mercredis de l'intérim",
    'ras interim', 'kelyps', 'interaction interim',
    'préparateur de commandes',
    'équipier de production industrielle',
    'conducteur de ligne en contrat',
    'formation en soudure', 'formation frigoriste',
    'aftral', 'keolis recrutement',
    'asimat', 'axdom', 'uimm',
    "document unique d'evaluation",
    'transfert de gros fichiers', 'les fichiers pdf',
    'découvrez facebook simplement', 'déchetterie mobile',
    'super u de ', 'u express de ',
    'poids lourd', 'conducteur de bus',
    'devenez chauffeur',
    'logistique recrutement', 'transport logistique recrutement',
    // Business/startup events
    'startbat', 'créateurs entreprise du secteur',
    'accompagnement des créateurs', 'secteur du bâtiment',
    'retouche photo', "création d'entreprise",
    // More interim/job patterns
    "les mercredis de l'intérim", "les mardis de l'intérim",
    'les mardis du transport', 'les mercredis du transport',
    "permanence de l'agence", 'permanence leader',
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
    '
