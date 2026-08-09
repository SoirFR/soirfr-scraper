// SoirFR — daily health digest
//
// Read-only. Returns counts only, never event contents and never secrets, so
// it can be fetched by the morning report without any credentials.
//
// Answers, in one call: are the scrapers still running, is anything stuck,
// are the crêperie dates still right, and is anything in the database that
// should not be there.

const SB_URL = 'https://ebinsidruxvbzukobshf.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const BFC = ['21', '25', '39', '58', '70', '71', '89', '90'];

// A source that has not produced a new row in this many hours is worth a look.
const STALE_HOURS = 48;

const SOURCES = [
  'datatourisme', 'brocabrac', 'eterritoire', 'openagenda_api',
  'animation2c', 'agenda_culturel_71', 'lejsl', 'recurring', 'proprietaire',
];

module.exports = async function handler(req, res) {
  if (!SB_KEY) return res.status(500).json({ error: 'No SUPABASE_SERVICE_ROLE_KEY' });

  const nowIso = new Date().toISOString();
  const today = nowIso.split('T')[0];
  const staleCutoff = new Date(Date.now() - STALE_HOURS * 3600 * 1000).toISOString();

  const issues = [];
  const out = { generated_at: nowIso, issues };

  try {
    // ── volume ───────────────────────────────────────────────────────────
    out.upcoming = await count(`status=eq.active&starts_at=gte.${today}`);
    out.hidden_as_duplicate = await count(`status=eq.duplicate`);

    // ── per source freshness ─────────────────────────────────────────────
    out.sources = {};
    for (const s of SOURCES) {
      const upcoming = await count(`source_name=eq.${s}&status=eq.active&starts_at=gte.${today}`);
      const fresh = await count(`source_name=eq.${s}&created_at=gte.${staleCutoff}`);
      out.sources[s] = { upcoming, added_last_48h: fresh };
      if (upcoming > 0 && fresh === 0 && s !== 'proprietaire' && s !== 'recurring') {
        issues.push(`${s} has added nothing in ${STALE_HOURS}h`);
      }
    }

    // ── things that should not be there ──────────────────────────────────
    const blood = await count(
      `status=eq.active&starts_at=gte.${today}`
      + `&or=(title.ilike.*don du sang*,title.ilike.*collecte de sang*,title.ilike.*don de sang*)`
    );
    out.blood_drives = blood;
    if (blood > 0) issues.push(`${blood} blood drive${blood > 1 ? 's' : ''} back in the database`);

    const noGeo = await count(`status=eq.active&starts_at=gte.${today}&location=is.null`);
    out.missing_coordinates = noGeo;
    if (noGeo > 50) issues.push(`${noGeo} upcoming events have no map pin`);

    const outside = await count(
      `status=eq.active&starts_at=gte.${today}&department=not.in.(${BFC.join(',')})`
    );
    out.outside_region = outside;
    if (outside > 100) issues.push(`${outside} upcoming events are outside Bourgogne-Franche-Comté`);

    // ── the crêperie, because a published caption depends on it ──────────
    const creperieUpcoming = await count(
      `source_name=eq.proprietaire&status=eq.active&starts_at=gte.${today}`
    );
    out.creperie_dates_remaining = creperieUpcoming;
    out.creperie_next = await firstDate(
      `source_name=eq.proprietaire&status=eq.active&starts_at=gte.${today}&order=starts_at.asc&limit=1`
    );
    if (creperieUpcoming === 0) {
      issues.push('No crêperie dates left. The Instagram caption says all their dates are on the map.');
    } else if (creperieUpcoming <= 2) {
      issues.push(`Only ${creperieUpcoming} crêperie date${creperieUpcoming > 1 ? 's' : ''} left, ask Marie-Antoinette for the next calendar`);
    }

    // ── waiting on a human ───────────────────────────────────────────────
    out.pending_submissions = await countTable('pending_events', '');
    if (out.pending_submissions > 0) {
      issues.push(`${out.pending_submissions} event submission${out.pending_submissions > 1 ? 's' : ''} waiting for review`);
    }

    // ── categorisation drift ─────────────────────────────────────────────
    const vague = await count(
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
  return res.status(200).json(out);
};

// ── helpers ───────────────────────────────────────────────────────────────
async function count(filter) {
  return countTable('events', filter);
}

async function countTable(table, filter) {
  const url = `${SB_URL}/rest/v1/${table}?select=id${filter ? '&' + filter : ''}`;
  const r = await fetch(url, {
    method: 'HEAD',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      Prefer: 'count=exact',
      Range: '0-0',
    },
  });
  const cr = r.headers.get('content-range') || '';
  const total = cr.split('/')[1];
  return total && total !== '*' ? Number(total) : 0;
}

async function firstDate(filter) {
  const r = await fetch(`${SB_URL}/rest/v1/events?select=starts_at&${filter}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows && rows[0] ? String(rows[0].starts_at).slice(0, 10) : null;
}
