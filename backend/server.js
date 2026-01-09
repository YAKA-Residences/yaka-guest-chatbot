// backend/server.js
require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { google } = require('googleapis');
const axios = require('axios');
const multer = require('multer');
const FormData = require('form-data');

const upload = multer({ storage: multer.memoryStorage() });

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// ---- Config ----
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EMB_MODEL = process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small';
const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini';
const EMB_THRESHOLD = parseFloat(process.env.EMB_THRESHOLD || '0.72');

const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const PLACES_RADIUS_METERS = parseInt(process.env.PLACES_RADIUS_METERS || '2000', 10);
const PLACES_MAX_RESULTS = parseInt(process.env.PLACES_MAX_RESULTS || '5', 10);

const TTS_MODEL = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
const TTS_VOICE = process.env.OPENAI_TTS_VOICE || 'alloy';
const STT_MODEL = process.env.OPENAI_STT_MODEL || 'gpt-4o-mini-transcribe';

if (!OPENAI_API_KEY) {
  console.error('Warning: Missing OPENAI_API_KEY in .env - embeddings, chat, STT and TTS will fail.');
}
if (!GOOGLE_PLACES_API_KEY) {
  console.error('Warning: Missing GOOGLE_PLACES_API_KEY in .env - nearby places will fail.');
}

// ---- Google Sheets loader ----
let FAQ_DATA = {};     // { apt_id: [ {question, answer, visibility, _embedding}, ... ] }
let GLOBAL_FAQS = [];  // apt_id === 'ALL'
let APARTMENTS = [];   // rows from Apartments sheet
let LOCAL_GUIDE = [];  // rows from LocalGuide sheet

function valuesToObjects(values) {
  if (!values || values.length === 0) return [];
  const headers = values[0].map(h => (h || '').toString().trim());
  const rows = values.slice(1);
  return rows.map(row => {
    const obj = {};
    for (let i = 0; i < headers.length; i++) {
      obj[headers[i]] = row[i] !== undefined ? row[i] : '';
    }
    return obj;
  });
}

async function readSheetByTitleUsingGoogleApi(title, sheetsApi, spreadsheetId) {
  const range = `${title}!A:Z`;
  try {
    const resp = await sheetsApi.spreadsheets.values.get({ spreadsheetId, range });
    return valuesToObjects(resp.data.values || []);
  } catch (err) {
    console.warn(`Could not read sheet "${title}":`, err?.message || err);
    return [];
  }
}

async function loadAllData() {
  try {
    const jwt = new google.auth.JWT(
      process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      null,
      (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').replace(/\\n/g, '\n'),
      ['https://www.googleapis.com/auth/spreadsheets.readonly']
    );
    await jwt.authorize();

    const sheetsApi = google.sheets({ version: 'v4', auth: jwt });
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID;

    const [localGuideRows, apartmentsRows, faqsRows] = await Promise.all([
      readSheetByTitleUsingGoogleApi('LocalGuide', sheetsApi, spreadsheetId),
      readSheetByTitleUsingGoogleApi('Apartments', sheetsApi, spreadsheetId),
      readSheetByTitleUsingGoogleApi('FAQs', sheetsApi, spreadsheetId),
    ]);

    // Build FAQ map keyed by apt_id
    const faqMap = {};
    faqsRows.forEach(r => {
      const apt = ((r.apt_id || '') + '').toString().trim();
      if (!apt) return;
      if (!faqMap[apt]) faqMap[apt] = [];
      faqMap[apt].push({
        question: r.question || '',
        answer: r.answer || '',
        visibility: r.visibility || '',
        _embedding: null
      });
    });

    // Global FAQs where apt_id === 'ALL'
    const globalFaqs = faqsRows
      .filter(r => ((r.apt_id || '') + '').toString().trim().toUpperCase() === 'ALL')
      .map(r => ({
        question: r.question || '',
        answer: r.answer || '',
        visibility: r.visibility || '',
        _embedding: null
      }));

    FAQ_DATA = faqMap;
    GLOBAL_FAQS = globalFaqs;
    APARTMENTS = apartmentsRows;
    LOCAL_GUIDE = localGuideRows;

    console.log('Loaded Apartments:', APARTMENTS.length, 'rows');
    console.log('Loaded LocalGuide:', LOCAL_GUIDE.length, 'rows');
    console.log('Loaded FAQs (per apt):', Object.keys(FAQ_DATA).length, 'apartments with FAQs');
    console.log('Loaded Global FAQs:', GLOBAL_FAQS.length);
  } catch (err) {
    console.error('Error loading Google Sheets:', err?.message || err);
  }
}

// initial load
loadAllData();

// -------------------------------
// Apartment helpers
// -------------------------------
function getApartmentById(aptId) {
  const id = (aptId || '').trim();
  return APARTMENTS.find(a => ((a.apt_id || '') + '').trim() === id) || null;
}

// -------------------------------
// LocalGuide: named place + directions handling (NEW)
// -------------------------------
function norm(s) {
  return (s || '')
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isDirectionsQuestion(message) {
  const s = norm(message);
  return (
    s.includes('how do i get') ||
    s.includes('how to get') ||
    s.includes('directions') ||
    s.includes('route to') ||
    s.includes('get to ') ||
    s.includes('go to ') ||
    s.includes('how can i get') ||
    s.includes('how can i go') ||
    s.includes('how do we get') ||
    s.includes('how do we go') ||
    s.includes('way to ')
  );
}

// Finds best matching LocalGuide row for this apt (or ALL) by place NAME
function findLocalGuidePlace(aptId, message) {
  const msg = norm(message);
  const apt = (aptId || '').trim();

  const candidates = (LOCAL_GUIDE || []).filter(r => {
    const rid = ((r.apt_id || '') + '').trim();
    return rid === apt || rid.toUpperCase() === 'ALL';
  });

  const scored = candidates
    .map(r => {
      const name = (r.name || '').toString().trim();
      const n = norm(name);
      if (!n) return null;

      let score = 0;

      // strong match if full name is in the message
      if (msg.includes(n)) score = 100 + n.length;

      // token overlap boost
      const tokens = msg.split(' ').filter(t => t.length >= 3);
      const hits = tokens.filter(t => n.includes(t)).length;
      score += hits * 5;

      // slight boost if asking directions
      if (isDirectionsQuestion(message)) score += 10;

      return { row: r, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  // Prevent accidental matches
  if (scored.length && scored[0].score >= 30) return scored[0].row;
  return null;
}

function formatLocalGuideReply(placeRow, message) {
  const name = (placeRow.name || '').toString().trim();
  const distance = (placeRow.distance || '').toString().trim();
  const desc = (placeRow.description || '').toString().trim();
  const link = (placeRow.maps_link || '').toString().trim();

  const wantDirections = isDirectionsQuestion(message);

  if (wantDirections) {
    let out = `To get to ${name}`;
    if (distance) out += ` (about ${distance} away)`;
    out += `, open Google Maps and follow the route:\n${link || '(map link not available)'}`;
    if (desc) out += `\n\nTip: ${desc}`;
    return out.trim();
  }

  let out = `${name}`;
  if (distance) out += ` — about ${distance} away.`;
  if (desc) out += `\n${desc}`;
  if (link) out += `\n\nGoogle Maps:\n${link}`;
  return out.trim();
}

// -------------------------------
// LocalGuide: "nearest <category>" handling (NEW)
// Uses LocalGuide columns: apt_id, category, name, distance, description, maps_link
// -------------------------------
function normaliseCategory(s) {
  return (s || '').toString().trim().toLowerCase();
}

function distanceToMetres(distanceStr) {
  const s = (distanceStr || '').toString().trim().toLowerCase();
  if (!s) return Number.POSITIVE_INFINITY;

  // kilometres e.g. "0.5 km"
  const km = s.match(/([\d.]+)\s*km/);
  if (km) return parseFloat(km[1]) * 1000;

  // metres e.g. "500 m" or "500m"
  const m = s.match(/([\d.]+)\s*m\b/);
  if (m) return parseFloat(m[1]);

  // minutes e.g. "2 mins"
  const mins = s.match(/([\d.]+)\s*(min|mins|minute|minutes)\b/);
  if (mins) return parseFloat(mins[1]) * 80; // simple heuristic

  // fallback: first number => metres
  const num = s.match(/([\d.]+)/);
  if (num) return parseFloat(num[1]);

  return Number.POSITIVE_INFINITY;
}

function getLocalGuideRowsForApt(aptId) {
  const id = (aptId || '').trim();
  return (LOCAL_GUIDE || []).filter(r => ((r.apt_id || '') + '').trim() === id);
}

// Detect "nearest/closest <category>" intent from message
function detectNearestCategoryIntent(message) {
  const s = norm(message);

  // supermarkets
  if (
    s.includes('nearest supermarket') ||
    s.includes('closest supermarket') ||
    s.includes('nearest grocery') ||
    s.includes('closest grocery') ||
    s.includes('nearest groceries') ||
    s.includes('nearest grocery store') ||
    s.includes('closest grocery store') ||
    s.includes('where is the nearest supermarket') ||
    s.includes('where is nearest supermarket')
  ) {
    return { category: 'supermarket', label: 'supermarket' };
  }

  // atms
  if (
    s.includes('nearest atm') ||
    s.includes('closest atm') ||
    s.includes('nearest cash machine') ||
    s.includes('closest cash machine') ||
    s.includes('where is the nearest atm') ||
    s.includes('where is nearest atm')
  ) {
    return { category: 'atm', label: 'ATM' };
  }

  // pharmacies
  if (
    s.includes('nearest pharmacy') ||
    s.includes('closest pharmacy') ||
    s.includes('nearest chemist') ||
    s.includes('closest chemist') ||
    s.includes('where is the nearest pharmacy') ||
    s.includes('where is nearest pharmacy')
  ) {
    return { category: 'pharmacy', label: 'pharmacy' };
  }

  // cafes
  if (
    s.includes('nearest cafe') ||
    s.includes('closest cafe') ||
    s.includes('nearest coffee') ||
    s.includes('closest coffee')
  ) {
    return { category: 'cafe', label: 'café' };
  }

  // restaurants
  if (
    s.includes('nearest restaurant') ||
    s.includes('closest restaurant') ||
    s.includes('where can i eat nearby') ||
    s.includes('eat nearby')
  ) {
    return { category: 'restaurant', label: 'restaurant' };
  }

  // attractions
  if (
    s.includes('nearest attraction') ||
    s.includes('closest attraction') ||
    s.includes('things to do nearby') ||
    s.includes('nearby attractions')
  ) {
    return { category: 'attraction', label: 'attraction' };
  }

  return null;
}

function getNearestFromLocalGuide(aptId, category) {
  const rows = getLocalGuideRowsForApt(aptId)
    .filter(r => normaliseCategory(r.category) === normaliseCategory(category));

  if (!rows.length) return null;

  rows.sort((a, b) => distanceToMetres(a.distance) - distanceToMetres(b.distance));
  return rows[0];
}

function formatLocalGuideNearestReply(row, label) {
  if (!row) return null;

  const name = (row.name || '').toString().trim() || 'Unknown place';
  const dist = (row.distance || '').toString().trim();
  const desc = (row.description || '').toString().trim();
  const link = (row.maps_link || '').toString().trim();

  let out = `Nearest ${label}: ${name}`;
  if (dist) out += ` (${dist} away).`;
  else out += '.';

  if (desc) out += `\n\nDirections: ${desc}`;
  if (link) out += `\n\nGoogle Maps:\n${link}`;

  return out.trim();
}

// -------------------------------
// Nearby intent (UPDATED to avoid hijacking "How do I get to SPAR")
// -------------------------------
function detectNearbyIntent(message) {
  const s = (message || '').toLowerCase();

  // If asking directions, likely a specific place -> not a generic "nearby places" query
  if (isDirectionsQuestion(message)) return null;

  // If message contains a known LocalGuide place name, don't route to Google Places
  const msgN = norm(message);
  const hasNamedPlace = (LOCAL_GUIDE || []).some(r => {
    const n = norm(r.name || '');
    return n && msgN.includes(n);
  });
  if (hasNamedPlace) return null;

  if (s.includes('restaurant') || s.includes('eat') || s.includes('dinner') || s.includes('lunch') || s.includes('breakfast')) {
    return { type: 'restaurant', label: 'restaurants' };
  }
  if (s.includes('cafe') || s.includes('coffee')) {
    return { type: 'cafe', label: 'cafés' };
  }
  if (s.includes('atm') || s.includes('cash')) {
    return { type: 'atm', label: 'ATMs' };
  }
  if (s.includes('pharmacy') || s.includes('chemist') || s.includes('medicine')) {
    return { type: 'pharmacy', label: 'pharmacies' };
  }
  if (s.includes('supermarket') || s.includes('grocery') || s.includes('groceries')) {
    return { type: 'supermarket', label: 'supermarkets' };
  }
  if (s.includes('attraction') || s.includes('things to do') || s.includes('tourist') || s.includes('visit')) {
    // legacy endpoint supports tourist_attraction
    return { type: 'tourist_attraction', label: 'attractions' };
  }
  return null;
}

// -------------------------------
// OpenAI REST helpers
// -------------------------------
async function getEmbedding(text) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');

  const resp = await axios.post(
    'https://api.openai.com/v1/embeddings',
    { model: EMB_MODEL, input: text },
    {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 20000
    }
  );

  return resp.data.data[0].embedding;
}

async function openaiChatCompletion(messages, model = CHAT_MODEL, options = {}) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set for chat completion');

  const body = {
    model,
    messages,
    temperature: options.temperature ?? 0.0,
    max_tokens: options.max_tokens ?? 200,
    top_p: options.top_p ?? 1.0,
  };

  const resp = await axios.post('https://api.openai.com/v1/chat/completions', body, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 20000
  });

  return resp.data;
}

// -------------------------------
// Language detection & translation
// -------------------------------
async function detectLanguage(text) {
  const system = "You are a language detection assistant. Respond with the ISO 639-1 language code only (e.g. 'en', 'de', 'fr', 'si', 'es').";
  const user = `Detect the language of the following text and return only the ISO-639-1 code:\n\n${text}`;

  try {
    const data = await openaiChatCompletion(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      CHAT_MODEL,
      { temperature: 0.0, max_tokens: 8 }
    );

    const code = data?.choices?.[0]?.message?.content?.trim()?.toLowerCase() || '';
    const token = (code.split(/[^a-z]/i)[0] || '').toLowerCase();
    return token || 'en';
  } catch (e) {
    console.warn('Language detection failed, defaulting to en:', e?.message || e);
    return 'en';
  }
}

async function translateText(text, targetLang) {
  if (!text) return text;
  if (!targetLang) return text;
  if (targetLang.toLowerCase() === 'en') return text;

  const system = `You are a translation assistant. Translate the user's text into ${targetLang} (ISO 639-1: ${targetLang}). Preserve meaning and tone. Respond with the translation only.`;
  const user = `Translate this to ${targetLang}:\n\n${text}`;

  try {
    const data = await openaiChatCompletion(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      CHAT_MODEL,
      { temperature: 0.0, max_tokens: 350 }
    );
    return data?.choices?.[0]?.message?.content?.trim() || text;
  } catch (e) {
    console.warn('Translation failed, returning original text:', e?.message || e);
    return text;
  }
}

// -------------------------------
// Embedding match + LLM fallback
// -------------------------------
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12);
}

async function findBestMatches(aptData, userMessage, topK = 5) {
  const combined = [...(aptData || []), ...GLOBAL_FAQS];
  if (!combined || combined.length === 0) return { topMatches: [] };

  const userEmb = await getEmbedding(userMessage);

  for (const f of combined) {
    if (!f._embedding) {
      try {
        f._embedding = await getEmbedding(f.question || '');
      } catch {
        f._embedding = null;
      }
    }
  }

  const scored = [];
  for (const f of combined) {
    if (!f._embedding) continue;
    const score = cosineSimilarity(userEmb, f._embedding);
    scored.push({ question: f.question || '', answer: f.answer || '', visibility: f.visibility || '', _score: score });
  }

  scored.sort((a, b) => b._score - a._score);
  return { topMatches: scored.slice(0, topK) };
}

async function callLLMFallback(userMessage, topMatches, userLang = 'en') {
  const systemPrompt = `
You are a helpful concierge assistant for a short-term rental apartment.
Use the provided FAQ items to answer the guest's question.
Answer in the language specified (ISO-639-1): ${userLang}.
Be concise (no more than 120 words).
Do not invent facts not supported by the provided FAQs.
If the answer is not present, politely suggest contacting the host.
`.trim();

  const faqContext = (topMatches || []).slice(0, 3)
    .map((m, idx) => `FAQ ${idx + 1}\nQ: ${m.question}\nA: ${m.answer}`)
    .join('\n\n') || '(none)';

  const userPrompt = `Guest question: "${userMessage}"\n\nRelevant FAQs:\n${faqContext}\n\nAnswer:`;

  try {
    const data = await openaiChatCompletion(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      CHAT_MODEL,
      { temperature: 0.2, max_tokens: 300 }
    );
    const text = data?.choices?.[0]?.message?.content;
    return text ? text.trim() : null;
  } catch (err) {
    console.error('LLM fallback error:', err?.response?.data || err.message || err);
    return null;
  }
}

// -------------------------------
// Google Places (LEGACY) + cache
// -------------------------------
const placesCache = new Map();
function cacheGet(key) {
  const v = placesCache.get(key);
  if (!v) return null;
  if (Date.now() > v.expiresAt) { placesCache.delete(key); return null; }
  return v.data;
}
function cacheSet(key, data, ttlMs) {
  placesCache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

async function getNearbyPlaces({ lat, lng, type, radius }) {
  if (!GOOGLE_PLACES_API_KEY) throw new Error('Missing GOOGLE_PLACES_API_KEY');

  const cacheKey = `${lat},${lng}|${type}|${radius}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const url = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json';
  const params = {
    location: `${lat},${lng}`,
    radius,
    type,
    key: GOOGLE_PLACES_API_KEY
  };

  const resp = await axios.get(url, { params, timeout: 20000 });

  if (resp.data.status !== 'OK' && resp.data.status !== 'ZERO_RESULTS') {
    throw new Error(`Places error: ${resp.data.status} ${resp.data.error_message || ''}`);
  }

  const results = resp.data.results || [];
  cacheSet(cacheKey, results, 24 * 60 * 60 * 1000); // 24h
  return results;
}

function formatPlacesReply(label, places) {
  if (!places || places.length === 0) return null;

  const lines = places.slice(0, PLACES_MAX_RESULTS).map((p, i) => {
    const name = p.name || 'Unknown';
    const addr = p.vicinity || p.formatted_address || '';
    const rating = p.rating ? `⭐ ${p.rating}` : '';
    const maps = p.place_id ? `\nhttps://www.google.com/maps/place/?q=place_id:${p.place_id}` : '';
    return `${i + 1}. ${name}${rating ? ` — ${rating}` : ''}\n${addr}${maps}`;
  });

  return `Here are some nearby ${label}:\n\n${lines.join('\n\n')}`;
}

// -------------------------------
// Routes
// -------------------------------
app.get('/', (req, res) => res.send('Yaka chatbot backend is running!'));

app.get('/debug/faq-data', (req, res) => {
  res.json({
    apartmentsCount: APARTMENTS.length,
    localGuideCount: LOCAL_GUIDE.length,
    faqApartments: Object.keys(FAQ_DATA),
    globalFaqCount: GLOBAL_FAQS.length
  });
});

app.post('/api/chat', async (req, res) => {
  try {
    const { apt, message } = req.body;
    if (!apt || !message) return res.status(400).json({ error: "Missing 'apt' or 'message' in request body" });

    const userLang = await detectLanguage(message);

    // ----------------------------------------------------
    // NEW: "nearest <category>" should use LocalGuide FIRST
    // Example: "where is the nearest supermarket?"
    // Falls back to Google Places only if LocalGuide has no match.
    // ----------------------------------------------------
    const nearestIntent = detectNearestCategoryIntent(message);
    if (nearestIntent) {
      const nearestRow = getNearestFromLocalGuide(apt, nearestIntent.category);

      if (nearestRow) {
        let replyText = formatLocalGuideNearestReply(nearestRow, nearestIntent.label);
        if (userLang !== 'en') replyText = await translateText(replyText, userLang);

        return res.json({
          reply: replyText,
          source: 'local_guide_nearest',
          detected_language: userLang,
          place: {
            category: nearestRow.category || '',
            name: nearestRow.name || '',
            distance: nearestRow.distance || '',
            maps_link: nearestRow.maps_link || ''
          }
        });
      }
      // if no LocalGuide entry exists for that category, continue (Google Places may answer)
    }

    // ----------------------------------------------------
    // If message references a named LocalGuide place
    // (e.g. "SPAR"), answer using LocalGuide FIRST.
    // ----------------------------------------------------
    const matchedPlace = findLocalGuidePlace(apt, message);
    if (matchedPlace) {
      let replyText = formatLocalGuideReply(matchedPlace, message);
      if (userLang !== 'en') replyText = await translateText(replyText, userLang);

      return res.json({
        reply: replyText,
        source: 'local_guide',
        detected_language: userLang,
        place: {
          name: matchedPlace.name || '',
          distance: matchedPlace.distance || '',
          maps_link: matchedPlace.maps_link || ''
        }
      });
    }

    // Nearby places via Google Places (legacy) - ONLY generic nearby queries
    const intent = detectNearbyIntent(message);
    if (intent) {
      const aptRow = getApartmentById(apt);
      const lat = aptRow?.lat;
      const lng = aptRow?.lng;

      if (!lat || !lng) {
        let replyText = "This apartment doesn't have a location configured yet, so I can't look up nearby places. Please ask the host to add it.";
        if (userLang !== 'en') replyText = await translateText(replyText, userLang);
        return res.json({ reply: replyText, source: 'places_missing_latlng', detected_language: userLang });
      }

      try {
        const places = await getNearbyPlaces({
          lat,
          lng,
          type: intent.type,
          radius: PLACES_RADIUS_METERS
        });

        let replyText = formatPlacesReply(intent.label, places) || `I couldn't find nearby ${intent.label} right now.`;
        if (userLang !== 'en') replyText = await translateText(replyText, userLang);

        return res.json({ reply: replyText, source: 'google_places_legacy', detected_language: userLang });
      } catch (e) {
        console.error('Places lookup failed:', e?.message || e);
        let replyText = "Sorry — I couldn't fetch nearby places right now. Please try again later.";
        if (userLang !== 'en') replyText = await translateText(replyText, userLang);
        return res.json({ reply: replyText, source: 'google_places_error', detected_language: userLang });
      }
    }

    // Embedding FAQ match
    const { topMatches } = await findBestMatches(FAQ_DATA[apt] || [], message, 5);
    const best = topMatches[0] || null;
    const bestScore = best ? best._score : 0;

    if (best && bestScore >= EMB_THRESHOLD) {
      let answerText = best.answer || '';
      if (userLang !== 'en') answerText = await translateText(answerText, userLang);

      return res.json({
        reply: answerText,
        source: 'faq',
        score: bestScore,
        matches: topMatches.slice(0, 3),
        detected_language: userLang
      });
    }

    // LLM fallback
    const llmReply = await callLLMFallback(message, topMatches, userLang);
    if (llmReply) {
      return res.json({
        reply: llmReply,
        source: 'llm_fallback',
        score: bestScore,
        matches: topMatches.slice(0, 3),
        detected_language: userLang
      });
    }

    // Final fallback
    let finalText = "I don't have a specific answer for that. Would you like me to notify the host?";
    if (userLang !== 'en') finalText = await translateText(finalText, userLang);

    return res.json({
      reply: finalText,
      source: 'fallback',
      score: bestScore,
      matches: topMatches.slice(0, 3),
      detected_language: userLang
    });
  } catch (err) {
    console.error('Chat error:', err?.message || err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// -------------------------------
// Text-to-speech (TTS)
// -------------------------------
app.post('/api/tts', async (req, res) => {
  try {
    const { text, voice } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: "Missing 'text' in request body" });
    if (!OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not set' });

    const chosenVoice = voice || TTS_VOICE;

    const resp = await axios.post(
      'https://api.openai.com/v1/audio/speech',
      { model: TTS_MODEL, voice: chosenVoice, input: text, format: 'mp3' },
      {
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        responseType: 'arraybuffer',
        timeout: 30000
      }
    );

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(Buffer.from(resp.data));
  } catch (err) {
    console.error('TTS error:', err?.response?.data || err.message || err);
    return res.status(500).json({ error: 'TTS failed' });
  }
});

// -------------------------------
// Speech-to-text (STT)
// -------------------------------
app.post('/api/stt', upload.single('audio'), async (req, res) => {
  try {
    if (!OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not set' });
    if (!req.file) return res.status(400).json({ error: "Missing 'audio' file" });

    const form = new FormData();
    form.append('model', STT_MODEL);
    form.append('file', req.file.buffer, {
      filename: 'audio.webm',
      contentType: req.file.mimetype || 'audio/webm'
    });

    const resp = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, ...form.getHeaders() },
      timeout: 60000
    });

    return res.json({ text: resp.data.text || '' });
  } catch (err) {
    console.error('STT error:', err?.response?.data || err.message || err);
    return res.status(500).json({ error: 'STT failed' });
  }
});

// -------------------------------
// Admin: reload sheets (protected)
// -------------------------------
app.post('/admin/reload-sheets', async (req, res) => {
  const secret = process.env.ADMIN_RELOAD_SECRET;
  const provided = req.headers['x-admin-secret'] || req.body?.admin_secret;

  if (!secret) {
    return res.status(500).json({ error: 'Server not configured with ADMIN_RELOAD_SECRET. Set it in .env.' });
  }
  if (!provided || provided !== secret) {
    return res.status(401).json({ error: 'Unauthorized: invalid admin secret' });
  }

  try {
    await loadAllData();
    return res.json({
      ok: true,
      message: 'Sheets reloaded',
      apartments: APARTMENTS.length,
      localGuide: LOCAL_GUIDE.length,
      faqApartments: Object.keys(FAQ_DATA).length,
      globalFaqCount: GLOBAL_FAQS.length
    });
  } catch (err) {
    console.error('Admin reload error:', err?.message || err);
    return res.status(500).json({ error: 'Failed to reload sheets', details: err?.message || String(err) });
  }
});

app.listen(port, () => console.log(`Server listening on port ${port}`));
