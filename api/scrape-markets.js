// SoirFR — jours-de-marche.fr scraper
// Scrapes all markets in Burgundy departments (71, 21, 58, 89)
// Generates recurring weekly events for the next 8 weeks

const SB_URL = 'https://ebinsidruxvbzukobshf.supabase.co';
const SB_KEY = 'sb_publishable_QSnlPXEopb6x8m8N3K396Q_YPazJ0IM';
const BASE = 'https://www.jours-de-marche.fr';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

const DEPTS = [
  { slug: '71-saone-et-loire', dept: '71', region: 'Bourgogne-Franche-Comté' },
  { slug: '21-cote-dor',       dept: '21', region: 'Bourgogne-Franche-Comté' },
  { slug: '58-nievre',         dept: '58', region: 'Bourgogne-Franche-Comté' },
  { slug: '89-yonne',          dept: '89', region: 'Bourgogne-Franche-Comté' },
];

const DAY_MAP = {
  'lundi':1,'mardi':2,'mercredi':3,'jeudi':4,
  'vendredi':5,'samedi':6,'dimanche':0
};

module.exports = async function handler(req, res) {
  const CRON_SECRET = process.env.CRON_SECRET;
  if (CRON_SECRET && req.headers['authorization'] !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const results = [], errors = [];

  // Get existing market source_event_ids to avoid dupes
  const existingRes = await fetch(
    `${SB_URL}/rest/v1/events?source_name=eq.jours_de_marche&select=source_event_id&limit=2000`,
    { headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` } }
  );
  const existing = await existingRes.json();
  const existingIds = new Set((existing || []).map(e => e.source_event_id));

  for (const dept of DEPTS) {
    try {
      // Fetch department page to get all postcode links
      const deptRes = await fetch(`${BASE}/${dept.slug}/`, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'fr-FR,fr;q=0.9' }
      });
      if (!deptRes.ok) { errors.push({ dept: dept.dept, error: `HTTP ${deptRes.status}` }); continue; }
      const deptHtml = await deptRes.text();

      // Debug: find all href patterns
      const allHrefs = [...deptHtml.matchAll(/href="([^"]{5,50})"/g)].map(m=>m[1]).filter(h=>h.includes('marche')||h.match(/\/\d{4,5}/)).slice(0,10);
      errors.push({ dept: dept.dept, sampleHrefs: allHrefs, htmlLen: deptHtml.length });

      // Extract postcode city links: /71150-chagny/ format
      const postcodeLinks = [...new Set(
        [...deptHtml.matchAll(/href="(\/\d{5}-[^/]+\/)"/g)].map(m => m[1])
      )];

      let deptFound = 0, deptAdded = 0;

      for (const link of postcodeLinks.slice(0, 80)) {
        try {
          await sleep(400);
          const cityRes = await fetch(`${BASE}${link}`, {
            headers: { 'User-Agent': UA }
          });
          if (!cityRes.ok) continue;
          const html = await cityRes.text();

          // Extract postcode and city from URL
          const urlMatch = link.match(/\/(\d{5})-([^/]+)\//);
          if (!urlMatch) continue;
          const postcode = urlMatch[1];
          const citySlug = urlMatch[2];
          const city = citySlug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

          // Extract markets from the page
          // Pattern: "Ce marché a lieu [season] le [day] de [time]"
          const marketBlocks = [...html.matchAll(
            /href="(\/marche\/[^"]+)"[^>]*>\s*\*?\*?([^*\n]+?)\*?\*?\s*Ce march[eé] a lieu ([^<]+)/gi
          )];

          for (const block of marketBlocks) {
            const marketUrl = block[1];
            const marketName = block[2].trim().replace(/\*+/g, '').trim() || `Marché de ${city}`;
            const scheduleText = block[3].trim();

            // Parse days
            const days = [];
            for (const [dayName, dayNum] of Object.entries(DAY_MAP)) {
              if (scheduleText.toLowerCase().includes(dayName)) days.push(dayNum);
            }
            if (!days.length) continue;

            // Parse hours
            const hoursMatch = scheduleText.match(/de (\d+)h(?:(\d+))? à (\d+)h(?:(\d+))?/i);
            const startHour = hoursMatch ? parseInt(hoursMatch[1]) : 8;
            const startMin = hoursMatch ? parseInt(hoursMatch[2] || '0') : 0;
            const endHour = hoursMatch ? parseInt(hoursMatch[3]) : 13;
            const endMin = hoursMatch ? parseInt(hoursMatch[4] || '0') : 0;

            // Parse season
            const yearRound = scheduleText.toLowerCase().includes('toute l');
            const seasonMatch = scheduleText.match(/de ([A-Za-zé]+) à ([A-Za-zé]+)/i);
            
            // Generate events for next 8 weeks
            const now = new Date();
            const events = [];
            
            for (let weekOffset = 0; weekOffset < 8; weekOffset++) {
              for (const dayNum of days) {
                const date = new Date(now);
                const currentDay = date.getDay();
                let daysUntil = (dayNum - currentDay + 7) % 7;
                if (daysUntil === 0 && weekOffset === 0) daysUntil = 7;
                date.setDate(date.getDate() + daysUntil + (weekOffset * 7));

                // Check season
                if (seasonMatch && !yearRound) {
                  const monthNames = ['janvier','février','mars','avril','mai','juin',
                    'juillet','août','septembre','octobre','novembre','décembre'];
                  const startMonth = monthNames.indexOf(seasonMatch[1].toLowerCase());
                  const endMonth = monthNames.indexOf(seasonMatch[2].toLowerCase());
                  const eventMonth = date.getMonth();
                  if (startMonth !== -1 && endMonth !== -1) {
                    const inSeason = startMonth <= endMonth
                      ? eventMonth >= startMonth && eventMonth <= endMonth
                      : eventMonth >= startMonth || eventMonth <= endMonth;
                    if (!inSeason) continue;
                  }
                }

                const dateStr = date.toISOString().split('T')[0];
                const startTime = `${String(startHour).padStart(2,'0')}:${String(startMin).padStart(2,'0')}`;
                const endTime = `${String(endHour).padStart(2,'0')}:${String(endMin).padStart(2,'0')}`;
                const sourceId = `jdm_${postcode}_${days.join('-')}_${dateStr}`;

                if (!existingIds.has(sourceId)) {
                  events.push({
                    title: marketName,
                    category: 'marche',
                    city,
                    postcode,
                    department: dept.dept,
                    region: dept.region,
                    country: 'FR',
                    starts_at: `${dateStr}T${startTime}:00`,
                    ends_at: `${dateStr}T${endTime}:00`,
                    source_name: 'jours_de_marche',
                    source_url: `${BASE}${marketUrl}`,
                    source_event_id: sourceId,
                    status: 'active',
                    scraped_at: new Date().toISOString(),
                    is_free: true,
                  });
                  existingIds.add(sourceId);
                }
                deptFound++;
              }
            }

            if (events.length === 0) continue;

            // Geocode the city
            try {
              const geoRes = await fetch(
                `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(city + ' ' + postcode)}&limit=1&postcode=${postcode}`
              );
              const geoData = await geoRes.json();
              const feat = geoData.features?.[0];
              if (feat) {
                const lng = feat.geometry.coordinates[0];
                const lat = feat.geometry.coordinates[1];
                events.forEach(e => { e.location = `POINT(${lng} ${lat})`; });
              }
            } catch {}

            // Batch insert
            for (let i = 0; i < events.length; i += 50) {
              const batch = events.slice(i, i + 50);
              const ins = await fetch(`${SB_URL}/rest/v1/events`, {
                method: 'POST',
                headers: {
                  'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`,
                  'Content-Type': 'application/json', 'Prefer': 'return=minimal'
                },
                body: JSON.stringify(batch)
              });
              if (ins.ok) deptAdded += batch.length;
            }
          }
        } catch(e) { errors.push({ dept: dept.dept, link, error: e.message }); }
      }

      results.push({ dept: dept.dept, found: deptFound, added: deptAdded });
      await sleep(1000);
    } catch(e) { errors.push({ dept: dept.dept, error: e.message }); }
  }

  const total_added = results.reduce((s,r) => s+(r.added||0), 0);
  const total_found = results.reduce((s,r) => s+(r.found||0), 0);
  return res.status(200).json({ success: true, total_added, total_found, results, errors });
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
