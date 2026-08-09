// SoirFR — cross-source merge and deduplication
//
// Several sources describe the same event. eterritoire and DATAtourisme both
// draw on the same offices de tourisme, so their titles are often identical;
// animation2c writes its own wording but records a real start time.
//
// This does NOT pick a winner and bin the rest. It keeps the best record and
// lifts the useful parts off the copies first: every distinct link, and an
// image if the survivor has none. Three thin records become one good one.
//
// Runs after every scraper, as its own job, because a scraper at 05:00 cannot
// know what a scraper at 07:00 is about to add.
//
// DRY RUN BY DEFAULT. Changes nothing unless called with ?apply=1.
// Losers are hidden with status='duplicate', never deleted, so the whole run
// is reversible with a single UPDATE.

const SB_URL = 'https://ebinsidruxvbzukobshf.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Which record survives. eterritoire is last: thinnest data, widest reach.
// It still contributes its links and images to whatever does survive.
const PRIORITY = {
  proprietaire: 100,
  user_submission: 95,
  datatourisme: 90,
  animation2c: 80,
  agenda_culturel_71: 80,
  mairie_givry: 80,
  seat_a_la_table: 80,
  lejsl: 75,
  brocabrac: 70,
  openagenda_api: 65,
  ticketmaster_france: 65,
  recurring: 60,
  eterritoire: 10,
};
const DEFAULT_PRIORITY = 50;

const STOPWORDS = new Set([
  'de', 'du', 'des', 'la', 'le', 'les', 'l', 'un', 'une', 'et', 'a', 'au',
  'aux', 'en', 'sur', 'sous', 'dans', 'par', 'pour', 'avec', 'chez', 'd',
  'the', 'of', 'at', 'to', 'rdv',
]);

const TITLE_THRESHOLD = 0.6;   // share of the shorter title's words that must match
const TIME_TOLERANCE_MIN = 30; // minutes
const TIME_TITLE_FLOOR = 0.25; // titles must at least partly rhyme for the time rule
const MAX_LINKS = 3;

// ── link classification ───────────────────────────────────────────────────
// Rank 1 first. A URL cannot tell you whether a page is useful, so this only
// claims what a domain reliably means: ticketing domains sell tickets, social
// domains are social. Everything else is offered as "more information"
// without promising what kind.
const TICKETING = /(billetweb|helloasso|weezevent|yurplan|eventbrite|placeminute|ticketmaster|fnacspectacles|digitick|billetterie|reservation\.|\/reservations?)/i;
const SOCIAL = /(facebook\.com|instagram\.com|twitter\.com|x\.com|tiktok\.com)/i;
const TOURISM = /(tourisme|tourism|otsi|office-de-tourisme|mairie|ville-|musee|chateau)/i;
// Aggregator index pages: real, but they land you on a list, not an event.
const LISTING = /(eterritoire\.fr|openagenda\.com|brocabrac\.fr|listing-des-manifestations|infolocale)/i;

function classifyLink(url) {
  if (!url) return null;
  const u = String(url).trim();
  if (!/^https?:\/\//i.test(u)) return null;

  if (TICKETING.test(u)) return { url: u, label: 'Réserver', rank: 1 };
  if (SOCIAL.test(u)) {
    const label = /instagram/i.test(u) ? 'Instagram'
      : /tiktok/i.test(u) ? 'TikTok'
      : /(twitter|x\.com)/i.test(u) ? 'X'
      : 'Facebook';
    return { url: u, label, rank: 4 };
  }
  if (LISTING.test(u)) return { url: u, label: 'Détails', rank: 3 };
  if (TOURISM.test(u)) return { url: u, label: 'Office de tourisme', rank: 2 };
  return { url: u, label: 'Plus d’infos', rank: 2 };
}

// The same page reached two ways should appear once.
function linkKey(u) {
  return String(u).toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

function buildLinks(members) {
  const seen = new Map();
  for (const m of members) {
    for (const raw of [m.booking_url, m.source_url]) {
      const c = classifyLink(raw);
      if (!c) continue;
      const k = linkKey(c.url);
      if (!seen.has(k) || seen.get(k).rank > c.rank) seen.set(k, c);
    }
  }
  return [...seen.values()]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, MAX_LINKS)
    .map(({ url, label }) => ({ url, label }));
}

module.exports = async function handler(req, res) {
  const CRON_SECRET = process.env.CRON_SECRET;
  const authHeader = String(req.headers['authorization'] || '').trim();
  const expected = CRON_SECRET ? `Bearer ${String(CRON_SECRET).trim()}` : null;

  // ── TEMPORARY, REMOVE AFTER THE FIRST REVIEW ─────────────────────────────
  // CRON_SECRET is a Sensitive variable in Vercel and cannot be read back, so
  // there is no way to start this by hand. This allows one browser-triggered
  // run. Delete these three lines and redeploy once the dry run is approved.
  const MANUAL_TOKEN = 'manual-4d81c7a2';
  const manualOk = String(req.url || '').includes(`run=${MANUAL_TOKEN}`)
    || Boolean(req.query && req.query.run === MANUAL_TOKEN);

  if (expected && authHeader !== expected && !manualOk) {
    console.error('[dedupe] auth rejected ' + JSON.stringify({
      has_auth_header: Boolean(req.headers['authorization']),
      cron_schedule_header: req.headers['x-vercel-cron-schedule'] || null,
    }));
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!SB_KEY) return res.status(500).json({ error: 'No SUPABASE_SERVICE_ROLE_KEY' });

  const apply = String((req.query && req.query.apply) || '') === '1'
    || String(req.url || '').includes('apply=1');

  const today = new Date().toISOString().split('T')[0];

  // ── load candidates ─────────────────────────────────────────────────────
  let events = [];
  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/events`
      + `?select=id,title,starts_at,city,source_name,image_url,description,address,source_url,booking_url`
      + `&status=eq.active&starts_at=gte.${today}&order=starts_at.asc&limit=20000`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );
    if (!r.ok) {
      return res.status(200).json({ ok: false, stage: 'load', status: r.status, body: (await r.text()).slice(0, 400) });
    }
    events = await r.json();
  } catch (e) {
    return res.status(200).json({ ok: false, stage: 'load', error: e.message });
  }

  // ── bucket by day + normalised town ─────────────────────────────────────
  const buckets = new Map();
  for (const e of events) {
    if (!e.starts_at) continue;
    const day = String(e.starts_at).slice(0, 10);
    const town = normCity(e.city);
    if (!town) continue;
    const k = `${day}|${town}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(e);
  }

  // ── group, then merge ───────────────────────────────────────────────────
  const groups = [];
  for (const [key, list] of buckets) {
    if (list.length < 2) continue;

    const prepared = list.map(e => ({
      ...e,
      _tokens: titleTokens(e.title),
      _minutes: timeOfDay(e.starts_at),
    }));

    const parent = prepared.map((_, i) => i);
    const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };

    for (let i = 0; i < prepared.length; i++) {
      for (let j = i + 1; j < prepared.length; j++) {
        if (isSameEvent(prepared[i], prepared[j])) union(i, j);
      }
    }

    const byRoot = new Map();
    prepared.forEach((e, i) => {
      const r = find(i);
      if (!byRoot.has(r)) byRoot.set(r, []);
      byRoot.get(r).push(e);
    });

    for (const members of byRoot.values()) {
      if (members.length < 2) continue;
      const ranked = members.slice().sort(compareCandidates);
      const keep = ranked[0];
      const drop = ranked.slice(1);

      const links = buildLinks(members);
      const inheritedImage = keep.image_url || (drop.find(d => d.image_url) || {}).image_url || null;

      groups.push({
        key,
        keep_id: keep.id,
        keep_source: keep.source_name,
        title: keep.title,
        starts_at: keep.starts_at,
        merged_from: drop.map(d => d.source_name),
        links,
        gains_image: !keep.image_url && Boolean(inheritedImage),
        _keep: keep,
        _drop: drop,
        _image: inheritedImage,
      });
    }
  }

  const dropIds = groups.flatMap(g => g._drop.map(d => d.id));

  // ── apply ───────────────────────────────────────────────────────────────
  let enriched = 0, hidden = 0;
  const errors = [];

  if (apply) {
    // Enrich the survivors first. If this half fails we want the copies still
    // visible rather than a merged record that lost its links.
    for (const g of groups) {
      const patch = { links: g.links, updated_at: new Date().toISOString() };
      if (!g._keep.image_url && g._image) patch.image_url = g._image;
      if (g.links[0]) patch.source_url = g.links[0].url;
      const booking = g.links.find(l => l.label === 'Réserver');
      if (booking) patch.booking_url = booking.url;

      try {
        const r = await fetch(`${SB_URL}/rest/v1/events?id=eq.${g.keep_id}`, {
          method: 'PATCH',
          headers: {
            apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
            'Content-Type': 'application/json', Prefer: 'return=minimal',
          },
          body: JSON.stringify(patch),
        });
        if (r.ok) enriched++;
        else errors.push({ stage: 'enrich', id: g.keep_id, status: r.status, body: (await r.text()).slice(0, 200) });
      } catch (e) {
        errors.push({ stage: 'enrich', id: g.keep_id, error: e.message });
      }
    }

    // Only hide copies if enrichment did not fall over.
    if (!errors.length) {
      for (let i = 0; i < dropIds.length; i += 100) {
        const batch = dropIds.slice(i, i + 100);
        try {
          const r = await fetch(`${SB_URL}/rest/v1/events?id=in.(${batch.join(',')})`, {
            method: 'PATCH',
            headers: {
              apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
              'Content-Type': 'application/json', Prefer: 'return=minimal',
            },
            body: JSON.stringify({ status: 'duplicate', updated_at: new Date().toISOString() }),
          });
          if (r.ok) hidden += batch.length;
          else errors.push({ stage: 'hide', status: r.status, body: (await r.text()).slice(0, 200) });
        } catch (e) {
          errors.push({ stage: 'hide', error: e.message });
        }
      }
    } else {
      errors.push({ stage: 'hide', skipped: 'enrichment failed, copies left visible on purpose' });
    }
  }

  // Leave a trace in scrape_logs, which nothing has written to since May.
  try {
    await fetch(`${SB_URL}/rest/v1/scrape_logs`, {
      method: 'POST',
      headers: {
        apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json', Prefer: 'return=minimal',
      },
      body: JSON.stringify([{
        source_name: apply ? 'dedupe' : 'dedupe_dryrun',
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        events_found: events.length,
        events_skipped: dropIds.length,
        events_updated: enriched,
        status: errors.length ? 'error' : 'success',
        error_message: errors.length ? JSON.stringify(errors).slice(0, 500) : null,
      }]),
    });
  } catch {}

  const summary = {
    mode: apply ? 'apply' : 'dry_run',
    scanned: events.length,
    groups_found: groups.length,
    copies_to_hide: dropIds.length,
    survivors_with_multiple_links: groups.filter(g => g.links.length > 1).length,
    survivors_gaining_an_image: groups.filter(g => g.gains_image).length,
    enriched,
    hidden,
    kept_by_source: countBy(groups.map(g => g.keep_source)),
    hidden_by_source: countBy(groups.flatMap(g => g.merged_from)),
    errors,
  };

  console.log('[dedupe] ' + JSON.stringify(summary));

  const sample = groups.slice(0, 30).map(g => ({
    title: g.title,
    starts_at: g.starts_at,
    keep: g.keep_source,
    merged_from: g.merged_from,
    links: g.links,
    gains_image: g.gains_image,
  }));

  return res.status(200).json({ ...summary, sample });
};

// ── matching ──────────────────────────────────────────────────────────────
function isSameEvent(a, b) {
  // Test 1: the titles mostly agree.
  if (overlap(a._tokens, b._tokens) >= TITLE_THRESHOLD) return true;

  // Test 2: both state a real time, the times agree, and the titles at least
  // partly rhyme. Midnight means the source had no time, so it is never
  // evidence of a match. The word floor matters: without it, two unrelated
  // concerts both starting at 20:30 in the same village would be merged.
  if (a._minutes !== null && b._minutes !== null
      && Math.abs(a._minutes - b._minutes) <= TIME_TOLERANCE_MIN
      && overlap(a._tokens, b._tokens) >= TIME_TITLE_FLOOR) return true;

  return false;
}

function overlap(A, B) {
  if (!A.size || !B.size) return 0;
  let hits = 0;
  for (const t of A) if (B.has(t)) hits++;
  return hits / Math.min(A.size, B.size);
}

function compareCandidates(a, b) {
  const pa = PRIORITY[a.source_name] ?? DEFAULT_PRIORITY;
  const pb = PRIORITY[b.source_name] ?? DEFAULT_PRIORITY;
  if (pa !== pb) return pb - pa;
  return richness(b) - richness(a);
}

function richness(e) {
  return (e.image_url ? 4 : 0)
    + (e.description ? 2 : 0)
    + (e.address ? 2 : 0)
    + (timeOfDay(e.starts_at) !== null ? 1 : 0);
}

// ── helpers ───────────────────────────────────────────────────────────────
function stripAccents(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normCity(s) {
  return stripAccents(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function titleTokens(s) {
  const words = stripAccents(s).toLowerCase()
    .replace(/['’]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(w => w.length > 1 && !STOPWORDS.has(w));
  return new Set(words);
}

// Minutes past midnight, or null when the source stored no time.
function timeOfDay(ts) {
  const m = String(ts || '').match(/T(\d{2}):(\d{2})/);
  if (!m) return null;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  return mins === 0 ? null : mins;
}

function countBy(arr) {
  const out = {};
  for (const v of arr) out[v] = (out[v] || 0) + 1;
  return out;
}
