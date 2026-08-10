// SoirFR event scraper. All sources run in one handler on the daily
// /api/scrape cron. Source order is load-bearing: see insertEvent().

const SB_URL = 'https://ebinsidruxvbzukobshf.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'sb_publishable_QSnlPXEopb6x8m8N3K396Q_YPazJ0IM';

// Burgundy core (21,71,89,58), rural edges (03,18,45,10,52),
// Jura/Franche-Comté (39,25,70), south toward Lyon (01,69).
const DEPTS_REGION = ['21','71','89','58','03','18','45','10','52','39','25','70','01','69'];
// Île-de-France: Paris (75) + petite couronne (92, 93, 94) + grande couronne (77, 78, 91, 95)
const DEPTS_IDF = ['75','77','78','91','92','93','94','95'];
// Departments covered by the brocante sources (BFC + IdF).
const DEPTS_BROCANTE = [...DEPTS_REGION, ...DEPTS_IDF];

// Map a dept code to its region name (used to tag events correctly)
function regionForDept(dept) {
  if (DEPTS_IDF.includes(dept)) return 'Île-de-France';
  return 'Bourgogne-Franche-Comté';
}

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

  // ── 0. Expire finished events ──────────────────────────────────────────
  try {
    const expired = await expireOldEvents(dateFrom);
    results.push({ source: 'expire_maintenance', found: expired, added: 0 });
  } catch (e) { errors.push({ source: 'expire_maintenance', error: e.message }); }

  // Source order is deliberate. Cross-source duplicates are rejected by the
  // dedup_key unique index, so whichever source inserts first wins the row.
  // Richer, more local sources therefore run before broad region-wide ones.

  // ── 1a. Achalon (Office de Tourisme Chalon-sur-Saône) ──────────────────
  // schema.org JSON-LD plus a tariffs object and contact number. Replaces
  // the old Infolocale scraper, whose URL now 404s.
  try { results.push(await scrapeAchalon(dateFrom)); }
  catch (e) { errors.push({ source: 'achalon', error: e.message }); }

  // ── 1b. Le JSL "PourSortir" ────────────────────────────────────────────
  // Listing cards carry schema.org microdata including lat/lng, so no
  // detail-page visit is needed.
  try { results.push(await scrapeLejsl(dateFrom)); }
  catch (e) { errors.push({ source: 'lejsl', error: e.message }); }

  // ── 1c. Destination Saône-et-Loire (CDT71) ─────────────────────────────
  // Departmental tourism board. Shares a Tourinsoft backend with several
  // town-level tourism sites, so it covers more than a per-town scraper.
  try { results.push(await scrapeDestinationSaoneEtLoire(dateFrom)); }
  catch (e) { errors.push({ source: 'destination71', error: e.message }); }

  // ── 1d. Animation2c (Côte Chalonnaise) ─────────────────────────────────
  // Hyper-local, but carries a real structured date field. Single fetch.
  try { results.push(await scrapeAnimation2c(dateFrom)); }
  catch (e) { errors.push({ source: 'animation2c', error: e.message }); }

  // ── 2. eTerritoire ─────────────────────────────────────────────────────
  // Highest volume and widest reach, thinnest data. Runs after the richer
  // Chalon-area sources above.
  try { results.push(await scrapeETerritoire(dateFrom)); }
  catch (e) { errors.push({ source: 'eterritoire', error: e.message }); }

  // ── 3. Agenda Culturel 71 (RSS) ────────────────────────────────────────
  try { results.push(await scrapeAgendaCulturel71(dateFrom)); }
  catch (e) { errors.push({ source: 'agenda_culturel_71', error: e.message }); }

  // Backfill coordinates from city/postcode. Runs here rather than at the
  // end: every source above ships city-only rows, and the sleep-heavy
  // scrapers below can exhaust the function's time budget before a trailing
  // pass would finish. A row with no location never reaches the map.
  try {
    const geocoded = await geocodeMissingEvents();
    results.push({ source: 'geocoder', found: geocoded, added: geocoded });
  } catch(e) { errors.push({ source: 'geocoder', error: e.message }); }

  // ── 4. Calendrier des Brocantes (returns real JSON with lat/lng) ────────
  try { results.push(await scrapeCalendrierBrocantes(dateFrom)); }
  catch (e) { errors.push({ source: 'calendrier_brocantes', error: e.message }); }

  // ── 5. Brocabrac (all brocante departments) ────────────────────────────
  try { results.push(await scrapeBrocabrac(DEPTS_BROCANTE, dateFrom)); }
  catch (e) { errors.push({ source: 'brocabrac', error: e.message }); }

  // vide-greniers.org was removed: its robots.txt disallows crawling.

  // ── 6. JDS Saône-et-Loire (JSON-LD) ───────────────────────────────────
  try { results.push(await scrapeJDS(dateFrom)); }
  catch (e) { errors.push({ source: 'jds', error: e.message }); }

  // ── 7. Bourgogne Tourisme — DISABLED ──────────────────────────────────
  // Detail pages respond slowly enough to consume the whole run.
  // try { results.push(await scrapeBourgogneTourisme(dateFrom)); }
  // catch (e) { errors.push({ source: 'bourgogne_tourisme', error: e.message }); }

  // ── 8. OpenAgenda API — 14 rural/regional departments ─────────────────
  if (OA_KEY) {
    try { results.push(await scrapeOAApi(OA_KEY, DEPTS_REGION, dateFrom, dateTo)); }
    catch (e) { errors.push({ source: 'oa_api', error: e.message }); }
  }

  // ── 9. Paris Open Data — DISABLED (too random, off-brand for now) ─────
  // try { results.push(await scrapeParisOpenData(dateFrom)); }
  // catch (e) { errors.push({ source: 'paris', error: e.message }); }

  // ── 10. Ticketmaster France ──────────────────────────────────────────
  if (TM_KEY) {
    try { results.push(await scrapeTicketmaster(TM_KEY, dateFrom, dateTo)); }
    catch (e) { errors.push({ source: 'ticketmaster', error: e.message }); }
  }

  // ── 11. Seat À La Table — curated French food/wine experiences ────────
  try { results.push(await scrapeSeatALaTable(dateFrom)); }
  catch (e) { errors.push({ source: 'seat_a_la_table', error: e.message }); }

  // Second pass for anything inserted since. No-op when nothing is left.
  try {
    const geocoded = await geocodeMissingEvents();
    results.push({ source: 'geocoder_2', found: geocoded, added: geocoded });
  } catch(e) { errors.push({ source: 'geocoder_2', error: e.message }); }

  const total_added = results.reduce((s,r) => s+(r.added||0), 0);
  const total_found = results.reduce((s,r) => s+(r.found||0), 0);

  // One row per source alongside the run total. Without the per-source rows
  // there is no way to tell a source that fetched nothing (found 0) from one
  // that parsed fine but could not insert (found > 0, added 0). A source that
  // never ran leaves no row, which marks where a timed-out run stopped.
  const finishedAt = new Date().toISOString();
  await sbFetch('scrape_logs', 'POST', [
    {
      source_name: 'all_v5', finished_at: finishedAt,
      events_found: total_found, events_added: total_added,
      status: errors.length === 0 ? 'success' : 'partial',
      error_message: errors.length ? JSON.stringify(errors.slice(0,10)) : null,
    },
    ...results.map(r => ({
      source_name: String(r.source || 'unknown').slice(0, 100),
      finished_at: finishedAt,
      events_found: r.found || 0, events_added: r.added || 0,
      status: 'success', error_message: null,
    })),
    ...errors.map(e => ({
      source_name: String(e.source || 'unknown').slice(0, 100),
      finished_at: finishedAt,
      events_found: 0, events_added: 0,
      status: 'error', error_message: String(e.error || '').slice(0, 500),
    })),
  ]);

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

      // Cards give title, date, city and category. Dates come as either
      // "Le DD/MM/YYYY" or "Du DD/MM/YYYY au DD/MM/YYYY" (exhibitions,
      // festivals); both forms must match or every range event is dropped.
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
        // Image is optional; falls back to null.
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

        // <pubDate> is the publication date, not the event date. Parse the
        // real one out of the title/description, and skip if there isn't one.
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

// ── Achalon (Office de Tourisme Chalon-sur-Saône) ──────────────────────────
// Static listing linking to /offres/<slug>/ detail pages. Each detail page
// carries schema.org Event JSON-LD, a tariffs object with the real price, and
// a phone number in a data-label attribute. All of it is in the server HTML.
async function scrapeAchalon(dateFrom) {
  let found = 0, added = 0;
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
  const LISTING = 'https://www.achalon.com/homepage-tourisme/agenda/exhaustif/';

  const html = await fetch(LISTING, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) }).then(r => r.text());
  const links = [...new Set([...html.matchAll(/href="(https:\/\/www\.achalon\.com\/offres\/[^"]+?)"/g)].map(m => m[1]))];

  for (const url of links.slice(0, 60)) {
    if (ADDS_USED >= ADD_BUDGET) break;
    try {
      const dhtml = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) }).then(r => r.text());
      const ldMatch = dhtml.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
      if (!ldMatch) continue;
      let data;
      try { data = JSON.parse(ldMatch[1]); } catch { continue; }
      const graph = data['@graph'] || [data];
      const ev = graph.find(g => g['@type'] === 'Event');
      if (!ev || !ev.startDate) continue;
      found++;

      const startDate = ev.startDate.slice(0, 10);
      const endDate = ev.endDate ? ev.endDate.slice(0, 10) : null;
      if ((endDate || startDate) < dateFrom) continue;

      const priceM = dhtml.match(/"tariffStandard":"([\d.]+)"/);
      const phoneM = dhtml.match(/data-label="Contact[^"]*-\s*([\d\s.]{9,15})"/);
      const addr = (ev.location && ev.location.address) || {};
      const geo = (ev.location && ev.location.geo) || {};

      let description = ev.description || null;
      if (phoneM) description = (description ? description + '\n\n' : '') + `Contact : ${phoneM[1].trim()}`;

      const ins = await insertEvent({
        title: ev.name,
        description,
        category: mapCat((ev.name || '') + ' ' + (ev.description || '')),
        address: addr.streetAddress || null,
        city: addr.addressLocality || null,
        postcode: addr.postalCode || null,
        department: '71', region: 'Bourgogne-Franche-Comté',
        lat: geo.latitude, lng: geo.longitude,
        starts_at: ev.startDate, ends_at: ev.endDate || null,
        image_url: Array.isArray(ev.image) ? ev.image[0] : (ev.image || null),
        price_min: priceM ? parseFloat(priceM[1]) : null,
        is_free: !priceM && /gratuit/i.test(dhtml),
        booking_url: url, source_url: url,
        source_event_id: url.split('/').filter(Boolean).pop(),
        source_name: 'achalon',
      });
      if (ins) added++;
    } catch {}
    await sleep(300);
  }
  return { source: 'Achalon', found, added };
}

// ── Le JSL (Journal de Saône-et-Loire) "PourSortir" ───────────────────────
// Department-wide listing ("Loisir" = all categories). Each card is
// schema.org Event microdata: name, url, description, startDate, theme,
// addressLocality, lat/lng, all in the server HTML. Detail pages render
// time, price and organizer client-side, so those are not reachable.
async function scrapeLejsl(dateFrom) {
  let found = 0, added = 0;
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
  const BASE = 'https://www.lejsl.com/pour-sortir/Loisir/Bourgogne/Saone-et-loire';
  const MAX_PAGES = 15; // ~30 events/page; budget-limited anyway via ADD_BUDGET

  for (let page = 1; page <= MAX_PAGES; page++) {
    if (ADDS_USED >= ADD_BUDGET) break;
    const url = page === 1 ? BASE : `${BASE}?page=${page}`;
    let html;
    try {
      html = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) }).then(r => r.text());
    } catch { break; }

    const blocks = [...html.matchAll(/itemtype="https:\/\/schema\.org\/Event">([\s\S]*?)<\/li>/g)];
    if (!blocks.length) break;

    for (const [, block] of blocks) {
      const titleM = block.match(/<h2 itemprop="name"><a itemprop="url" href="([^"]+)"[^>]*>([^<]+)<\/a>/);
      const dateM = block.match(/itemprop="startDate" content="([^"]+)"/);
      if (!titleM || !dateM) continue;
      found++;

      const startDate = dateM[1].slice(0, 10);
      if (startDate < dateFrom) continue;

      const descM = block.match(/itemprop="description">([^<]*)</);
      const themeM = block.match(/class="theme">([^<]+)</);
      const cityM = block.match(/itemprop="addressLocality">([^<]+)</);
      const latM = block.match(/itemprop="latitude" content="([^"]+)"/);
      const lngM = block.match(/itemprop="longitude" content="([^"]+)"/);
      const href = titleM[1].startsWith('http') ? titleM[1] : `https://www.lejsl.com${titleM[1]}`;

      const ins = await insertEvent({
        title: titleM[2].trim(),
        description: descM ? descM[1].trim() : null,
        category: mapCat(titleM[2] + ' ' + (themeM ? themeM[1] : '') + ' ' + (descM ? descM[1] : '')),
        city: cityM ? cityM[1] : null,
        department: '71', region: 'Bourgogne-Franche-Comté',
        lat: latM ? latM[1] : null, lng: lngM ? lngM[1] : null,
        starts_at: dateM[1],
        source_url: href, booking_url: href,
        source_event_id: href.split('/').filter(Boolean).slice(-2).join('_'),
        source_name: 'lejsl',
      });
      if (ins) added++;
      if (ADDS_USED >= ADD_BUDGET) break;
    }
    await sleep(400);
  }
  return { source: 'LeJSL', found, added };
}

// ── Destination Saône-et-Loire (CDT71) ────────────────────────────────────
// Drupal, no structured data anywhere: .OfferTeaser cards on the listing,
// .properties / .location-name / accordions on detail pages. Shares its
// Tourinsoft backend with several town tourism sites, so one scraper here
// covers what a handful of per-town scrapers would.
//
// ~1500 events over ~127 listing pages, too many detail fetches for a single
// run, so this walks the first MAX_LISTING_PAGES each time. Same-source dedup
// on slug+date means later runs advance onto pages not yet reached.
//
// Dates live in the free-text "Ouverture" accordion, whose format varies
// widely. Only the clean bulleted form is parsed; recurring schedules are
// skipped rather than guessed, since a wrong date is worse than no event.
async function scrapeDestinationSaoneEtLoire(dateFrom) {
  let found = 0, added = 0;
  const BASE = 'https://www.destination-saone-et-loire.fr';
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
  const MAX_LISTING_PAGES = 8; // ~11 events/page — later pages covered by later runs

  const MONTHS = { janvier:1, 'février':2, fevrier:2, mars:3, avril:4, mai:5, juin:6,
    juillet:7, 'août':8, aout:8, septembre:9, octobre:10, novembre:11, 'décembre':12, decembre:12 };
  const MONTH_ALT = Object.keys(MONTHS).join('|');

  // 1. Collect detail-page links across the first few listing pages
  const links = new Set();
  for (let page = 0; page < MAX_LISTING_PAGES; page++) {
    if (ADDS_USED >= ADD_BUDGET) break;
    try {
      const url = `${BASE}/fr/les-evenements-en-saone-et-loire.html?page=${page}`;
      const html = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) }).then(r => r.text());
      const pageLinks = [...html.matchAll(/href="(\/fr\/evenement\/[^"]+\.html)"/g)].map(m => m[1]);
      if (!pageLinks.length) break;
      pageLinks.forEach(l => links.add(l));
    } catch { break; }
    await sleep(400);
  }

  // 2. Visit each detail page and extract what's there
  for (const link of links) {
    if (ADDS_USED >= ADD_BUDGET) break;
    const slug = link.split('/').pop().replace(/\.html$/, '');
    try {
      const url = BASE + link;
      const html = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) }).then(r => r.text());

      const titleM = html.match(/<h1[^>]*>\s*<span>([^<]+)<\/span>/);
      if (!titleM) continue;
      found++;

      const openingM = html.match(/<h3[^>]*>\s*Ouverture\s*<\/h3>[\s\S]{0,50}?<div class="accordion-content"[^>]*>([\s\S]*?)<\/div>/);
      if (!openingM) continue;
      const dates = parseDestination71Dates(openingM[1], MONTHS, MONTH_ALT, dateFrom);
      if (!dates.length) continue; // recurring/vague schedule — skip rather than guess

      const title = decodeHtmlEntities(titleM[1].trim()).slice(0, 200);
      const themeM = html.match(/Th[ée]matique\s*:\s*([^<]+)/);
      const cityM = html.match(/class="location-name"[^>]*>([^<]+)</);
      const descM = html.match(/<h3[^>]*>\s*Description\s*<\/h3>[\s\S]{0,50}?<div class="accordion-content"[^>]*>([\s\S]*?)<\/div>/);
      const imgM = html.match(/<img class="slide-img" src="([^"]+)"/);

      const city = cityM ? titleCaseCity(cityM[1].trim()) : null;
      const description = descM
        ? decodeHtmlEntities(descM[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 1000)
        : null;
      const category = mapCat(`${title} ${themeM ? themeM[1] : ''}`);
      const imageUrl = imgM ? (imgM[1].startsWith('http') ? imgM[1] : BASE + imgM[1]) : null;

      for (const d of dates) {
        if (ADDS_USED >= ADD_BUDGET) break;
        const ins = await insertEvent({
          title, description, category, city,
          department: '71', region: 'Bourgogne-Franche-Comté',
          starts_at: d.starts_at, ends_at: d.ends_at,
          image_url: imageUrl,
          source_url: url, booking_url: url,
          source_event_id: `${slug}-${d.starts_at}`,
          source_name: 'destination71',
        });
        if (ins) added++;
      }
    } catch {}
    await sleep(350);
  }
  return { source: 'Destination Saône-et-Loire', found, added };
}

// Parse the "Ouverture" free text into discrete dates. Only trusts a
// "MOIS ANNÉE :" header followed by "* Jour DD Mois[/MM]" bullets. Recurring
// schedules, ranges and opening-hours exceptions all return [].
function parseDestination71Dates(raw, MONTHS, MONTH_ALT, dateFrom) {
  const text = decodeHtmlEntities(raw).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '\n');
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  const headerRe = new RegExp(`^(${MONTH_ALT})\\s+(\\d{4})\\s*:?$`, 'i');
  const bulletRe = new RegExp(`^\\*?\\s*[A-Za-zÀ-ÿ]+\\.?\\s+(\\d{1,2})(?:\\s+(${MONTH_ALT})|\\/(\\d{1,2}))\\s*\\.?\\s*:?\\s*(.*)$`, 'i');

  const results = [];
  let currentYear = null;
  for (const line of lines) {
    const hM = line.match(headerRe);
    if (hM) { currentYear = parseInt(hM[2], 10); continue; }

    const bM = line.match(bulletRe);
    if (!bM) continue;
    const day = parseInt(bM[1], 10);
    const month = bM[2] ? MONTHS[bM[2].toLowerCase()] : parseInt(bM[3], 10);
    if (!day || !month || month < 1 || month > 12 || day < 1 || day > 31) continue;

    let year = currentYear || parseInt(dateFrom.slice(0, 4), 10);
    let iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    // No header year on this line and the date has passed: assume next year.
    if (!currentYear && iso < dateFrom) {
      year += 1;
      iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    if (iso < dateFrom) continue; // still past after inference

    // "à 19h", "de 19h à 0h30". Default 20:00 when no time is given.
    const rest = bM[4] || '';
    const timeM = rest.match(/(\d{1,2})h(\d{2})?/);
    const hh = timeM ? String(timeM[1]).padStart(2, '0') : '20';
    const mm = timeM && timeM[2] ? timeM[2] : '00';

    results.push({ starts_at: `${iso}T${hh}:${mm}:00`, ends_at: null });
  }
  return results;
}

function decodeHtmlEntities(s) {
  if (!s) return s;
  return s.replace(/&#0?39;/g, "'").replace(/&rsquo;/g, "'").replace(/&quot;/g, '"')
    .replace(/&eacute;/g, 'é').replace(/&egrave;/g, 'è').replace(/&ecirc;/g, 'ê')
    .replace(/&agrave;/g, 'à').replace(/&ccedil;/g, 'ç').replace(/&ocirc;/g, 'ô')
    .replace(/&ucirc;/g, 'û').replace(/&icirc;/g, 'î').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function titleCaseCity(s) {
  return s.toLowerCase().split(/([\s-])/)
    .map(w => (/^[\s-]$/.test(w) ? w : (w ? w.charAt(0).toUpperCase() + w.slice(1) : w)))
    .join('');
}

// ── Animation2c (Côte Chalonnaise) ────────────────────────────────────────
// Local association covering Givry and the surrounding villages. Their blog
// is noisy, so this reads the curated master calendar they publish as a
// Google Sheet, pulled as CSV. Column 0 is a YYMMDD sort key ("260702" =
// 2 July 2026) and column 3 is "[Jour] DD Mois [Année] - Commune - Titre -
// détails". ~170 rows covering a whole season, so one fetch, no pagination.
//
// The URL below is a Sheets "publish to web" link. If A2c republish, it 404s
// and needs replacing from the iframe on
// https://www.animation2c.fr/p/listing-des-manifestations.html (take the
// /pub?output=csv variant).
async function scrapeAnimation2c(dateFrom) {
  let found = 0, added = 0;
  const CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vS6Gj8CAfiEQf3okbFH4oQWh1_E4ol0RGfaNOGcGsCsJBBp66bIk3nf5SriRTdxb4sUgWTtFBT1qJef/pub?output=csv';
  const MONTHS = { janvier:1, 'février':2, fevrier:2, mars:3, avril:4, mai:5, juin:6,
    juillet:7, 'août':8, aout:8, septembre:9, octobre:10, novembre:11, 'décembre':12, decembre:12 };
  const MONTH_ALT = Object.keys(MONTHS).join('|');
  // Real rows open with a weekday, "Tout le mois", or "Du ... au ...". This
  // also drops the sheet's own intro text and vague placeholders ("Début
  // février 2027") that carry a valid-looking id but no parseable date.
  const PREFIX_RE = /^(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|tout le mois|du\s)/i;
  const WD = 'lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche';
  // "Du [jour] DD [mois] au [jour] DD mois [année]". The start month is
  // optional ("Du 27 au 29 mars 2026" shares the end's month), as is the year.
  const RANGE_RE = new RegExp(
    `du\\s+(?:(?:${WD})\\s+)?(\\d{1,2})(?:er)?\\s*(?:(${MONTH_ALT}))?\\s*au\\s+(?:(?:${WD})\\s+)?(\\d{1,2})(?:er)?\\s+(${MONTH_ALT})(?:\\s+(\\d{4}))?`,
    'i'
  );

  let text;
  try {
    text = await fetch(CSV_URL, { signal: AbortSignal.timeout(15000) }).then(r => r.text());
  } catch (e) { return { source: 'Animation2c', found: 0, added: 0 }; }

  for (const row of parseCsvRfc4180(text)) {
    if (ADDS_USED >= ADD_BUDGET) break;
    const idCol = (row[0] || '').trim();
    const seqCol = (row[1] || '').trim();
    const textCol = decodeHtmlEntities((row[3] || '').replace(/""/g, '"').replace(/\s+/g, ' ').trim());
    if (!/^\d{6}$/.test(idCol) || !PREFIX_RE.test(textCol)) continue;

    const yy = parseInt(idCol.slice(0, 2), 10);
    const mm = parseInt(idCol.slice(2, 4), 10);
    const dd = parseInt(idCol.slice(4, 6), 10);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) continue;
    const idIso = `${2000 + yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    found++;

    // Split on "hyphen + whitespace", not literal " - ". Commune names like
    // "Saint-Denis-de-Vaux" have no space around their hyphens, while the
    // sheet's field separators always carry at least a trailing one.
    const parts = textCol.split(/-\s+/).map(p => p.trim()).filter(Boolean);
    const city = parts[1] ? parts[1] : null;
    const title = (parts[2] || parts[1] || parts[0]).slice(0, 200);
    const description = parts.length > 3 ? parts.slice(3).join(' - ').slice(0, 1000) : null;

    // The id's YYMMDD is reliable for single-day rows, but on "Du X au Y"
    // rows it can drift from the dates the text itself states. The sheet is
    // hand-maintained, so for range phrasing the text wins.
    let startIso = idIso, endsAt = null;
    const rangeM = parts[0].match(RANGE_RE);
    if (rangeM) {
      const year = rangeM[5] ? parseInt(rangeM[5], 10) : (2000 + yy);
      const endMonth = MONTHS[rangeM[4].toLowerCase()];
      const startMonth = rangeM[2] ? MONTHS[rangeM[2].toLowerCase()] : endMonth;
      const startDay = parseInt(rangeM[1], 10), endDay = parseInt(rangeM[3], 10);
      if (startDay && startMonth) startIso = `${year}-${String(startMonth).padStart(2, '0')}-${String(startDay).padStart(2, '0')}`;
      if (endDay && endMonth) endsAt = `${year}-${String(endMonth).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`;
    }
    // Skip only if fully over, judging by end date when there is one.
    if ((endsAt || startIso) < dateFrom) continue;

    // Time of day only if the row states one. Otherwise leave the date bare
    // rather than invent a start time.
    const timeM = textCol.match(/(\d{1,2})\s?h\s?(\d{2})?\b/i);
    const startsAt = timeM
      ? `${startIso}T${String(timeM[1]).padStart(2, '0')}:${timeM[2] || '00'}:00`
      : startIso;

    const ins = await insertEvent({
      title, description, category: mapCat(title),
      // No department: the list carries nearby regional picks too (a Dijon
      // exhibition appeared in it), so '71' would mislabel them. Geocoding
      // works off city regardless.
      city, region: 'Bourgogne-Franche-Comté',
      starts_at: startsAt, ends_at: endsAt,
      source_url: 'https://www.animation2c.fr/p/reservations.html',
      source_event_id: `${idCol}-${seqCol}`,
      source_name: 'animation2c',
    });
    if (ins) added++;
  }
  return { source: 'Animation2c', found, added };
}

// Minimal RFC4180 CSV parser. Needed because several cells in the sheet
// contain embedded newlines and doubled-quote escaping, which a split on
// ',' / '\n' cannot handle.
function parseCsvRfc4180(t) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inQuotes) {
      if (c === '"') { if (t[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
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
        // May be truncated; close the array before parsing.
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
// The agenda listing links to per-event pages (/agenda/<slug>), which carry
// full structured data including their own URL. Reading the listing's own
// sparse data instead gave events with no real per-event link.
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
      // baseUrl is the event page itself, so source_url resolves even when
      // the markup omits it.
      const r = await extractJsonLd(ehtml, '21', 'Bourgogne-Franche-Comté', 'bourgogne_tourisme', BASE + path, dateFrom, null);
      found += r.found; added += r.added;
    } catch {}
    await sleep(250);
  }
  return { source: `Bourgogne Tourisme (${pages} pages read, ${paths.length} links found)`, found, added };
}

// ── OpenAgenda API ────────────────────────────────────────────────────────
// Events live under their agenda, so a bare /events/<slug> URL returns 403.
// Prefer canonicalUrl, otherwise rebuild from the origin agenda.
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
    // OpenAgenda lists every session of a recurring event oldest first, so
    // timings[0] is often years past. Take the soonest one still running.
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
  // Geo-targeted circles rather than one nationwide list, which returned
  // mostly out-of-coverage events.
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
// Curated food and wine experiences, read from Shopify's /products.json.
// Events name their region in the title or description, so map that text to a
// representative town and coordinates. Most specific match wins.
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
        // Skip only events fully over, judging by endDate when present.
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

  // Cross-source duplicates are rejected by the dedup_key unique index, so no
  // per-event spatial lookup here. That check made inserts roughly 3x slower.
  const lat=parseFloat(ev.lat), lng=parseFloat(ev.lng);

  const loc=(!isNaN(lat)&&!isNaN(lng)&&lat!==0&&lng!==0)?`POINT(${lng} ${lat})`:null;
  const _inserted = await sbFetch('events','POST',{
    title: String(ev.title).slice(0,500), description: ev.description||null,
    category: ev.category||'autre', address: ev.address||null,
    city: ev.city||null, postcode: ev.postcode||null,
    department: ev.department||null, region: ev.region||null, country: ev.country||'FR',
    location: loc, starts_at: asParisTime(ev.starts_at), ends_at: asParisTime(ev.ends_at),
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

// ── Local time, stored correctly ──────────────────────────────────────────
// Every source here publishes wall-clock times for Bourgogne, but a bare
// "2026-08-11T18:00" handed to Postgres is read as UTC, which put every event
// two hours late in summer. Date-only values had the same problem in reverse:
// they landed at 02:00 the same morning instead of midnight.
//
// This stamps the Paris offset on anything that has no timezone of its own.
// Values that already carry Z or an offset (Ticketmaster, OpenAgenda) are
// left exactly as they are.
function parisOffset(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const y = d.getUTCFullYear();
  const lastSunday = (year, month) => {
    const last = new Date(Date.UTC(year, month + 1, 0));
    return new Date(Date.UTC(year, month, last.getUTCDate() - last.getUTCDay()));
  };
  return (d >= lastSunday(y, 2) && d < lastSunday(y, 9)) ? '+02:00' : '+01:00';
}

function asParisTime(value) {
  if (!value) return null;
  const v = String(value).trim();
  const m = v.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(:\d{2})?)?$/);
  if (!m) return value;                    // already has a zone, or not a date
  const day = m[1];
  const time = m[2] ? `${m[2]}${m[3] || ':00'}` : '00:00:00';
  return `${day}T${time}${parisOffset(day)}`;
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
  // destination71 and animation2c ship city-only rows by design and rely
  // entirely on this pass, so the per-run backlog is larger than the
  // original limit of 100 allowed for.
  const missing = await sbFetch(
    "events?select=id,city,postcode,address&location=is.null&status=eq.active&limit=250",
    'GET'
  );
  if (!missing || !missing.length) return 0;

  let geocoded = 0;
  for (const ev of missing) {
    const parts = [ev.address, ev.city, ev.postcode].filter(Boolean);
    if (!parts.length) continue;
    const query = parts.join(' ');

    // Two traps in this API. Appending "France" breaks short queries:
    // "Givry France" returns nothing where "Givry" alone matches, and the
    // API is France-only anyway. And a bare city name has nothing to anchor
    // it, so "Givry" resolves to a same-named hamlet in the Cher; restrict
    // those to type=municipality. Queries that already carry an address or
    // postcode skip the restriction, which would exclude valid matches.
    const isBareCity = !ev.address && !ev.postcode;
    const url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(query)}&limit=1${isBareCity ? '&type=municipality' : ''}`;

    try {
      const r = await fetch(url);
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
      await sleep(100); // rate-limit courtesy
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
    "les mardis de l'intérim", 'les mercredis du transport',
    "permanence de l'agence", 'permanence leader',
    'actual interim',
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

  // A2c's "Balade enchantée" is a themed night walk through Givry built on
  // local history, not a nature walk, so it has to be caught before the
  // generic \bbalade\b match below. Plain "Balade du Mardi" still falls
  // through to nature.
  if(/balade enchant/.test(r)) return 'patrimoine';

  // Whole words or clear phrases only, to avoid false positives.
  if(/\bconcert\b|\bjazz\b|\brock\b|\bchanson\b|\borchestre\b|\bpiano\b|\bchorale\b|\bchoral\b|\bchœur\b|\bchoeur\b|\bchant\b|\bvocal\b|\bvocale\b|\bfado\b|\bblues\b|\bgospel\b|\bopéra\b|\brécital\b|\bfanfare\b|\bharmonie\b|\bphilharmon|\bsymphon|\blyrique\b|\bquatuor\b|\bmusique\b|\bmusical\b|\bmusicale\b|\bbal \b|musique live|soirée musicale/.test(r)) return 'musique';
  if(/\bcinéma\b|\bciné\b|\bfilm\b|\bprojection\b|\bdocumentaire\b/.test(r)) return 'cinema';
  if(/\bthéâtre\b|\bspectacle\b|\bcomédie\b|\bdanse\b|\bballet\b|\bcirque\b|stand.up|one.man.show|\bimpro\b/.test(r)) return 'theatre';
  if(/\bexposition\b|\bgalerie\b|\bvernissage\b|\bpeinture\b|\bsculpture\b|exposition d|\bmusée\b/.test(r)) return 'expo';
  if(/\benfants?\b|\bjunior\b|\bjeunesse\b|\bconte\b|\bmarionnette\b|jeune public/.test(r)) return 'enfants';
  if(/portes? ouvertes?|visite du domaine|visite de cave|visite guidée/.test(r)) return 'portes-ouvertes';
  // Wine and food tasting only. "cave" alone is too common in addresses.
  if(/\bdégustation\b|degustation|\boenolog|\bvignoble\b|wine tasting|cave à vin|bar à vin|accord mets|domaine viticole|vendanges|millésime/.test(r)) return 'degustation';
  if(/gastronom|culinaire|\bgourmand\b|\bgourmet\b|\bbanquet\b|\bbrunch\b|food truck|table d.hôte|marché gourmand|repas gastronomique|dîner gastronomique|art culinaire|fête de la gastronomie/.test(r)) return 'gastronomie';
  if(/\bbrocante\b|vide.grenier|vide grenier|\bpuces\b|\bbraderie\b/.test(r)) return 'brocante';
  if(/\bmarché\b|marchés du/.test(r)) return 'marche';
  // Clear sporting activity only; job listings carry transport keywords.
  if(/\byoga\b|\bmarathon\b|\btrail\b|\btriathlon\b|\bcyclisme\b|\bnatation\b|\brugby\b|\bbasket\b|\btennis\b|\bfootball\b|\bvolley\b|\bescalade\b|\bkaraté\b|\bjudo\b|tournoi sportif|compétition sportive|\bvélo\b|\bcycliste\b|balade vélo|vélo balade/.test(r)) return 'sport';
  if(/randonnée|\bbalade\b|\bnature\b|\bforêt\b|\bjardin\b|\bbotanique\b|\bfaune\b|\bflore\b|sylvothérapie|sylvo.?thérapie|bain de forêt|forest.?bathing/.test(r)) return 'nature';
  if(/\bfestival\b|\bfête\b|fête de|foire de|\bcarnaval\b|\bkermesse\b/.test(r)) return 'fete';
  if(/\batelier\b|\bworkshop\b|\binitiation\b/.test(r)) return 'ateliers';
  if(/\bvisite\b|\bpatrimoine\b|\barchéol|\bcathédrale\b|\babbaye\b|\bchâteau\b|\bprieuré\b|\bmédiéval\b/.test(r)) return 'patrimoine';
  if(/\bconférence\b|\bdébat\b|\bcauserie\b|\bcolloque\b/.test(r)) return 'patrimoine';
  return 'patrimoine';
}
