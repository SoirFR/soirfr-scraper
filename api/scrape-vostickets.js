// SoirFR — VosTickets scraper
// Scrapes cultural season ticketing pages for Burgundy towns

const SB_URL = 'https://ebinsidruxvbzukobshf.supabase.co';
const SB_KEY = 'sb_publishable_QSnlPXEopb6x8m8N3K396Q_YPazJ0IM';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

// Known VosTickets slugs for Burgundy towns/venues
// Format: { slug, city, dept, lat, lng }
const CATALOGUES = [
  { slug: 'CHAGNY',        city: 'Chagny',              dept: '71', lat: 46.9147, lng: 4.7558 },
  { slug: 'CONSERVATOIRE', city: 'Chalon-sur-Saône',    dept: '71', lat: 46.7803, lng: 4.8534 },
  { slug: 'AUTUN',         city: 'Autun',               dept: '71', lat: 46.9527, lng: 4.2994 },
  { slug: 'MACON',         city: 'Mâcon',               dept: '71', lat: 46.3057, lng: 4.8317 },
  { slug: 'BEAUNE',        city: 'Beaune',              dept: '21', lat: 47.0261, lng: 4.8357 },
  { slug: 'DIJON',         city: 'Dijon',               dept: '21', lat: 47.3167, lng: 5.0414 },
  { slug: 'CLUNY',         city: 'Cluny',               dept: '71', lat: 46.4346, lng: 4.6574 },
  { slug: 'SAISON_CULTURELLE', city: 'Bourgogne',       dept: '71', lat: 46.6614, lng: 4.6337 },
];

module.exports = async function handler(req, res) {
  const CRON_SECRET = process.env.CRON_SECRET;
  if (CRON_SECRET && req.headers['authorization'] !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Get existing IDs
  const existingRes = await fetch(
    `${SB_URL}/rest/v1/events?source_name=eq.vostickets&select=source_event_id&limit=2000`,
    { headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` } }
  );
  const existing = await existingRes.json();
  const existingIds = new Set((existing || []).map(e => e.source_event_id));

  const results = [], errors = [];
  const today = new Date().toISOString().split('T')[0];

  for (const cat of CATALOGUES) {
    try {
      const url = `https://www.vostickets.net/billet/FR/catalogue-${cat.slug}.wb`;
      const res2 = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html' }
      });
      if (!res2.ok) { results.push({ slug: cat.slug, found: 0, added: 0, status: res2.status }); continue; }
      const html = await res2.text();

      // Extract events from VosTickets page
      // Pattern: "TITLE Le WEEKDAY DD MOIS YYYY à HHhMM"
      const eventMatches = [...html.matchAll(
        /affiche[^>]*>.*?RESERVER[^>]*>.*?([^<\n]{5,80}?)\s+Le\s+(LUNDI|MARDI|MERCREDI|JEUDI|VENDREDI|SAMEDI|DIMANCHE)\s+(\d{1,2})\s+(\w+)\s+(\d{4})\s+à\s+(\d{1,2})h(\d{0,2})/gis
      )];

      // Also try simpler date extraction
      const dateMatches = [...html.matchAll(
        /([A-ZÀÂÉÈÊËÙÛ][^<\n]{3,60}?)\s*\n\s*(?:Le\s+)?(?:VENDREDI|SAMEDI|DIMANCHE|LUNDI|MARDI|MERCREDI|JEUDI)\s+(\d{1,2})\s+(\w+)\s+(\d{4})\s+à\s+(\d{1,2})h(\d{0,2})/gis
      )];

      // Simpler: just find title + date blocks
      const blocks = [...html.matchAll(
        /class="[^"]*titre[^"]*"[^>]*>\s*([^<]{5,100})<[^>]+>\s*(?:Le\s+)?(?:\w+\s+)?(\d{1,2})\s+(\w+)\s+(\d{4})\s+à\s+(\d{1,2})h(\d{0,2})/gis
      )];

      // Extract all text with dates - more flexible approach
      // Remove HTML tags and find date patterns
      const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      const segments = text.match(/[A-Z][^.!?]{5,80}\s+Le\s+\w+\s+\d{1,2}\s+\w+\s+\d{4}\s+à\s+\d{1,2}h\d{0,2}/gi) || [];

      const MONTHS = {
        'janvier':0,'février':1,'mars':2,'avril':3,'mai':4,'juin':5,
        'juillet':6,'août':7,'septembre':8,'octobre':9,'novembre':10,'décembre':11,
        'aout':7,'fevrier':1
      };

      let found = 0, added = 0;

      for (const seg of segments) {
        const m = seg.match(/^(.+?)\s+Le\s+\w+\s+(\d{1,2})\s+(\w+)\s+(\d{4})\s+à\s+(\d{1,2})h(\d{0,2})/i);
        if (!m) continue;

        const title = m[1].trim().replace(/^[^a-zàâéèA-Z]+/, '').trim();
        const day = parseInt(m[2]);
        const monthName = m[3].toLowerCase();
        const year = parseInt(m[4]);
        const hour = parseInt(m[5]);
        const min = parseInt(m[6] || '0');
        const monthNum = MONTHS[monthName];
        if (monthNum === undefined || !title || title.length < 3) continue;

        const dateStr = `${year}-${String(monthNum+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
        if (dateStr < today) continue;

        found++;
        const sourceId = `vt_${cat.slug}_${dateStr}_${title.slice(0,30).replace(/\s/g,'_')}`;
        if (existingIds.has(sourceId)) continue;

        const event = {
          title: title.slice(0, 300),
          category: mapCat(title),
          city: cat.city,
          department: cat.dept,
          region: 'Bourgogne-Franche-Comté',
          country: 'FR',
          location: `POINT(${cat.lng} ${cat.lat})`,
          starts_at: `${dateStr}T${String(hour).padStart(2,'0')}:${String(min).padStart(2,'0')}:00`,
          source_name: 'vostickets',
          source_url: url,
          source_event_id: sourceId,
          status: 'active',
          scraped_at: new Date().toISOString(),
        };

        const ins = await fetch(`${SB_URL}/rest/v1/events`, {
          method: 'POST',
          headers: {
            'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`,
            'Content-Type': 'application/json', 'Prefer': 'return=minimal'
          },
          body: JSON.stringify([event])
        });
        if (ins.ok) { added++; existingIds.add(sourceId); }
      }

      results.push({ slug: cat.slug, city: cat.city, found, added });
      await sleep(500);
    } catch(e) { errors.push({ slug: cat.slug, error: e.message }); }
  }

  const total_added = results.reduce((s,r) => s+(r.added||0), 0);
  const total_found = results.reduce((s,r) => s+(r.found||0), 0);
  return res.status(200).json({ success: true, total_added, total_found, results, errors });
};

function mapCat(title) {
  const t = title.toLowerCase();
  if (/concert|musique|jazz|rock|chanson|piano|orchestre|trio|quartet|récital/.test(t)) return 'musique';
  if (/théâtre|spectacle|comédie|danse|ballet|cirque/.test(t)) return 'theatre';
  if (/ciné|film|projection/.test(t)) return 'cinema';
  if (/expo|exposition|galerie/.test(t)) return 'expo';
  if (/enfant|famille|jeunesse|conte/.test(t)) return 'enfants';
  if (/festival|fête|fete|carnaval/.test(t)) return 'fete';
  return 'patrimoine';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
