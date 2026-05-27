// lib/vision.js
// Sends uploaded image/PDF files to Claude Vision (Sonnet 4.6) and returns
// structured event data as JSON.
//
// Usage: const data = await extractFromFiles(anthropicClient, files)
// Returns: { events: [{ title, starts_at, ... }] } or null on failure

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 2048;

// Valid SoirFR categories — must match site filter pills
const CATEGORIES = [
  'musique', 'cinema', 'theatre', 'expo', 'gastronomie', 'degustation',
  'brocante', 'marche', 'enfants', 'sport', 'nature', 'portes-ouvertes',
  'fete', 'patrimoine', 'ateliers'
];

const EXTRACTION_PROMPT = `Tu es un assistant qui extrait des informations d'événements depuis des affiches, flyers, ou programmes culturels français.

Analyse l'image ou le PDF fourni et retourne UNIQUEMENT du JSON valide (aucun texte avant ou après) selon ce schéma exact:

{
  "events": [
    {
      "title": "string ou null",
      "description": "string ou null (1-2 phrases max)",
      "starts_at": "ISO 8601 datetime (YYYY-MM-DDTHH:MM:SS) ou null si inconnu",
      "ends_at": "ISO 8601 datetime ou null",
      "category": "une de ces valeurs UNIQUEMENT: ${CATEGORIES.join(', ')} ou null",
      "venue_name": "nom du lieu (ex. Salle des Fêtes, Théâtre des Copiaus) ou null",
      "address": "adresse complète si visible ou null",
      "postal_code": "code postal 5 chiffres ou null",
      "city": "ville ou null",
      "price_text": "texte tarif tel qu'écrit (ex. '5 €', 'Gratuit', 'à partir de 12 €') ou null",
      "price_min": "nombre ou null",
      "price_max": "nombre ou null",
      "is_free": "true, false, ou null",
      "booking_url": "URL réservation/site si visible ou null",
      "organizer": "organisme ou null"
    }
  ]
}

Règles importantes:
- Si le document contient PLUSIEURS dates ou événements distincts (programme de saison, calendrier mensuel, etc.), retourne UN OBJET par événement dans le tableau "events".
- Si le document contient UN événement unique, retourne un tableau avec UN seul objet.
- "category" doit être EXACTEMENT une des valeurs listées (en minuscules, avec tiret pour portes-ouvertes), sinon null.
- Pour les dates: si "dimanche 7 juin 2026 à 8h", retourne "2026-06-07T08:00:00".
- Pour les randonnées, marches, courses pédestres: catégorie "sport" ou "nature".
- Pour les crêperies, restaurants, gastronomie: catégorie "gastronomie".
- Pour les dégustations de vin/spiritueux: catégorie "degustation".
- Si un champ n'est pas visible ou pas clair, mets null. NE PAS inventer.
- Le titre devrait être concis (max 80 caractères).
- Retourne UNIQUEMENT le JSON, rien d'autre.`;

/**
 * Build a content block for the Anthropic API from a parsed file.
 */
function fileToContentBlock(file) {
  const base64 = file.data.toString('base64');
  const ct = file.contentType.toLowerCase();

  if (ct === 'application/pdf') {
    return {
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: base64
      }
    };
  }

  // HEIC isn't natively supported by Vision yet — skip those
  if (ct.includes('heic') || ct.includes('heif')) {
    return null;
  }

  // Default: treat as image
  // Normalize media type — JPEG variants
  let mediaType = ct;
  if (ct === 'image/jpg') mediaType = 'image/jpeg';
  if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mediaType)) {
    // Unknown image type — try jpeg as fallback
    mediaType = 'image/jpeg';
  }

  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mediaType,
      data: base64
    }
  };
}

/**
 * Extract event data from one or more files using Claude Vision.
 *
 * @param {Anthropic} anthropic - Initialized Anthropic SDK client
 * @param {Array} files - Array of {filename, contentType, data, size} from multipart parser
 * @returns {Promise<{events: Array} | null>}
 */
export async function extractFromFiles(anthropic, files) {
  if (!files || !files.length) return null;

  // Build content blocks: each file + the extraction prompt at the end
  const contentBlocks = [];
  for (const f of files) {
    const block = fileToContentBlock(f);
    if (block) contentBlocks.push(block);
  }

  if (!contentBlocks.length) {
    console.warn('No usable file blocks (all unsupported formats)');
    return null;
  }

  contentBlocks.push({
    type: 'text',
    text: EXTRACTION_PROMPT
  });

  // Call Claude
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [
      {
        role: 'user',
        content: contentBlocks
      }
    ]
  });

  // Extract text from response
  const textBlock = response.content?.find(b => b.type === 'text');
  if (!textBlock?.text) {
    console.warn('Vision returned no text content');
    return null;
  }

  // Parse JSON (strip any markdown fences or stray text)
  let parsed;
  try {
    const cleaned = textBlock.text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    console.error('Failed to parse Vision JSON:', e.message);
    console.error('Raw text:', textBlock.text.substring(0, 500));
    return null;
  }

  // Validate structure
  if (!parsed || !Array.isArray(parsed.events)) {
    console.warn('Vision JSON missing events array');
    return null;
  }

  // Sanitize each event
  parsed.events = parsed.events.map(ev => sanitizeEvent(ev));

  return parsed;
}

/**
 * Validate and clean a single event object from Vision.
 */
function sanitizeEvent(ev) {
  if (!ev || typeof ev !== 'object') return {};

  const clean = {};
  const strFields = ['title', 'description', 'venue_name', 'address',
                     'postal_code', 'city', 'price_text', 'booking_url',
                     'organizer', 'starts_at', 'ends_at'];
  for (const f of strFields) {
    if (typeof ev[f] === 'string' && ev[f].trim() && ev[f].toLowerCase() !== 'null') {
      clean[f] = ev[f].trim();
    } else {
      clean[f] = null;
    }
  }

  // Category — must be in our enum
  if (typeof ev.category === 'string' && CATEGORIES.includes(ev.category.toLowerCase())) {
    clean.category = ev.category.toLowerCase();
  } else {
    clean.category = null;
  }

  // Numeric fields
  clean.price_min = typeof ev.price_min === 'number' ? ev.price_min : null;
  clean.price_max = typeof ev.price_max === 'number' ? ev.price_max : null;
  clean.is_free = typeof ev.is_free === 'boolean' ? ev.is_free : null;

  // Title length cap
  if (clean.title && clean.title.length > 200) {
    clean.title = clean.title.substring(0, 197) + '...';
  }

  return clean;
}
