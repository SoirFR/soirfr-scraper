// SoirFR — Automated Scraper Pipeline
// Uses CommonJS (require) for maximum Vercel compatibility

const SUPABASE_URL = 'https://ebinsidruxvbzukobshf.supabase.co';
const SUPABASE_KEY = 'sb_publishable_QSnlPXEopb6x8m8N3K396Q_YPazJ0IM';

module.exports = async function handler(req, res) {
  const CRON_SECRET = process.env.CRON_SECRET;
  const OPENAGENDA_KEY = process.env.OPENAGENDA_API_KEY;
  const TICKETMASTER_KEY = process.env.TICKETMASTER_API_KEY;

  // Security check
  const auth = req.headers['authorization'];
  if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const results = [];
  const errors = [];

  // --- OPENAGENDA ---
  if (OPENAGENDA_KEY) {
    try {
      const dateFrom = new Date().toISOString().split('T')[0];
      const dateTo = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
      const params = new URLSearchParams({
        key: OPENAGENDA_KEY,
        size: 100,
        'timings[gte]': dateFrom,
        'timings[lte]': dateTo,
        'locationCountry[]': 'FR',
        detailed: 1,
      });

      const response = await fetch(`https://api.openagenda.com/v2/events?${params}`);
      const data = await response.json();
      const events = data.events || [];
      let added = 0;

      for (const ev of events) {
        const timing = ev.timings?.[0];
        if (!timing) continue;

        const result = await insertEvent({
          title: ev.title?.fr || ev.title?.en || 'Événement',
          description: ev.description?.fr?.slice(0, 1000),
          category: mapCategory(ev.keywords?.fr?.[0] || ''),
          address: ev.location?.address,
          city: ev.location?.city,
          postcode: ev.location?.postalCode,
          department: ev.location?.department,
          region: ev.location?.region,
          lat: ev.location?.latitude,
          lng: ev.location?.longitude,
          starts_at: timing.begin,
          ends_at: timing.end,
          image_url: ev.image ? (ev.image.base + ev.image.filename) : null,
          is_free: ev.conditions?.fr?.toLowerCase().includes('gratuit') || false,
          booking_url: ev.registration?.[0]?.value || null,
          source_url: `https://openagenda.com/events/${ev.slug}`,
          source_event_id: String(ev.uid),
          source_name: 'openagenda_api',
        });
        if (result) added++;
      }

      results.push({ source: 'openagenda', found: events.length, added });
    } catch (e) {
      errors.push({ source: 'openagenda', error: e.message });
    }
  }

  // --- TICKETMASTER ---
  if (TICKETMASTER_KEY) {
    try {
      const startDate = new Date().toISOString().replace('.000', '');
      const endDate = new Date(Date.now() + 30 * 86400000).toISOString().replace('.000', '');
      const params = new URLSearchParams({
        apikey: TICKETMASTER_KEY,
        countryCode: 'FR',
        startDateTime: startDate,
        endDateTime: endDate,
        size: 100,
        sort: 'date,asc',
      });

      const response = await fetch(`https://app.ticketmaster.com/discovery/v2/events.json?${params}`);
      const data = await response.json();
      const events = data?._embedded?.events || [];
      let added = 0;

      for (const ev of events) {
        const venue = ev._embedded?.venues?.[0];
        const price = ev.priceRanges?.[0];
        const date = ev.dates?.start;

        const result = await insertEvent({
          title: ev.name,
          description: ev.info || null,
          category: mapCategory(ev.classifications?.[0]?.segment?.name || ''),
          address: venue?.address?.line1,
          city: venue?.city?.name,
          postcode: venue?.postalCode,
          lat: parseFloat(venue?.location?.latitude) || null,
          lng: parseFloat(venue?.location?.longitude) || null,
          starts_at: date?.dateTime || date?.localDate,
          image_url: ev.images?.find(i => i.ratio === '16_9' && i.width > 500)?.url || null,
          price_min: price?.min || null,
          price_max: price?.max || null,
          is_free: price?.min === 0,
          booking_url: ev.url,
          source_url: ev.url,
          source_event_id: ev.id,
          source_name: 'ticketmaster_france',
        });
        if (result) added++;
      }

      results.push({ source: 'ticketmaster', found: events.length, added });
    } catch (e) {
      errors.push({ source: 'ticketmaster', error: e.message });
    }
  }

  // --- PARIS OPEN DATA (no key needed) ---
  try {
    const dateFrom = new Date().toISOString().split('T')[0];
    const params = new URLSearchParams({
      limit: 100,
      where: `date_start >= '${dateFrom}'`,
      order_by: 'date_start ASC',
    });

    const response = await fetch(`https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/que-faire-a-paris-/records?${params}`);
    const data = await response.json();
    const events = data.results || [];
    let added = 0;

    for (const ev of events) {
      const result = await insertEvent({
        title: ev.title,
        description: ev.lead_text?.slice(0, 1000) || null,
        category: mapCategory(ev.category || ''),
        address: ev.address_name || null,
        city: 'Paris',
        postcode: ev.address_zipcode,
        department: '75',
        region: 'Île-de-France',
        lat: ev.lat_lon?.lat || null,
        lng: ev.lat_lon?.lon || null,
        starts_at: ev.date_start,
        ends_at: ev.date_end,
        image_url: ev.cover_url || null,
        is_free: ev.price_type === 'free',
        booking_url: ev.url || null,
        source_url: ev.url || null,
        source_event_id: String(ev.id),
        source_name: 'ot_paris',
      });
      if (result) added++;
    }

    results.push({ source: 'paris_opendata', found: events.length, added });
  } catch (e) {
    errors.push({ source: 'paris_opendata', error: e.message });
  }

  const total_added = results.reduce((sum, r) => sum + (r.added || 0), 0);

  // Log this run to Supabase
  await supabaseFetch('scrape_logs', 'POST', {
    source_name: 'all',
    finished_at: new Date().toISOString(),
    events_found: results.reduce((sum, r) => sum + (r.found || 0), 0),
    events_added: total_added,
    status: errors.length === 0 ? 'success' : 'partial',
    error_message: errors.length ? JSON.stringify(errors) : null,
  });

  return res.status(200).json({ success: true, total_added, results, errors });
};

// ── HELPERS ──────────────────────────────────────────────

async function insertEvent(event) {
  // Check for duplicate first
  if (event.source_event_id) {
    const existing = await supabaseFetch(
      `events?source_name=eq.${event.source_name}&source_event_id=eq.${encodeURIComponent(event.source_event_id)}&select=id`,
      'GET'
    );
    if (existing?.length > 0) return false;
  }

  // Build PostGIS location point
  const locationPoint = (event.lat && event.lng && !isNaN(event.lat) && !isNaN(event.lng))
    ? `POINT(${event.lng} ${event.lat})`
    : null;

  const payload = {
    title: event.title,
    description: event.description || null,
    category: event.category || 'autre',
    address: event.address || null,
    city: event.city || null,
    postcode: event.postcode || null,
    department: event.department || null,
    region: event.region || null,
    location: locationPoint,
    starts_at: event.starts_at,
    ends_at: event.ends_at || null,
    image_url: event.image_url || null,
    price_min: event.price_min || null,
    price_max: event.price_max || null,
    is_free: event.is_free || false,
    booking_url: event.booking_url || null,
    source_type: 'api',
    source_name: event.source_name,
    source_url: event.source_url || null,
    source_event_id: event.source_event_id || null,
    status: 'active',
    scraped_at: new Date().toISOString(),
  };

  const result = await supabaseFetch('events', 'POST', payload);
  return result !== null;
}

async function supabaseFetch(path, method = 'GET', body = null) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': method === 'POST' ? 'return=minimal' : '',
  };

  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);

  try {
    const res = await fetch(url, options);
    if (method === 'GET') return await res.json();
    return res.ok;
  } catch (e) {
    console.error('Supabase error:', e.message);
    return null;
  }
}

function mapCategory(raw) {
  if (!raw) return 'autre';
  const r = raw.toLowerCase();
  if (r.includes('music') || r.includes('concert') || r.includes('musique')) return 'musique';
  if (r.includes('cin') || r.includes('film')) return 'cinema';
  if (r.includes('th') && r.includes('tre')) return 'theatre';
  if (r.includes('expo') || r.includes('art') || r.includes('galerie')) return 'expo';
  if (r.includes('enfant') || r.includes('kid') || r.includes('jeun')) return 'enfants';
  if (r.includes('port') && r.includes('ouvert')) return 'portes-ouvertes';
  if (r.includes('gust') || r.includes('vin') || r.includes('wine')) return 'degustation';
  if (r.includes('brocant') || r.includes('puce') || r.includes('vide grenier')) return 'brocante';
  if (r.includes('march') || r.includes('market')) return 'marche';
  if (r.includes('sport') || r.includes('foot') || r.includes('basket')) return 'sport';
  if (r.includes('nature') || r.includes('rando')) return 'nature';
  if (r.includes('festival') || r.includes('f\u00eate')) return 'fete';
  if (r.includes('conf') || r.includes('talk')) return 'conference';
  return 'autre';
}
