// SoirFR — Full National Scraper v5
// Burgundy deep focus + all major French national sources

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

  // TIER 1: OpenAgenda public feeds — Burgundy (20 sources, no key)
  const OA_BURGUNDY = [
    { slug:'bourgogne-tourisme',            name:'Bourgogne Tourisme',           dept:null, region:'Bourgogne-Franche-Comté' },
    { slug:'destination-saone-et-loire',    name:'Destination Saône-et-Loire',   dept:'71', region:'Bourgogne-Franche-Comté' },
    { slug:'agenda-saone-et-loire',         name:'Agenda Saône-et-Loire',        dept:'71', region:'Bourgogne-Franche-Comté' },
    { slug:'tourisme-beaune-cote-et-sud',   name:'OT Beaune',                    dept:'21', region:'Bourgogne-Franche-Comté' },
    { slug:'cluny-sud-bourgogne-tourisme',  name:'OT Cluny',                     dept:'71', region:'Bourgogne-Franche-Comté' },
    { slug:'macon-tourisme',                name:'OT Mâcon',                     dept:'71', region:'Bourgogne-Franche-Comté' },
    { slug:'chalon-sur-saone-tourisme',     name:'OT Chalon-sur-Saône',          dept:'71', region:'Bourgogne-Franche-Comté' },
    { slug:'autun-morvan-tourisme',         name:'OT Autun Morvan',              dept:'71', region:'Bourgogne-Franche-Comté' },
    { slug:'creusot-montceau-tourisme',     name:'OT Creusot Montceau',          dept:'71', region:'Bourgogne-Franche-Comté' },
    { slug:'tourisme-saone-et-grosne',      name:'Tourisme Saône et Grosne',     dept:'71', region:'Bourgogne-Franche-Comté' },
    { slug:'pays-charolais-brionnais',      name:'Pays Charolais-Brionnais',     dept:'71', region:'Bourgogne-Franche-Comté' },
    { slug:'sud-bourgogne-tourisme',        name:'Sud Bourgogne Tourisme',       dept:'71', region:'Bourgogne-Franche-Comté' },
    { slug:'tourisme-sud-cote-chalonnaise', name:'Sud Côte Chalonnaise',         dept:'71', region:'Bourgogne-Franche-Comté' },
    { slug:'verts-vallons-sud-bourgogne',   name:'Verts Vallons',                dept:'71', region:'Bourgogne-Franche-Comté' },
    { slug:'agenda-culturel-71',            name:'Agenda Culturel 71',           dept:'71', region:'Bourgogne-Franche-Comté' },
    { slug:'sortez-chez-vous-bourgogne',    name:'Sortez Chez Vous Bourgogne',   dept:null, region:'Bourgogne-Franche-Comté' },
    { slug:'eterritoire-bfc',               name:'eTerritoire BFC',              dept:null, region:'Bourgogne-Franche-Comté' },
    { slug:'agenda-du-morvan',              name:'Agenda du Morvan',             dept:null, region:'Bourgogne-Franche-Comté' },
    { slug:'infolocale-saone-et-loire',     name:'Infolocale 71',                dept:'71', region:'Bourgogne-Franche-Comté' },
    { slug:'sabradou-bourgogne',            name:'Sabradou Bourgogne',           dept:null, region:'Bourgogne-Franche-Comté' },
  ];

  // TIER 2: OpenAgenda public feeds — National
  const OA_NATIONAL = [
    { slug:'sortir-a-paris',               name:'Sortir à Paris',         dept:'75', region:'Île-de-France' },
    { slug:'agenda-ile-de-france',         name:'Agenda Île-de-France',   dept:null, region:'Île-de-France' },
    { slug:'myprovence-agenda',            name:'MyProvence',             dept:null, region:"Provence-Alpes-Côte d'Azur" },
    { slug:'marseille-tourisme',           name:'Marseille Tourisme',     dept:'13', region:"Provence-Alpes-Côte d'Azur" },
    { slug:'only-lyon-agenda',             name:'Only Lyon',              dept:'69', region:'Auvergne-Rhône-Alpes' },
    { slug:'grenoble-tourisme',            name:'Grenoble Tourisme',      dept:'38', region:'Auvergne-Rhône-Alpes' },
    { slug:'toulouse-tourisme',            name:'Toulouse Tourisme',      dept:'31', region:'Occitanie' },
    { slug:'rennes-tourisme',              name:'Rennes Tourisme',        dept:'35', region:'Bretagne' },
    { slug:'bordeaux-tourisme',            name:'Bordeaux Tourisme',      dept:'33', region:'Nouvelle-Aquitaine' },
    { slug:'agenda-lille',                 name:'Agenda Lille',           dept:'59', region:'Hauts-de-France' },
    { slug:'fete-de-la-musique-france',    name:'Fête de la Musique',     dept:null, region:null },
    { slug:'journees-europeennes-patrimoine', name:'Journées Patrimoine', dept:null, region:null },
    { slug:'nuit-des-musees',              name:'Nuit des Musées',        dept:null, region:null },
  ];

  for (const agenda of [...OA_BURGUNDY, ...OA_NATIONAL]) {
    try { results.push(await scrapeOAPublic(agenda, dateFrom, dateTo)); }
    catch (e) { errors.push({ source: agenda.name, error: e.message }); }
    await sleep(400);
  }

  // TIER 3: OpenAgenda API geographic (with key)
  if (OA_KEY) {
    try { results.push(await scrapeOAApi(OA_KEY, ['71','21','58','89'], dateFrom, dateTo, 'Bourgogne-Franche-Comté')); }
    catch (e) { errors.push({ source:'oa_api_burgundy', error:e.message }); }
    try { results.push(await scrapeOAApi(OA_KEY, ['75','69','13','31','33','59','67','06','34','44'], dateFrom, dateTo, null)); }
    catch (e) { errors.push({ source:'oa_api_national', error:e.message }); }
  }

  // TIER 4: Paris Open Data (free, no key)
  try { results.push(await scrapeParisOpenData(dateFrom)); }
  catch (e) { errors.push({ source:'paris_opendata', error:e.message }); }

  // TIER 5: Ticketmaster France
  if (TM_KEY) {
    try { results.push(await scrapeTicketmaster(TM_KEY, dateFrom, dateTo)); }
    catch (e) { errors.push({ source:'ticketmaster', error:e.message }); }
  }

  // TIER 6: Brocabrac (Burgundy + major departments)
  const BROCA_DEPTS = ['71','21','58','89','75','69','13','33','31','59','44','06','67','34','35','38','76','78','92','93','94'];
  try { results.push(await scrapeBrocabrac(BROCA_DEPTS, dateFrom)); }
  catch (e) { errors.push({ source:'brocabrac', error:e.message }); }

  // TIER 7: Vide-Greniers.org
  const VG = [
    {dept:'71',label:'Saone-et-Loire'},{dept:'21',label:'Cote-dOr'},
    {dept:'75',label:'Paris'},{dept:'69',label:'Rhone'},
    {dept:'13',label:'Bouches-du-Rhone'},{dept:'33',label:'Gironde'},
    {dept:'59',label:'Nord'},{dept:'31',label:'Haute-Garonne'},
  ];
  try { results.push(await scrapeVG(VG, dateFrom)); }
  catch (e) { errors.push({ source:'vide_greniers', error:e.message }); }

  // TIER 8: JSON-LD scrapers — specific Burgundy sites
  const JSONLD_SITES = [
    { url:'https://www.jds.fr/saone-et-loire/agenda/',           name:'JDS 71',            dept:'71', region:'Bourgogne-Franche-Comté', source:'jds_71' },
    { url:'https://www.jds.fr/saone-et-loire/agenda/concerts/',  name:'JDS 71 Concerts',   dept:'71', region:'Bourgogne-Franche-Comté', source:'jds_71' },
    { url:'https://www.jds.fr/saone-et-loire/agenda/expos/',     name:'JDS 71 Expos',      dept:'71', region:'Bourgogne-Franche-Comté', source:'jds_71' },
    { url:'https://www.jds.fr/saone-et-loire/agenda/spectacles/',name:'JDS 71 Spectacles', dept:'71', region:'Bourgogne-Franche-Comté', source:'jds_71' },
    { url:'https://www.jds.fr/saone-et-loire/agenda/brocantes/', name:'JDS 71 Brocantes',  dept:'71', region:'Bourgogne-Franche-Comté', source:'jds_71', cat:'brocante' },
    { url:'https://www.jds.fr/saone-et-loire/agenda/marches/',   name:'JDS 71 Marchés',    dept:'71', region:'Bourgogne-Franche-Comté', source:'jds_71', cat:'marche' },
    { url:'https://www.destination-saone-et-loire.fr/fr/les-evenements-en-saone-et-loire.html', name:'Destination S&L', dept:'71', region:'Bourgogne-Franche-Comté', source:'destination_saone_et_loire' },
    { url:'https://www.bourgogne-tourisme.com/sejourner/agenda/', name:'Bourgogne Tourisme Web', dept:null, region:'Bourgogne-Franche-Comté', source:'bourgogne_tourisme_web' },
  ];

  for (const site of JSONLD_SITES) {
    try {
      const res2 = await fetch(site.url, { headers:{ 'User-Agent':'SoirFR/1.0' } });
      if (!res2.ok) continue;
      const html = await res2.text();
      const r = await extractJsonLd(html, site.dept, site.region, site.source, site.url, dateFrom, site.cat||null);
      results.push({ source: site.name, found: r.found, added: r.added });
    } catch (e) { errors.push({ source: site.name, error: e.message }); }
    await sleep(500);
  }

  const total_added = results.reduce((s,r)=>s+(r.added||0),0);
  const total_found = results.reduce((s,r)=>s+(r.found||0),0);

  await sbFetch('scrape_logs','POST',{
    source_name:'all_national', finished_at:new Date().toISOString(),
    events_found:total_found, events_added:total_added,
    status:errors.length===0?'success':'partial',
    error_message:errors.length?JSON.stringify(errors.slice(0,10)):null,
  });

  return res.status(200).json({ success:true, total_added, total_found, results, errors });
};

// ── OpenAgenda public feed ────────────────────────────────────────────────
async function scrapeOAPublic(agenda, dateFrom, dateTo) {
  const url = `https://openagenda.com/agendas/${agenda.slug}/events.json?oaq[after]=${dateFrom}&oaq[before]=${dateTo}&lang=fr&size=100`;
  const res = await fetch(url, { headers:{ 'User-Agent':'SoirFR/1.0','Accept':'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const events = data.events || data.items || [];
  let added = 0;
  for (const ev of events) {
    const timing = ev.timings?.[0];
    const startDate = timing?.begin || ev.firstDate;
    if (!startDate) continue;
    const ins = await insertEvent({
      title: ev.title?.fr||ev.title?.en||ev.title||'Événement',
      description: (ev.description?.fr||ev.description||'').slice(0,1000),
      category: mapCat(ev.keywords?.fr?.join(' ')||ev.tags?.join(' ')||''),
      address: ev.location?.address||ev.place?.address,
      city: ev.location?.city||ev.place?.city,
      postcode: ev.location?.postalCode||ev.place?.postalCode,
      department: agenda.dept, region: agenda.region,
      lat: ev.location?.latitude||ev.place?.latitude,
      lng: ev.location?.longitude||ev.place?.longitude,
      starts_at: startDate, ends_at: timing?.end||ev.lastDate,
      image_url: ev.image?.filename?`https://cibul.s3.amazonaws.com/${ev.image.filename}`:ev.thumbnail,
      is_free: ev.conditions?.fr?.toLowerCase().includes('gratuit')||ev.free===true,
      booking_url: ev.registration?.[0]?.value||ev.ticketingUrl,
      source_url: `https://openagenda.com/agendas/${agenda.slug}/events/${ev.slug||ev.uid}`,
      source_event_id: String(ev.uid||ev.id||ev.slug),
      source_name: `oa_${agenda.slug}`,
    });
    if (ins) added++;
  }
  return { source:agenda.name, found:events.length, added };
}

// ── OpenAgenda API geographic ─────────────────────────────────────────────
async function scrapeOAApi(key, depts, dateFrom, dateTo, defaultRegion) {
  const events = [];
  for (const dept of depts) {
    const params = new URLSearchParams({ key, size:100, 'timings[gte]':dateFrom, 'timings[lte]':dateTo, 'location[department]':dept, detailed:1 });
    try { const r=await fetch(`https://api.openagenda.com/v2/events?${params}`); if(r.ok){const d=await r.json();events.push(...(d.events||[]).map(e=>({...e,_dept:dept})));} } catch {}
    await sleep(300);
  }
  let added=0;
  for (const ev of events) {
    const t=ev.timings?.[0]; if(!t) continue;
    const ins=await insertEvent({ title:ev.title?.fr||ev.title?.en||'Événement', description:ev.description?.fr?.slice(0,1000), category:mapCat(ev.keywords?.fr?.[0]||''), address:ev.location?.address, city:ev.location?.city, postcode:ev.location?.postalCode, department:ev.location?.department||ev._dept, region:ev.location?.region||defaultRegion, lat:ev.location?.latitude, lng:ev.location?.longitude, starts_at:t.begin, ends_at:t.end, image_url:ev.image?ev.image.base+ev.image.filename:null, is_free:ev.conditions?.fr?.toLowerCase().includes('gratuit')||false, booking_url:ev.registration?.[0]?.value||null, source_url:`https://openagenda.com/events/${ev.slug}`, source_event_id:String(ev.uid), source_name:'openagenda_api' });
    if(ins) added++;
  }
  return { source:`OA API (${depts.join(',')})`, found:events.length, added };
}

// ── Paris Open Data ───────────────────────────────────────────────────────
async function scrapeParisOpenData(dateFrom) {
  const params = new URLSearchParams({ limit:100, where:`date_start >= '${dateFrom}'`, order_by:'date_start ASC' });
  const res = await fetch(`https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/que-faire-a-paris-/records?${params}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const events = data.results||[];
  let added=0;
  for (const ev of events) {
    const ins=await insertEvent({ title:ev.title, description:ev.lead_text?.slice(0,1000), category:mapCat(ev.category||''), address:ev.address_name, city:'Paris', postcode:ev.address_zipcode, department:'75', region:'Île-de-France', lat:ev.lat_lon?.lat, lng:ev.lat_lon?.lon, starts_at:ev.date_start, ends_at:ev.date_end, image_url:ev.cover_url, is_free:ev.price_type==='free', booking_url:ev.url, source_url:ev.url, source_event_id:String(ev.id), source_name:'ot_paris' });
    if(ins) added++;
  }
  return { source:'Paris Open Data', found:events.length, added };
}

// ── Ticketmaster ──────────────────────────────────────────────────────────
async function scrapeTicketmaster(key, dateFrom, dateTo) {
  const params = new URLSearchParams({ apikey:key, countryCode:'FR', startDateTime:new Date(dateFrom).toISOString().replace('.000',''), endDateTime:new Date(dateTo).toISOString().replace('.000',''), size:200, sort:'date,asc' });
  const res = await fetch(`https://app.ticketmaster.com/discovery/v2/events.json?${params}`);
  if (!res.ok) return { source:'Ticketmaster', found:0, added:0 };
  const data = await res.json();
  const events = data?._embedded?.events||[];
  let added=0;
  for (const ev of events) {
    const v=ev._embedded?.venues?.[0], p=ev.priceRanges?.[0], d=ev.dates?.start;
    const ins=await insertEvent({ title:ev.name, description:ev.info?.slice(0,1000), category:mapCat(ev.classifications?.[0]?.segment?.name||''), address:v?.address?.line1, city:v?.city?.name, postcode:v?.postalCode, country:'FR', lat:parseFloat(v?.location?.latitude)||null, lng:parseFloat(v?.location?.longitude)||null, starts_at:d?.dateTime||d?.localDate, image_url:ev.images?.find(i=>i.ratio==='16_9'&&i.width>500)?.url, price_min:p?.min, price_max:p?.max, is_free:p?.min===0, booking_url:ev.url, source_url:ev.url, source_event_id:ev.id, source_name:'ticketmaster_france' });
    if(ins) added++;
  }
  return { source:'Ticketmaster France', found:events.length, added };
}

// ── Brocabrac ─────────────────────────────────────────────────────────────
async function scrapeBrocabrac(depts, dateFrom) {
  let added=0, found=0;
  for (const dept of depts) {
    try {
      const res=await fetch(`https://www.brocabrac.fr/${dept}/`,{headers:{'User-Agent':'SoirFR/1.0'}});
      if(!res.ok) continue;
      const html=await res.text();
      const r=await extractJsonLd(html, dept, null, 'brocabrac', `https://www.brocabrac.fr/${dept}/`, dateFrom, 'brocante');
      added+=r.added; found+=r.found;
      await sleep(600);
    } catch {}
  }
  return { source:'Brocabrac', found, added };
}

// ── Vide-Greniers.org ─────────────────────────────────────────────────────
async function scrapeVG(deptList, dateFrom) {
  let added=0, found=0;
  for (const {dept,label} of deptList) {
    try {
      const res=await fetch(`https://www.vide-greniers.org/${dept}-${label}.htm`,{headers:{'User-Agent':'SoirFR/1.0'}});
      if(!res.ok) continue;
      const html=await res.text();
      const r=await extractJsonLd(html, dept, null, 'vide_greniers', `https://www.vide-greniers.org/${dept}-${label}.htm`, dateFrom, 'brocante');
      added+=r.added; found+=r.found;
      await sleep(500);
    } catch {}
  }
  return { source:'Vide-Greniers.org', found, added };
}

// ── Generic JSON-LD extractor ─────────────────────────────────────────────
async function extractJsonLd(html, dept, region, sourceName, baseUrl, dateFrom, defaultCat) {
  let added=0, found=0;
  for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) {
    try {
      const schema=JSON.parse(match[1]);
      const items=[].concat(schema?.['@graph']||schema);
      for (const item of items) {
        const type=String(Array.isArray(item['@type'])?item['@type'].join(' '):item['@type']||'');
        if(!type.includes('Event')) continue;
        found++;
        if(item.startDate&&item.startDate<dateFrom) continue;
        const ins=await insertEvent({ title:item.name, description:item.description?.slice(0,1000), category:defaultCat||mapCat(item.name+' '+(item.description||'')), address:item.location?.address?.streetAddress, city:item.location?.address?.addressLocality, postcode:item.location?.address?.postalCode, department:dept, region, lat:item.location?.geo?.latitude, lng:item.location?.geo?.longitude, starts_at:item.startDate, ends_at:item.endDate, image_url:Array.isArray(item.image)?item.image[0]:item.image, is_free:item.isAccessibleForFree===true, booking_url:item.url, source_url:item.url||baseUrl, source_event_id:item.url||item.name, source_name:sourceName });
        if(ins) added++;
      }
    } catch {}
  }
  return { found, added };
}

// ── Insert with dedup ─────────────────────────────────────────────────────
async function insertEvent(ev) {
  if (!ev.title||!ev.starts_at) return false;
  if (ev.source_event_id&&ev.source_name) {
    const existing=await sbFetch(`events?source_name=eq.${encodeURIComponent(ev.source_name)}&source_event_id=eq.${encodeURIComponent(String(ev.source_event_id).slice(0,200))}&select=id`,'GET');
    if(existing?.length>0) return false;
  }
  const lat=parseFloat(ev.lat), lng=parseFloat(ev.lng);
  const loc=(!isNaN(lat)&&!isNaN(lng)&&lat!==0&&lng!==0)?`POINT(${lng} ${lat})`:null;
  return await sbFetch('events','POST',{ title:String(ev.title).slice(0,500), description:ev.description||null, category:ev.category||'autre', address:ev.address||null, city:ev.city||null, postcode:ev.postcode||null, department:ev.department||null, region:ev.region||null, country:ev.country||'FR', location:loc, starts_at:ev.starts_at, ends_at:ev.ends_at||null, image_url:ev.image_url||null, price_min:ev.price_min??null, price_max:ev.price_max??null, is_free:ev.is_free||false, booking_url:ev.booking_url||null, source_type:'scraper', source_name:ev.source_name, source_url:ev.source_url||null, source_event_id:ev.source_event_id?String(ev.source_event_id).slice(0,200):null, status:'active', scraped_at:new Date().toISOString() });
}

async function sbFetch(path,method='GET',body=null) {
  try {
    const res=await fetch(`${SB_URL}/rest/v1/${path}`,{ method, headers:{'apikey':SB_KEY,'Authorization':`Bearer ${SB_KEY}`,'Content-Type':'application/json','Prefer':method==='POST'?'return=minimal':''}, body:body?JSON.stringify(body):null });
    if(method==='GET') return await res.json();
    return res.ok;
  } catch { return null; }
}

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

function mapCat(raw) {
  if(!raw) return 'autre';
  const r=raw.toLowerCase();
  if(/concert|musique|music|jazz|rock|chanson|orchestre|piano|chorale|chant/.test(r)) return 'musique';
  if(/cin[eé]|film|projection|documentaire/.test(r)) return 'cinema';
  if(/th[eé][aâ]tre|spectacle|com[eé]die|danse|ballet|cirque|stand.up/.test(r)) return 'theatre';
  if(/expo|exposition|galerie|mus[eé]e|vernissage|peinture|sculpture|photo/.test(r)) return 'expo';
  if(/enfant|famille|kid|jeun|b[eé]b[eé]|conte|marionnette/.test(r)) return 'enfants';
  if(/portes.ouvertes|porte.ouverte|journée.portes|visite.domaine|visite.cave/.test(r)) return 'portes-ouvertes';
  if(/d[eé]gustation|vin\b|vins\b|cave|vignoble|terroir|gastronomie|fromage/.test(r)) return 'degustation';
  if(/brocante|vide.grenier|vide grenier|puces|braderie|antiquit/.test(r)) return 'brocante';
  if(/march[eé]/.test(r)) return 'marche';
  if(/sport|foot|basket|tennis|course|marathon|yoga|natation|rugby|v[eé]lo|cyclisme/.test(r)) return 'sport';
  if(/rando|nature|balade|for[eê]t|jardin|[eé]cologie/.test(r)) return 'nature';
  if(/festival|f[eê]te|fete|carnaval|foire\b/.test(r)) return 'fete';
  if(/conf[eé]rence|d[eé]bat|atelier\b|formation|colloque/.test(r)) return 'conference';
  return 'autre';
}
