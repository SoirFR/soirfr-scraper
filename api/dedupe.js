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
const VAGUE_CATEGORIES = new Set(['autre', 'patrimoine']);

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
    const prio = PRIORITY[m.source_name] ?? DEFAULT_PRIORITY;
    for (const raw of [m.booking_url, m.source_url]) {
      const c = classifyLink(raw);
      if (!c) continue;
      c.prio = prio;
      const k = linkKey(c.url);
      const cur = seen.get(k);
      if (!cur || cur.rank > c.rank || (cur.rank === c.rank && cur.prio < c.prio)) {
        seen.set(k, c);
      }
    }
  }
  // FIX: when two links classify the same way, the better source wins. Without
  // this, an A2C page and an eterritoire page were both plain "Détails" and the
  // order between them was arbitrary, so eterritoire won by accident.
  return [...seen.values()]
    .sort((a, b) => (a.rank - b.rank) || (b.prio - a.prio))
    .slice(0, MAX_LINKS)
    .map(({ url, label }) => ({ url, label }));
}

// ── field-level merge ─────────────────────────────────────────────────────
// The survivor keeps its own title and coordinates. Everything else is taken
// from whichever copy has the best version of it, best source first.
//
// Deliberately NOT merged: title (assembling one from pieces produces
// gibberish) and location (coordinates are part of the database's dedup_key,
// so changing them can collide with another row). DataTourisme wins the
// priority ranking and is geocoded 100% of the time, so the survivor's pin is
// already the best available.
function mergeFields(members, keep) {
  const ranked = members.slice().sort(
    (a, b) => (PRIORITY[b.source_name] ?? DEFAULT_PRIORITY) - (PRIORITY[a.source_name] ?? DEFAULT_PRIORITY)
  );
  const patch = {};
  const from = {};

  const firstWith = test => ranked.find(m => m !== keep && test(m));

  // Photo: any copy that has one.
  if (!keep.image_url) {
    const donor = firstWith(m => m.image_url);
    if (donor) { patch.image_url = donor.image_url; from.image_url = donor.source_name; }
  }

  // A real start time beats midnight, but only from the same calendar day, so
  // the dedup_key's date component cannot shift.
  if (timeOfDay(keep.starts_at) === null) {
    const day = String(keep.starts_at).slice(0, 10);
    const donor = firstWith(m => timeOfDay(m.starts_at) !== null && String(m.starts_at).slice(0, 10) === day);
    if (donor) { patch.starts_at = donor.starts_at; from.starts_at = donor.source_name; }
  }

  if (!keep.ends_at) {
    const donor = firstWith(m => m.ends_at);
    if (donor) { patch.ends_at = donor.ends_at; from.ends_at = donor.source_name; }
  }

  // Fullest description, but only if it is meaningfully fuller. A marginally
  // longer one is usually the same text with boilerplate attached.
  {
    const cur = (keep.description || '').length;
    const donor = ranked
      .filter(m => m !== keep && m.description)
      .sort((a, b) => b.description.length - a.description.length)[0];
    if (donor && donor.description.length > Math.max(cur * 1.25, cur + 80)) {
      patch.description = donor.description.slice(0, 1000);
      from.description = donor.source_name;
    }
  }

  if (!keep.address) {
    const donor = firstWith(m => m.address);
    if (donor) { patch.address = donor.address; from.address = donor.source_name; }
  }

  // Anything specific beats the two catch-all buckets.
  if (VAGUE_CATEGORIES.has(keep.category)) {
    const donor = firstWith(m => m.category && !VAGUE_CATEGORIES.has(m.category));
    if (donor) { patch.category = donor.category; from.category = donor.source_name; }
  }

  return { patch, from };
}

module.exports = async function handler(req, res) {
  if (!SB_KEY) return res.status(500).json({ error: 'No SUPABASE_SERVICE_ROLE_KEY' });

  // ── ?report=1 : the daily health digest ─────────────────────────────────
  // Deliberately public and read-only. Counts only, never event contents and
  // never secrets, so the morning report can fetch it without credentials.
  // It lives in this file rather than its own because the Hobby plan allows
  // only 12 serverless functions per deployment.
  if (String((req.query && req.query.report) || '') === '1'
      || String(req.url || '').includes('report=1')) {
    return res.status(200).json(await healthDigest());
  }

  const CRON_SECRET = process.env.CRON_SECRET;
  const authHeader = String(req.headers['authorization'] || '').trim();
  const expected = CRON_SECRET ? `Bearer ${String(CRON_SECRET).trim()}` : null;

  if (expected && authHeader !== expected) {
    console.error('[dedupe] auth rejected ' + JSON.stringify({
      has_auth_header: Boolean(req.headers['authorization']),
      cron_schedule_header: req.headers['x-vercel-cron-schedule'] || null,
    }));
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const apply = String((req.query && req.query.apply) || '') === '1'
    || String(req.url || '').includes('apply=1');

  const today = new Date().toISOString().split('T')[0];

  // ── load candidates ─────────────────────────────────────────────────────
  // Supabase caps any single response at 1000 rows, so page through. Without
  // this the job silently deduplicated only the soonest 1000 events and left
  // every duplicate beyond that untouched.
  const PAGE = 1000;
  let events = [];
  try {
    for (let offset = 0; offset < 20000; offset += PAGE) {
      const r = await fetch(
        `${SB_URL}/rest/v1/events`
        + `?select=id,title,starts_at,ends_at,city,source_name,image_url,description,address,category,price_min,is_free,source_url,booking_url,status`
        // Hidden copies are loaded so they can still donate a link or an image to
        // the card that survived. They are never eligible to become the keeper,
        // so nothing already hidden is ever brought back to the map.
        + `&status=in.(active,duplicate)&starts_at=gte.${today}&order=starts_at.asc,id.asc`
        + `&limit=${PAGE}&offset=${offset}`,
        { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
      );
      if (!r.ok) {
        return res.status(200).json({ ok: false, stage: 'load', offset, status: r.status, body: (await r.text()).slice(0, 400) });
      }
      const batch = await r.json();
      events = events.concat(batch);
      if (batch.length < PAGE) break;
    }
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

      // Only a currently visible event can be the survivor. If a group is made
      // up entirely of already-hidden rows, leave it alone: something else
      // hid those and it is not this job's business to undo it.
      const visible = members.filter(m => m.status === 'active');
      if (!visible.length) continue;

      const ranked = visible.slice().sort(compareCandidates);
      const keep = ranked[0];
      const drop = ranked.slice(1);

      // Links and images come from every copy, hidden ones included.
      const links = buildLinks(members);
      const { patch: fieldPatch, from: fieldFrom } = mergeFields(members, keep);

      groups.push({
        key,
        keep_id: keep.id,
        keep_source: keep.source_name,
        title: keep.title,
        starts_at: keep.starts_at,
        merged_from: drop.map(d => d.source_name),
        links,
        gained: Object.keys(fieldFrom),
        gained_from: fieldFrom,
        _keep: keep,
        _drop: drop,
        _patch: fieldPatch,
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
      const patch = { ...g._patch, links: g.links, updated_at: new Date().toISOString() };
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
    fields_gained: groups.flatMap(g => g.gained).reduce((acc, f) => (acc[f] = (acc[f] || 0) + 1, acc), {}),
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
    gained: g.gained_from,
  }));

  // Some sources deliver a commune and a postcode but no coordinates.
  // ST_DWithin can never match a null location, so those events are invisible
  // on the map. Convert the commune to a point once, here, before the pages
  // rebuild, rather than teaching the frontend about town names.
  let geocoded = null;
  if (apply) {
    geocoded = await backfillCoordinates();
    console.log('[dedupe] geocode ' + JSON.stringify(geocoded));
  }

  // Rebuild the static place pages so they carry tonight's events. Only after
  // a real apply run, never on a dry run and never on ?report=1, which returns
  // long before this. A failed rebuild must not fail the merge, but it must
  // never be silent either: the outcome goes in the response and the log.
  let rebuild = null;
  if (apply) {
    const hook = process.env.FRONTEND_DEPLOY_HOOK;
    if (!hook) {
      rebuild = 'skipped: FRONTEND_DEPLOY_HOOK is not set';
    } else {
      try {
        const r = await fetch(hook, { method: 'POST' });
        rebuild = r.ok ? 'triggered' : `failed: HTTP ${r.status}`;
      } catch (e) {
        rebuild = 'failed: ' + e.message;
      }
    }
    console.log('[dedupe] frontend rebuild ' + rebuild);
  }

  return res.status(200).json({ ...summary, geocoded, rebuild, sample });
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

// ══ daily health digest ═══════════════════════════════════════════════════
// Answers, in one call: are the scrapers still running, is anything stuck,
// are the crêperie dates still right, and is anything in the database that
// should not be there.

const BFC = ['21', '25', '39', '58', '70', '71', '89', '90'];
// A source that has added nothing is not necessarily broken. animation2c and
// agenda_culturel_71 publish a whole season in one sheet, so once it is
// ingested there is genuinely nothing new for weeks. Only shout after several
// quiet days, and never for the sources that are batch-loaded by nature.
const STALE_HOURS = 96;
const BATCH_SOURCES = new Set([
  'animation2c', 'agenda_culturel_71', 'recurring', 'proprietaire', 'user_submission',
]);
const HEALTH_SOURCES = [
  'datatourisme', 'brocabrac', 'eterritoire', 'openagenda_api',
  'animation2c', 'agenda_culturel_71', 'lejsl', 'recurring', 'proprietaire',
];

async function healthDigest() {
  const nowIso = new Date().toISOString();
  const today = nowIso.split('T')[0];
  const staleCutoff = new Date(Date.now() - STALE_HOURS * 3600 * 1000).toISOString();

  const issues = [];
  const out = { generated_at: nowIso, issues };

  try {
    out.upcoming = await hCount(`status=eq.active&starts_at=gte.${today}`);
    out.hidden_as_duplicate = await hCount(`status=eq.duplicate`);

    out.sources = {};
    for (const s of HEALTH_SOURCES) {
      const upcoming = await hCount(`source_name=eq.${s}&status=eq.active&starts_at=gte.${today}`);
      const fresh = await hCount(`source_name=eq.${s}&created_at=gte.${staleCutoff}`);
      out.sources[s] = { upcoming, added_last_48h: fresh };
      if (upcoming > 0 && fresh === 0 && !BATCH_SOURCES.has(s)) {
        issues.push(`${s} has added nothing in ${STALE_HOURS}h and may be broken`);
      }
    }

    const blood = await hCount(
      `status=eq.active&starts_at=gte.${today}`
      + `&or=(title.ilike.*don du sang*,title.ilike.*collecte de sang*,title.ilike.*don de sang*)`
    );
    out.blood_drives = blood;
    if (blood > 0) issues.push(`${blood} blood drive${blood > 1 ? 's' : ''} back in the database`);

    const noGeo = await hCount(`status=eq.active&starts_at=gte.${today}&location=is.null`);
    out.missing_coordinates = noGeo;
    if (noGeo > 50) issues.push(`${noGeo} upcoming events have no map pin`);

    const outside = await hCount(
      `status=eq.active&starts_at=gte.${today}&department=not.in.(${BFC.join(',')})`
    );
    // Reported, not flagged: covering a little beyond the region is deliberate.
    out.outside_region = outside;

    const creperie = await hCount(
      `source_name=eq.proprietaire&status=eq.active&starts_at=gte.${today}`
    );
    out.creperie_dates_remaining = creperie;
    out.creperie_next = await hFirstDate(
      `source_name=eq.proprietaire&status=eq.active&starts_at=gte.${today}&order=starts_at.asc&limit=1`
    );
    if (creperie === 0) {
      issues.push('No crêperie dates left. The Instagram caption says all their dates are on the map.');
    } else if (creperie <= 2) {
      issues.push(`Only ${creperie} crêperie date${creperie > 1 ? 's' : ''} left, ask Marie-Antoinette for the next calendar`);
    }

    // Only rows actually awaiting a decision. Counting the whole table made
    // 8 approved and 1 rejected submission look like 9 people waiting.
    out.pending_submissions = await hCountTable('pending_events', 'status=eq.pending');
    if (out.pending_submissions > 0) {
      issues.push(`${out.pending_submissions} event submission${out.pending_submissions > 1 ? 's' : ''} waiting for review`);
    }

    const vague = await hCount(
      `status=eq.active&starts_at=gte.${today}&category=in.(autre,patrimoine)`
    );
    out.vague_category = vague;
    out.vague_share = out.upcoming ? Math.round((vague / out.upcoming) * 100) : 0;
    if (out.vague_share > 45) {
      issues.push(`${out.vague_share}% of upcoming events sit in autre or patrimoine`);
    }
  } catch (e) {
    issues.push('Health check failed partway: ' + e.message);
    out.error = e.message;
  }

  out.all_clear = issues.length === 0;
  console.log('[health] ' + JSON.stringify({ upcoming: out.upcoming, issues }));
  return out;
}

function hCount(filter) {
  return hCountTable('events', filter);
}

async function hCountTable(table, filter) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?select=id${filter ? '&' + filter : ''}`, {
    method: 'HEAD',
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      Prefer: 'count=exact', Range: '0-0',
    },
  });
  const cr = r.headers.get('content-range') || '';
  const total = cr.split('/')[1];
  return total && total !== '*' ? Number(total) : 0;
}

async function hFirstDate(filter) {
  const r = await fetch(`${SB_URL}/rest/v1/events?select=starts_at&${filter}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows && rows[0] ? String(rows[0].starts_at).slice(0, 10) : null;
}

// ── coordinates backfill ───────────────────────────────────────────────────
// Commune plus postcode is unambiguous: "Saint-Pierre" is dozens of places,
// "Saint-Pierre 39150" is exactly one. Uses the French government's address
// API, which is free and needs no key.
const GEO_LIMIT = 25;   // per run; the backlog is normally a handful

async function backfillCoordinates() {
  const out = { candidates: 0, fixed: 0, not_found: 0, collided: 0, errors: [] };

  const r = await fetch(
    `${SB_URL}/rest/v1/events?select=id,city,postcode` +
    `&status=eq.active&location=is.null&city=not.is.null&postcode=not.is.null` +
    `&limit=${GEO_LIMIT}`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
  );
  if (!r.ok) {
    out.errors.push(`load ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return out;
  }
  const rows = await r.json();
  out.candidates = rows.length;

  for (const row of rows) {
    try {
      const q = new URLSearchParams({
        q: String(row.city),
        postcode: String(row.postcode),
        type: 'municipality',
        limit: '1',
      });
      const g = await fetch(`https://api-adresse.data.gouv.fr/search/?${q}`);
      if (!g.ok) { out.errors.push(`ban ${g.status}`); continue; }
      const j = await g.json();
      const hit = j && j.features && j.features[0];
      // A corrupted city, like a title pasted into the field, simply misses.
      if (!hit || !hit.geometry) { out.not_found++; continue; }
      const [lng, lat] = hit.geometry.coordinates;
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) { out.not_found++; continue; }

      const u = await fetch(`${SB_URL}/rest/v1/events?id=eq.${row.id}`, {
        method: 'PATCH',
        headers: {
          apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
          'Content-Type': 'application/json', Prefer: 'return=minimal',
        },
        body: JSON.stringify({ location: `SRID=4326;POINT(${lng} ${lat})` }),
      });
      // Writing coordinates recomputes the dedup key. If that collides with an
      // existing active row, leave this one alone rather than forcing it.
      if (u.status === 409) { out.collided++; continue; }
      if (!u.ok) { out.errors.push(`patch ${u.status}`); continue; }
      out.fixed++;
    } catch (e) {
      out.errors.push(e.message);
    }
  }
  return out;
}
