// ============================================================
// SoirFR — Automated Scraper Pipeline
// Vercel Serverless Function: /api/scrape
// Runs daily via cron. Pulls from APIs + scrapes HTML sources.
// ============================================================

import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';

const SUPABASE_URL = 'https://ebinsidruxvbzukobshf.supabase.co';
const SUPABASE_KEY = 'sb_publishable_QSnlPXEopb6x8m8N3K396Q_YPazJ0IM';
const OPENAGENDA_KEY = process.env.OPENAGENDA_API_KEY;
const TICKETMASTER_KEY = process.env.TICKETMASTER_API_KEY;
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ============================================================
// MAIN HANDLER
// ============================================================
export default async function handler(req, res) {
  // Security: only allow cron or manual trigger with secret
  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const results = [];
  const errors = [];

  const scrapers = [
    scrapeOpenAgenda,
    scrapeTicketmaster,
    scrapeParisOpenData,
    scrapeBourgogneTourisme,
    scrapeOTBeaune,
    scrapeSortirAParis,
  ];

  for (const scraper of scrapers) {
    try {
      const result = await scraper();
      results.push(result);
    } catch (err) {
      errors.push({ scraper: scraper.name, error: err.message });
      console.error(`Scraper failed: ${scraper.name}`, err);
    }
  }

  const total = results.reduce((sum, r) => sum + (r.added || 0), 0);
  return res.status(200).json({ success: true, total_added: total, results, errors });
}

// ============================================================
// UTILITY: geocode an address to lat/lng via Google Maps
// ============================================================
async function geocode(address) {
  if (!address || !GOOGLE_MAPS_KEY) return null;
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address + ', France')}&key=${GOOGLE_MAPS_KEY}`;
    const r = await fetch(url);
    const d = await r.json();
    if (d.results?.[0]) {
      const { lat, lng } = d.results[0].geometry.location;
      return { lat, lng };
    }
  } catch {}
  return null;
}

// ============================================================
// UTILITY: upsert events (insert new, skip duplicates)
// ============================================================
async function upsertEvents(events, sourceName) {
  if (!events.length) return { added: 0, skipped: 0 };

  let added = 0;
  let skipped = 0;

  for (const event of events) {
    // Check for duplicate by source + source_event_id
    if (event.source_event_id) {
      const { data: existing } = await supabase
        .from('events')
        .select('id')
        .eq('source_name', sourceName)
        .eq('source_event_id', event.source_event_id)
        .single();

      if (existing) { skipped++; continue; }
    }

    // Geocode if we have an address but no coordinates
    if (event.address && !event.lat) {
      const coords = await geocode(event.address + (event.city ? ', ' + event.city : ''));
      if (coords) { event.lat = coords.lat; event.lng = coords.lng; }
    }

    // Build location point for PostGIS
    const locationPoint = (event.lat && event.lng)
      ? `POINT(${event.lng} ${event.lat})`
      : null;

    const { error } = await supabase.from('events').insert({
      title:           event.title,
      description:     event.description,
      category:        event.category || 'autre',
      address:         event.address,
      city:            event.city,
      department:      event.department,
      region:          event.region,
      postcode:        event.postcode,
      location:        locationPoint,
      starts_at:       event.starts_at,
      ends_at:         event.ends_at,
      image_url:       event.image_url,
      price_min:       event.price_min,
      price_max:       event.price_max,
      is_free:         event.is_free ?? (event.price_min === 0),
      booking_url:     event.booking_url,
      source_type:     event.source_type || 'api',
      source_name:     sourceName,
      source_url:      event.source_url,
      source_event_id: event.source_event_id,
      status:          'active',
      scraped_at:      new Date().toISOString(),
    });

    if (error) { console.error('Insert error:', error); skipped++; }
    else added++;
  }

  // Log this scrape run
  await supabase.from('scrape_logs').insert({
    source_name:    sourceName,
    finished_at:    new Date().toISOString(),
    events_found:   events.length,
    events_added:   added,
    events_skipped: skipped,
    status:         'success',
  });

  // Update last_scraped_at on the source
  await supabase.from('scraper_sources')
    .update({ last_scraped_at: new Date().toISOString(), last_success_at: new Date().toISOString(), error_count: 0 })
    .eq('name', sourceName);

  return { added, skipped };
}

// ============================================================
// MAP OpenAgenda category slugs → SoirFR categories
// ============================================================
function mapCategory(raw) {
  if (!raw) return 'autre';
  const r = raw.toLowerCase();
  if (r.includes('music') || r.includes('concert') || r.includes('musique')) return 'musique';
  if (r.includes('cin') || r.includes('film') || r.includes('movie')) return 'cinema';
  if (r.includes('th') && r.includes('tre')) return 'theatre';
  if (r.includes('expo') || r.includes('art') || r.includes('galerie')) return 'expo';
  if (r.includes('enfant') || r.includes('kid') || r.includes('jeun')) return 'enfants';
  if (r.includes('port') && r.includes('ouvert')) return 'portes-ouvertes';
  if (r.includes('d') && (r.includes('gust') || r.includes('vin') || r.includes('wine'))) return 'degustation';
  if (r.includes('brocant') || r.includes('puce') || r.includes('vide grenier')) return 'brocante';
  if (r.includes('march') || r.includes('market')) return 'marche';
  if (r.includes('sport') || r.includes('foot') || r.includes('basket') || r.includes('tennis')) return 'sport';
  if (r.includes('nature') || r.includes('rando') || r.includes('balade')) return 'nature';
  if (r.includes('f') && r.includes('te') || r.includes('festival')) return 'fete';
  if (r.includes('conf') || r.includes('talk') || r.includes('débat')) return 'conference';
  return 'autre';
}

// ============================================================
// SCRAPER 1: OpenAgenda API
// Best source for French local events — mairies, associations, culture
// ============================================================
async function scrapeOpenAgenda() {
  if (!OPENAGENDA_KEY) return { source: 'openagenda', added: 0, error: 'No API key' };

  const events = [];
  const regions = [
    'Bourgogne-Franche-Comté',
    'Île-de-France',
    'Provence-Alpes-Côte d\'Azur',
    'Auvergne-Rhône-Alpes',
    'Occitanie',
  ];

  // Fetch next 30 days of events across key regions
  const dateFrom = new Date().toISOString().split('T')[0];
  const dateTo = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];

  let after = null;
  let page = 0;
  const maxPages = 10; // 100 events per page = 1000 events max per run

  while (page < maxPages) {
    const params = new URLSearchParams({
      key:   OPENAGENDA_KEY,
      size:  100,
      'timings[gte]': dateFrom,
      'timings[lte]': dateTo,
      'locationCountry[]': 'FR',
      detailed: 1,
    });
    if (after) params.set('after', after);

    const res = await fetch(`https://api.openagenda.com/v2/events?${params}`);
    if (!res.ok) break;
    const data = await res.json();

    for (const ev of (data.events || [])) {
      const timing = ev.timings?.[0];
      if (!timing) continue;

      events.push({
        title:           ev.title?.fr || ev.title?.en || 'Événement',
        description:     ev.description?.fr?.slice(0, 1000),
        category:        mapCategory(ev.keywords?.fr?.[0] || ev.type?.[0]?.label?.fr),
        address:         ev.location?.address,
        city:            ev.location?.city,
        postcode:        ev.location?.postalCode,
        department:      ev.location?.department,
        region:          ev.location?.region,
        lat:             ev.location?.latitude,
        lng:             ev.location?.longitude,
        starts_at:       timing.begin,
        ends_at:         timing.end,
        image_url:       ev.image?.base + ev.image?.filename,
        price_min:       ev.conditions?.fr?.includes('gratuit') ? 0 : null,
        is_free:         ev.conditions?.fr?.toLowerCase().includes('gratuit'),
        booking_url:     ev.registration?.[0]?.value || ev.links?.[0]?.link,
        source_url:      `https://openagenda.com/events/${ev.slug}`,
        source_event_id: String(ev.uid),
        source_type:     'api',
      });
    }

    after = data.after;
    if (!after || !data.events?.length) break;
    page++;
  }

  return { source: 'openagenda', ...(await upsertEvents(events, 'openagenda_api')) };
}

// ============================================================
// SCRAPER 2: Ticketmaster France
// Concerts, shows, major events
// ============================================================
async function scrapeTicketmaster() {
  if (!TICKETMASTER_KEY) return { source: 'ticketmaster', added: 0, error: 'No API key' };

  const events = [];
  const startDate = new Date().toISOString().replace('.000', '');
  const endDate = new Date(Date.now() + 30 * 86400000).toISOString().replace('.000', '');

  const params = new URLSearchParams({
    apikey:      TICKETMASTER_KEY,
    countryCode: 'FR',
    startDateTime: startDate,
    endDateTime:   endDate,
    size:        200,
    sort:        'date,asc',
  });

  const res = await fetch(`https://app.ticketmaster.com/discovery/v2/events.json?${params}`);
  if (!res.ok) return { source: 'ticketmaster', added: 0, error: res.statusText };
  const data = await res.json();

  for (const ev of (data?._embedded?.events || [])) {
    const venue = ev._embedded?.venues?.[0];
    const price = ev.priceRanges?.[0];
    const date = ev.dates?.start;

    events.push({
      title:           ev.name,
      description:     ev.info || ev.pleaseNote,
      category:        mapCategory(ev.classifications?.[0]?.segment?.name),
      address:         venue?.address?.line1,
      city:            venue?.city?.name,
      postcode:        venue?.postalCode,
      country:         'FR',
      lat:             parseFloat(venue?.location?.latitude),
      lng:             parseFloat(venue?.location?.longitude),
      starts_at:       date?.dateTime || date?.localDate,
      image_url:       ev.images?.find(i => i.ratio === '16_9' && i.width > 500)?.url,
      price_min:       price?.min,
      price_max:       price?.max,
      is_free:         price?.min === 0,
      booking_url:     ev.url,
      source_url:      ev.url,
      source_event_id: ev.id,
      source_type:     'api',
    });
  }

  return { source: 'ticketmaster', ...(await upsertEvents(events, 'ticketmaster_france')) };
}

// ============================================================
// SCRAPER 3: Paris Open Data
// All Paris city events — free, comprehensive, official
// ============================================================
async function scrapeParisOpenData() {
  const events = [];
  const dateFrom = new Date().toISOString().split('T')[0];

  const params = new URLSearchParams({
    limit: 100,
    offset: 0,
    where: `date_start >= '${dateFrom}'`,
    order_by: 'date_start ASC',
  });

  const res = await fetch(`https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/que-faire-a-paris-/records?${params}`);
  if (!res.ok) return { source: 'paris_opendata', added: 0, error: res.statusText };
  const data = await res.json();

  for (const ev of (data.results || [])) {
    events.push({
      title:           ev.title,
      description:     ev.lead_text || ev.description?.slice(0, 1000),
      category:        mapCategory(ev.category),
      address:         ev.address_name + (ev.address_street ? ', ' + ev.address_street : ''),
      city:            'Paris',
      postcode:        ev.address_zipcode,
      department:      '75',
      region:          'Île-de-France',
      lat:             ev.lat_lon?.lat,
      lng:             ev.lat_lon?.lon,
      starts_at:       ev.date_start,
      ends_at:         ev.date_end,
      image_url:       ev.cover_url,
      price_min:       ev.price_type === 'free' ? 0 : null,
      is_free:         ev.price_type === 'free',
      booking_url:     ev.url,
      source_url:      ev.url,
      source_event_id: String(ev.id),
      source_type:     'api',
    });
  }

  return { source: 'paris_opendata', ...(await upsertEvents(events, 'ot_paris')) };
}

// ============================================================
// SCRAPER 4: Bourgogne Tourisme (HTML scraper)
// Regional tourism agenda — key for rural Burgundy coverage
// ============================================================
async function scrapeBourgogneTourisme() {
  const events = [];
  const baseUrl = 'https://www.bourgogne-tourisme.com/agenda/';

  try {
    const res = await fetch(baseUrl, {
      headers: { 'User-Agent': 'SoirFR/1.0 (agenda aggregator; contact@soirfr.com)' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);

    // Bourgogne Tourisme agenda card structure
    $('.agenda-item, .event-card, article.event').each((_, el) => {
      const $el = $(el);
      const title = $el.find('h2, h3, .title, .event-title').first().text().trim();
      const dateText = $el.find('.date, time, .event-date').first().text().trim();
      const city = $el.find('.city, .location, .lieu').first().text().trim();
      const link = $el.find('a').first().attr('href');
      const img = $el.find('img').first().attr('src') || $el.find('img').first().attr('data-src');
      const category = $el.find('.category, .type').first().text().trim();

      if (!title) return;

      // Parse French date formats (e.g. "samedi 24 mai 2025", "du 24 au 26 mai")
      const parsedDate = parseFrenchDate(dateText);

      events.push({
        title,
        category:        mapCategory(category),
        city:            city || 'Bourgogne',
        region:          'Bourgogne-Franche-Comté',
        starts_at:       parsedDate || new Date().toISOString(),
        image_url:       img?.startsWith('http') ? img : img ? 'https://www.bourgogne-tourisme.com' + img : null,
        source_url:      link?.startsWith('http') ? link : link ? 'https://www.bourgogne-tourisme.com' + link : baseUrl,
        source_event_id: link || title,
        source_type:     'html_scraper',
      });
    });
  } catch (err) {
    await logScraperError('ot_bourgogne', err.message);
    return { source: 'bourgogne_tourisme', added: 0, error: err.message };
  }

  return { source: 'bourgogne_tourisme', ...(await upsertEvents(events, 'ot_bourgogne')) };
}

// ============================================================
// SCRAPER 5: OT Beaune (HTML scraper)
// Beaune + Côte d'Or hyper-local events
// ============================================================
async function scrapeOTBeaune() {
  const events = [];
  const baseUrl = 'https://www.beaune-tourisme.fr/agenda';

  try {
    const res = await fetch(baseUrl, {
      headers: { 'User-Agent': 'SoirFR/1.0 (agenda aggregator; contact@soirfr.com)' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);

    $('article, .agenda-event, .event-item').each((_, el) => {
      const $el = $(el);
      const title = $el.find('h2, h3, .title').first().text().trim();
      const dateText = $el.find('time, .date').first().text().trim();
      const link = $el.find('a').first().attr('href');
      const img = $el.find('img').first().attr('src');

      if (!title) return;

      events.push({
        title,
        category:        'autre',
        city:            'Beaune',
        department:      '21',
        region:          'Bourgogne-Franche-Comté',
        starts_at:       parseFrenchDate(dateText) || new Date().toISOString(),
        image_url:       img?.startsWith('http') ? img : img ? 'https://www.beaune-tourisme.fr' + img : null,
        source_url:      link?.startsWith('http') ? link : link ? 'https://www.beaune-tourisme.fr' + link : baseUrl,
        source_event_id: link || title,
        source_type:     'html_scraper',
      });
    });
  } catch (err) {
    await logScraperError('ot_beaune', err.message);
    return { source: 'beaune', added: 0, error: err.message };
  }

  return { source: 'beaune', ...(await upsertEvents(events, 'ot_beaune')) };
}

// ============================================================
// SCRAPER 6: SortirAParis (HTML scraper)
// Paris's largest events guide — concerts, expos, kids, theatre
// ============================================================
async function scrapeSortirAParis() {
  const events = [];
  const baseUrl = 'https://www.sortiraparis.com/agenda';

  try {
    const res = await fetch(baseUrl, {
      headers: { 'User-Agent': 'SoirFR/1.0 (agenda aggregator; contact@soirfr.com)' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);

    $('.evenement, .event-listing article, .agenda-item').each((_, el) => {
      const $el = $(el);
      const title = $el.find('h2, h3, .titre').first().text().trim();
      const dateText = $el.find('.date, time').first().text().trim();
      const link = $el.find('a').first().attr('href');
      const img = $el.find('img').first().attr('src') || $el.find('img').first().attr('data-lazy-src');
      const category = $el.find('.cat, .categorie').first().text().trim();

      if (!title) return;

      events.push({
        title,
        category:        mapCategory(category),
        city:            'Paris',
        department:      '75',
        region:          'Île-de-France',
        starts_at:       parseFrenchDate(dateText) || new Date().toISOString(),
        image_url:       img?.startsWith('http') ? img : null,
        source_url:      link?.startsWith('http') ? link : link ? 'https://www.sortiraparis.com' + link : baseUrl,
        source_event_id: link || title,
        source_type:     'html_scraper',
      });
    });
  } catch (err) {
    await logScraperError('sortiraparis', err.message);
    return { source: 'sortiraparis', added: 0, error: err.message };
  }

  return { source: 'sortiraparis', ...(await upsertEvents(events, 'sortiraparis')) };
}

// ============================================================
// UTILITY: parse common French date formats
// ============================================================
function parseFrenchDate(text) {
  if (!text) return null;
  const months = {
    janvier: '01', février: '02', mars: '03', avril: '04',
    mai: '05', juin: '06', juillet: '07', août: '08',
    septembre: '09', octobre: '10', novembre: '11', décembre: '12'
  };

  // "24 mai 2025" or "samedi 24 mai 2025"
  const match = text.match(/(\d{1,2})\s+(janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)\s+(\d{4})/i);
  if (match) {
    const [, day, monthName, year] = match;
    const month = months[monthName.toLowerCase()];
    return `${year}-${month}-${day.padStart(2, '0')}T00:00:00+02:00`;
  }

  // Try ISO or standard formats as fallback
  const d = new Date(text);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// ============================================================
// UTILITY: log scraper errors back to Supabase
// ============================================================
async function logScraperError(sourceName, errorMsg) {
  await supabase.from('scrape_logs').insert({
    source_name:   sourceName,
    finished_at:   new Date().toISOString(),
    events_found:  0,
    events_added:  0,
    status:        'failed',
    error_message: errorMsg,
  });
  await supabase.from('scraper_sources')
    .update({ last_error: errorMsg, error_count: supabase.rpc('increment', { row_name: sourceName }) })
    .eq('name', sourceName);
}
