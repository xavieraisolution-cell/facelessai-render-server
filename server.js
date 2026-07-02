const express = require('express');
const { execSync, exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { gerarMontagem } = require('./render_montage');

const app = express();
app.use(express.json({ limit: '50mb' }));

// ── Edge TTS Setup (roda uma vez no boot) ─────────────────────
try {
  execSync('edge-tts --version', { stdio: 'ignore' });
  console.log('[Boot] edge-tts já instalado.');
} catch {
  console.log('[Boot] Instalando edge-tts...');
  execSync('pip install edge-tts --break-system-packages --quiet', { stdio: 'inherit' });
  console.log('[Boot] edge-tts instalado com sucesso.');
}

// ── CREDENCIAIS — todas via process.env, sem fallback literal ──
const AUTH_KEY        = process.env.AUTH_KEY;
const R2_ACCOUNT_ID   = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY   = process.env.R2_ACCESS_KEY;
const R2_SECRET_KEY   = process.env.R2_SECRET_KEY;
const R2_BUCKET       = process.env.R2_BUCKET       || 'facelessai-videos';
const R2_PUBLIC_URL   = process.env.R2_PUBLIC_URL   || 'https://pub-5a163e6e865546d38356eb3df280caaa.r2.dev';
const SUPABASE_URL    = process.env.SUPABASE_URL    || 'https://fnzzqfffzvlffgilfpoz.supabase.co';
const SUPABASE_KEY    = process.env.SUPABASE_KEY;

const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ELEVENLABS_KEY   = process.env.ELEVENLABS_KEY;
const OPENAI_API_KEY   = process.env.OPENAI_API_KEY;
const RAUNAK_M_VOICE_ID = process.env.RAUNAK_M_VOICE_ID || 'oHxj8sUpVpscBK7Mmroq';

const REQUIRED_ENV = ['AUTH_KEY', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY', 'R2_SECRET_KEY', 'SUPABASE_KEY'];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length > 0) {
  console.error(`[BOOT] Faltam variáveis de ambiente obrigatórias: ${missingEnv.join(', ')}`);
  process.exit(1);
}

const jobs       = {};
const tiktokJobs = {};

// ── Helpers ────────────────────────────────────────────────────
function cleanVal(val) {
  return (val || '').toString().replace(/^=/, '').trim();
}

function sanitizeTitle(title) {
  return (title || 'FacelessAI')
    .normalize('NFC')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035']/g, '')
    .replace(/[?]/g, '')
    .trim();
}

function safeFfmpegText(text, maxLen = 40) {
  return cleanVal(text)
    .replace(/'/g, '')
    .replace(/[\\:]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .substring(0, maxLen)
    .trim();
}

function wrapText(text, maxChars = 20) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    if ((current + ' ' + word).trim().length > maxChars) {
      if (current.trim()) lines.push(current.trim());
      current = word;
    } else {
      current = (current + ' ' + word).trim();
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines;
}

// ── Job Queue ──────────────────────────────────────────────────
const jobQueue = [];
let isProcessing = false;

async function enqueueJob(jobId, data) {
  jobQueue.push({ jobId, data });
  console.log(`[Queue] Job ${jobId} adicionado. Fila: ${jobQueue.length} jobs.`);
  if (!isProcessing) processQueue();
}

async function processQueue() {
  if (jobQueue.length === 0) { isProcessing = false; return; }
  isProcessing = true;
  const { jobId, data } = jobQueue.shift();
  console.log(`[Queue] Iniciando job ${jobId} (mode=${data.mode || 'kling'}). Restam ${jobQueue.length} na fila.`);
  try {
    if (data.mode === 'image_montage') await processMontageJob(jobId, data);
    else await processJob(jobId, data);
  }
  catch (e) { console.error(`[Queue] Erro no job ${jobId}:`, e.message); }
  processQueue();
}

// ── Auth ───────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${AUTH_KEY}`) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── Keywords ───────────────────────────────────────────────────
function extractKeywords(title, language = 'en') {
  const stopwordsEN = new Set(['a','an','the','and','or','but','in','on','at','to','for','of','with','by','from','is','was','are','were','be','been','being','have','has','had','do','does','did','will','would','could','should','may','might','what','when','where','who','how','why','which','that','this','these','those','if','then','than','so','yet','both','either','whether','while','into','through','during','before','after','above','below','between','your','my','his','her','its','our','their','you','we','they','he','she','it','i','me','him','us','them','first','last','new','old','just','can','get','got','make','made','take','took','give','gave','come','came','feet','fell','happen','happened','happens','things','thing','about','also','back','even','here','still','such','take','well','much','many','really','very','never','always','every','each','most','more','some','actually','literally','basically','truly','completely','absolutely']);
  const stopwordsPT = new Set(['o','a','os','as','um','uma','uns','umas','e','ou','mas','em','no','na','nos','nas','ao','aos','de','do','da','dos','das','por','para','com','que','se','nao','mais','muito','bem','como','quando','onde','quem','qual','quais','este','esta','estes','estas','esse','essa','isso','aqui','foi','ser','estar','ter','haver','fazer','ir','vir','ver','dar','saber','ja','ainda','tambem','entao','assim','porque','pois','ate','apos','antes','depois','desde','entre','durante','contra','sobre','pelo','pela']);
  const stopwords = language === 'pt' ? stopwordsPT : stopwordsEN;
  const words = title.toLowerCase().replace(/[^a-zA-Z\s]/g, ' ').split(/\s+/).filter(w => w.length > 3 && !stopwords.has(w));
  return words.slice(0, 3).join(' ') || title.split(' ').slice(0, 2).join(' ');
}

// ── Kling JWT ──────────────────────────────────────────────────
function generateKlingJWT(ak, sk) {
  function base64url(obj) {
    return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  }
  const now = Math.floor(Date.now() / 1000);
  const header  = base64url({ alg: 'HS256', typ: 'JWT' });
  const payload = base64url({ iss: ak, exp: now + 1800, nbf: now - 5 });
  const sig = crypto.createHmac('sha256', sk).update(`${header}.${payload}`).digest('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  return `${header}.${payload}.${sig}`;
}

function klingRequest(method, reqPath, token, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.klingai.com', path: reqPath, method,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    };
    if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Pexels Landscape ──────────────────────────────────────────
async function searchPexelsVideos(query, apiKey, count = 5) {
  return new Promise((resolve, reject) => {
    const encodedQuery = encodeURIComponent(query);
    const req = https.request({
      hostname: 'api.pexels.com',
      path: `/videos/search?query=${encodedQuery}&per_page=${count}&orientation=landscape&size=medium`,
      method: 'GET', headers: { 'Authorization': apiKey }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          const urls = [];
          if (data.videos) {
            for (const video of data.videos) {
              const file = video.video_files.filter(f => f.quality === 'hd' || f.quality === 'sd').sort((a,b) => b.width - a.width)[0];
              if (file) urls.push(file.link);
            }
          }
          resolve(urls);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Pexels Portrait ────────────────────────────────────────────
function searchPexelsPortrait(query, apiKey, count = 3) {
  return new Promise((resolve) => {
    const encodedQuery = encodeURIComponent(query);
    const req = https.request({
      hostname: 'api.pexels.com',
      path: `/videos/search?query=${encodedQuery}&per_page=${count}&orientation=portrait&size=medium`,
      method: 'GET', headers: { 'Authorization': apiKey }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          const urls = [];
          if (data.videos) {
            for (const video of data.videos) {
              const file = video.video_files.filter(f => ['hd','sd'].includes(f.quality)).sort((a,b) => b.width - a.width)[0];
              if (file) urls.push(file.link);
            }
          }
          resolve(urls);
        } catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.end();
  });
}

// ── Download ───────────────────────────────────────────────────
function downloadFile(url, dest, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        return downloadFile(response.headers.location, dest, timeoutMs).then(resolve).catch(reject);
      }
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      fs.unlink(dest, () => {});
      reject(new Error(`Download timeout (${timeoutMs}ms) para ${url}`));
    });
  });
}

// ── HTTPS Helper ───────────────────────────────────────────────
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Supabase ───────────────────────────────────────────────────
async function updateSupabase(jobId, data, table = 'facelessai_jobs') {
  try {
    const body = JSON.stringify(data);
    const url = new URL(SUPABASE_URL);
    const result = await httpsRequest({
      hostname: url.hostname,
      path: `/rest/v1/${table}?job_id=eq.${jobId}`,
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY,
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Prefer': 'return=minimal'
      },
    }, body);
    if (result.statusCode >= 300) {
      console.warn(`[${jobId}] Falha Supabase (HTTP ${result.statusCode}, tabela ${table}): ${result.body.toString().substring(0, 400)}`);
    }
  } catch(e) { console.warn(`[${jobId}] Falha Supabase (${table}): ${e.message}`); }
}

async function createSupabaseJob(jobId, data, table = 'facelessai_jobs') {
  try {
    const body = JSON.stringify({ job_id: jobId, status: 'processing', ...data, created_at: new Date().toISOString() });
    const url = new URL(SUPABASE_URL);
    const result = await httpsRequest({
      hostname: url.hostname,
      path: `/rest/v1/${table}`,
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Prefer': 'return=minimal'
      },
    }, body);
    if (result.statusCode >= 300) {
      console.warn(`[${jobId}] Falha ao criar job no Supabase (HTTP ${result.statusCode}, tabela ${table}): ${result.body.toString().substring(0, 400)}`);
    }
  } catch(e) { console.warn(`[${jobId}] Falha ao criar job no Supabase (${table}): ${e.message}`); }
}

// ── R2 Sign ────────────────────────────────────────────────────
function signR2Request(method, key, contentType, bodyBuffer) {
  const now = new Date();
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g,'').slice(0,8);
  const datetime = now.toISOString().replace(/[:-]|\.\d{3}/g,'').slice(0,15) + 'Z';
  const region = 'auto', service = 's3';
  const host = `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const payloadHash = crypto.createHash('sha256').update(bodyBuffer).digest('hex');
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${datetime}\n`;
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [method, `/${R2_BUCKET}/${key}`, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', datetime, credentialScope, crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${R2_SECRET_KEY}`, date), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { host, datetime, payloadHash, authorization, path: `/${R2_BUCKET}/${key}` };
}

async function uploadToR2(filePath, key) {
  const fileBuffer = fs.readFileSync(filePath);
  const contentType = 'video/mp4';
  const { host, datetime, payloadHash, authorization, path: reqPath } = signR2Request('PUT', key, contentType, fileBuffer);
  const result = await httpsRequest({
    hostname: host, path: reqPath, method: 'PUT',
    headers: { 'Content-Type': contentType, 'Content-Length': fileBuffer.length, 'x-amz-date': datetime, 'x-amz-content-sha256': payloadHash, 'Authorization': authorization },
  }, fileBuffer);
  if (result.statusCode !== 200) throw new Error(`R2 upload error ${result.statusCode}: ${result.body.toString()}`);
  return `${R2_PUBLIC_URL}/${key}`;
}

async function uploadToR2Generic(filePath, key, contentType) {
  const fileBuffer = fs.readFileSync(filePath);
  const { host, datetime, payloadHash, authorization, path: reqPath } = signR2Request('PUT', key, contentType, fileBuffer);
  const result = await httpsRequest({
    hostname: host, path: reqPath, method: 'PUT',
    headers: { 'Content-Type': contentType, 'Content-Length': fileBuffer.length, 'x-amz-date': datetime, 'x-amz-content-sha256': payloadHash, 'Authorization': authorization },
  }, fileBuffer);
  if (result.statusCode !== 200) throw new Error(`R2 upload error ${result.statusCode}: ${result.body.toString()}`);
  return `${R2_PUBLIC_URL}/${key}`;
}

// ── TTS Chunks ────────────────────────────────────────────────
function splitIntoChunks(text, maxChars = 4000) {
  const chunks = [];
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  let current = '';
  for (const sentence of sentences) {
    if ((current + sentence).length > maxChars) { if (current.trim()) chunks.push(current.trim()); current = sentence; }
    else { current += sentence; }
  }
  if (current.trim()) chunks.push(current.trim());
  const finalChunks = [];
  for (const chunk of chunks) {
    if (chunk.length <= maxChars) { finalChunks.push(chunk); continue; }
    const words = chunk.split(' '); let part = '';
    for (const word of words) {
      if ((part + ' ' + word).length > maxChars) { if (part.trim()) finalChunks.push(part.trim()); part = word; }
      else { part += ' ' + word; }
    }
    if (part.trim()) finalChunks.push(part.trim());
  }
  return finalChunks;
}

// ── Edge TTS (substitui OpenAI TTS — gratuito, sem API key) ───
// Vozes recomendadas por canal:
//   MisterIA (PT-BR): pt-BR-AntonioNeural (M) ou pt-BR-FranciscaNeural (F)
//   WealthAI (EN):    en-US-GuyNeural (M) ou en-US-AriaNeural (F)
//   HistoryAI (EN):   en-US-GuyNeural (M)
//   ScienceAI (EN):   en-US-GuyNeural (M)
//
// Para usar, altere tts_voice no node "Pexels + Render" do n8n:
//   MisterIA  → pt-BR-AntonioNeural
//   demais    → en-US-GuyNeural
//
// NOTA: openai_api_key ainda é aceito no payload mas NÃO é mais usado para TTS.
// Continua sendo usado apenas para gpt-image-1 (thumbnails TikTok).
async function generateTTSChunk(text, voice, model, apiKey, outputPath) {
  // Salva o texto em arquivo temporário para evitar problemas de escaping
  // com aspas, acentos, caracteres especiais do português e texto longo
  const textFile = outputPath + '.txt';
  fs.writeFileSync(textFile, text, 'utf8');

  // Mapeia vozes legadas para Edge TTS (compatibilidade com payloads antigos)
  const voiceMap = {
    'alloy':   'en-US-GuyNeural',
    'nova':    'en-US-AriaNeural',
    'echo':    'en-US-GuyNeural',
    'fable':   'en-GB-RyanNeural',
    'onyx':    'en-US-ChristopherNeural',
    'shimmer': 'en-US-JennyNeural',
  };
  const edgeVoice = voiceMap[voice] || voice; // se já for nome Edge, usa direto

  try {
    await execAsync(
      `edge-tts --voice "${edgeVoice}" --file "${textFile}" --write-media "${outputPath}"`,
      { timeout: 120000 }
    );
  } finally {
    try { fs.unlinkSync(textFile); } catch {}
  }
}

// ── Telegram ───────────────────────────────────────────────────
function sendTelegram(text, buttons = null) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return Promise.resolve();
  return new Promise((resolve) => {
    const payload = { chat_id: TELEGRAM_CHAT_ID, text: String(text), parse_mode: 'HTML' };
    if (buttons) payload.reply_markup = JSON.stringify({ inline_keyboard: buttons });
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const resp = Buffer.concat(chunks).toString();
        if (!resp.includes('"ok":true')) console.warn('[Telegram] Erro:', resp.substring(0,200));
        resolve();
      });
    });
    req.on('error', (e) => { console.warn('[Telegram] Conexao falhou:', e.message); resolve(); });
    req.write(body);
    req.end();
  });
}

// ── DALL-E ─────────────────────────────────────────────────────
function dalleGenerate(prompt, apiKey, size = '1024x1024', outputPath = null) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'gpt-image-1', prompt, n: 1, size });
    const req = https.request({
      hostname: 'api.openai.com', path: '/v1/images/generations', method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          if (data.error) return reject(new Error('Image API error: ' + data.error.message));
          const b64 = data.data?.[0]?.b64_json;
          if (b64) {
            if (outputPath) {
              require('fs').writeFileSync(outputPath, Buffer.from(b64, 'base64'));
              return resolve(outputPath);
            }
            return resolve('data:image/png;base64,' + b64);
          }
          const url = data.data?.[0]?.url;
          if (url) return resolve(url);
          reject(new Error('Image API no data: ' + JSON.stringify(data).substring(0,200)));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── OpenAI TTS (mantido APENAS para TikTok Shop — não usado no FacelessAI) ──
function openaiTTS(text, apiKey, outputPath, voice = 'nova') {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'tts-1', input: text, voice, response_format: 'mp3' });
    const req = https.request({
      hostname: 'api.openai.com', path: '/v1/audio/speech', method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      if (res.statusCode !== 200) {
        const chunks = []; res.on('data', c => chunks.push(c));
        res.on('end', () => reject(new Error(`TTS ${res.statusCode}: ${Buffer.concat(chunks).toString()}`)));
        return;
      }
      const file = fs.createWriteStream(outputPath);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── ElevenLabs TTS ────────────────────────────────────────────
function elevenLabsTTS(text, apiKey, outputPath, voiceId = '21m00Tcm4TlvDq8ikWAM') {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 } });
    const req = https.request({
      hostname: 'api.elevenlabs.io',
      path: `/v1/text-to-speech/${voiceId}`,
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      if (res.statusCode !== 200) {
        const chunks = []; res.on('data', c => chunks.push(c));
        res.on('end', () => reject(new Error(`ElevenLabs ${res.statusCode}: ${Buffer.concat(chunks).toString()}`)));
        return;
      }
      const file = fs.createWriteStream(outputPath);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── PDF / HTML Generator ───────────────────────────────────────
function generateProductHTML(product, coverImagePath) {
  const coverBase64 = coverImagePath && fs.existsSync(coverImagePath)
    ? `data:image/jpeg;base64,${fs.readFileSync(coverImagePath).toString('base64')}`
    : '';
  const sections = (product.sections || []).map((section, i) => {
    const bullets = (section.bullets || []).map(b => `<li>${b}</li>`).join('');
    const quote   = section.quote ? `<div class="quote">"${section.quote}"</div>` : '';
    return `<div class="page">
      <div class="section-badge">${String(i+1).padStart(2,'0')}</div>
      <h2>${section.title || ''}</h2>
      <hr class="divider">
      ${(section.content || '').split('\n\n').map(p => `<p>${p.trim()}</p>`).join('')}
      ${bullets ? `<div class="bullets"><ul>${bullets}</ul></div>` : ''}
      ${quote}
    </div>`;
  }).join('');
  const checklist = product.checklist ? `<div class="checklist-page">
    <h2>${product.checklist.title || 'Checklist'}</h2>
    <hr class="divider">
    ${(product.checklist.items || []).map(item =>
      `<div class="check-item"><div class="checkbox"></div><span>${item}</span></div>`
    ).join('')}
  </div>` : '';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Arial,Helvetica,sans-serif;color:#1e1e1e}
  .cover{background:linear-gradient(135deg,#2962ff 0%,#1a237e 100%);color:#fff;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px 40px;text-align:center}
  .cover img{max-width:380px;border-radius:16px;margin-bottom:40px;box-shadow:0 24px 64px rgba(0,0,0,.4)}
  .cover h1{font-size:2.8em;font-weight:900;margin-bottom:16px;line-height:1.2}
  .cover .subtitle{font-size:1.2em;opacity:.8;margin-bottom:40px}
  .cover .brand{font-size:.95em;opacity:.55;font-style:italic;margin-top:60px}
  .page{padding:70px 60px;page-break-before:always;max-width:860px;margin:0 auto}
  .section-badge{background:#ff6b35;color:#fff;width:52px;height:52px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:1.3em;float:left;margin-right:20px;margin-top:4px}
  h2{color:#2962ff;font-size:1.75em;padding-top:8px;margin-bottom:20px}
  .divider{border:none;border-top:2px solid #2962ff;margin:20px 0;clear:both}
  p{line-height:1.85;font-size:1.05em;color:#333;margin-bottom:14px}
  .bullets{background:#f0f4ff;border-radius:12px;padding:22px 22px 14px 22px;margin:22px 0}
  .bullets ul{padding-left:20px}
  .bullets li{margin-bottom:10px;font-size:1.02em;line-height:1.6}
  .quote{border-left:4px solid #2962ff;padding:16px 22px;margin:26px 0;font-style:italic;color:#555;background:#f9f9f9;border-radius:0 10px 10px 0;font-size:1.05em}
  .checklist-page{padding:70px 60px;page-break-before:always}
  .checklist-page h2{color:#2962ff;font-size:2em;margin-bottom:20px}
  .check-item{display:flex;align-items:center;margin:16px 0}
  .checkbox{width:24px;height:24px;border:2.5px solid #2962ff;border-radius:5px;margin-right:16px;flex-shrink:0}
  .check-item span{font-size:1.05em;line-height:1.5}
  .cta-page{background:linear-gradient(135deg,#2962ff 0%,#1a237e 100%);color:#fff;min-height:70vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:70px 60px;text-align:center;page-break-before:always}
  .cta-page h2{font-size:2.4em;margin-bottom:20px}
  .cta-page p{font-size:1.2em;opacity:.85;max-width:600px;line-height:1.7;margin-bottom:10px}
  .cta-badge{background:#ff6b35;border-radius:14px;padding:22px 44px;margin-top:36px;font-size:1.15em;font-weight:700;display:inline-block}
  @media print{.page,.checklist-page,.cta-page{page-break-before:always}}
</style></head><body>
<div class="cover">
  ${coverBase64 ? `<img src="${coverBase64}" alt="cover">` : ''}
  <h1>${product.title || 'Digital Product'}</h1>
  <div class="subtitle">${product.subtitle || ''}</div>
  <div class="brand">${product.brand || 'Xavier Digital Products'}</div>
</div>
${sections}
${checklist}
<div class="cta-page">
  <h2>Ready to take action?</h2>
  ${(product.cta_text || '').split('\n').map(l => `<p>${l}</p>`).join('')}
  <div class="cta-badge">${product.shop_url || 'Find us on TikTok Shop'}</div>
</div>
</body></html>`;
}

function generatePDF(product, coverImagePath, outputPath) {
  const html = generateProductHTML(product, coverImagePath);
  const htmlPath = outputPath.replace(/\.pdf$/, '.html');
  fs.writeFileSync(htmlPath, html);
  const cmds = [
    `wkhtmltopdf --page-size A4 --margin-top 0 --margin-bottom 0 --margin-left 0 --margin-right 0 --enable-local-file-access "${htmlPath}" "${outputPath}"`,
    `chromium-browser --headless --no-sandbox --disable-gpu --print-to-pdf="${outputPath}" "file://${htmlPath}"`,
    `google-chrome --headless --no-sandbox --disable-gpu --print-to-pdf="${outputPath}" "file://${htmlPath}"`,
    `chromium --headless --no-sandbox --disable-gpu --print-to-pdf="${outputPath}" "file://${htmlPath}"`
  ];
  for (const cmd of cmds) {
    try {
      execSync(cmd, { timeout: 30000, stdio: 'ignore' });
      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 2000) {
        try { fs.unlinkSync(htmlPath); } catch {}
        return outputPath;
      }
    } catch {}
  }
  return htmlPath;
}

// ── TikTok Product Creator ─────────────────────────────────────
async function createTikTokProduct(jobId, data) {
  const jobDir = `/tmp/tikprod_${jobId}`;
  fs.mkdirSync(jobDir, { recursive: true });
  try {
    tiktokJobs[jobId].status = 'processing';
    const apiKey = OPENAI_API_KEY || data.openai_api_key || '';
    const title  = cleanVal(data.title) || 'Digital Product';

    tiktokJobs[jobId].step = 'generating_cover';
    let coverPath = null;
    if (apiKey) {
      try {
        const prompt = cleanVal(data.cover_prompt) ||
          `Professional digital product cover, title: ${title}, modern minimalist style, vibrant blue gradient, clean layout, no text visible, high quality`;
        coverPath = path.join(jobDir, 'cover.png');
        await dalleGenerate(prompt, apiKey, '1024x1024', coverPath);
        console.log(`[${jobId}] Capa gerada OK`);
      } catch(e) { console.warn(`[${jobId}] Capa falhou: ${e.message}`); }
    }

    tiktokJobs[jobId].step = 'generating_pdf';
    const pdfPath    = path.join(jobDir, 'product.pdf');
    const actualOutput = generatePDF({ ...data, title }, coverPath, pdfPath);
    const isHtml     = actualOutput.endsWith('.html');

    tiktokJobs[jobId].step = 'generating_mockups';
    const mockupUrls = {};
    if (coverPath && fs.existsSync(coverPath)) {
      const flatPath  = path.join(jobDir, 'mockup_flat.jpg');
      const phonePath = path.join(jobDir, 'mockup_phone.jpg');
      try {
        execSync(`ffmpeg -y -f lavfi -i "color=c=0xE8EDFF:size=1080x1080" -i "${coverPath}" -filter_complex "[1]scale=700:700[p];[0][p]overlay=(W-w)/2:(H-h)/2" -frames:v 1 "${flatPath}"`, { timeout: 20000 });
        mockupUrls.flat = await uploadToR2Generic(flatPath, `tiktok/${jobId}/mockup_flat.jpg`, 'image/jpeg');
      } catch(e) { console.warn(`[${jobId}] Mockup flat: ${e.message}`); }
      try {
        execSync(`ffmpeg -y -f lavfi -i "color=c=0x191927:size=1080x1920" -i "${coverPath}" -filter_complex "[1]scale=680:850[p];[0][p]overlay=(W-w)/2:(H-h)/2" -frames:v 1 "${phonePath}"`, { timeout: 20000 });
        mockupUrls.phone = await uploadToR2Generic(phonePath, `tiktok/${jobId}/mockup_phone.jpg`, 'image/jpeg');
      } catch(e) { console.warn(`[${jobId}] Mockup phone: ${e.message}`); }
    }

    tiktokJobs[jobId].step = 'uploading';
    let coverUrl = '', productUrl = '';
    if (coverPath && fs.existsSync(coverPath))
      coverUrl = await uploadToR2Generic(coverPath, `tiktok/${jobId}/cover.jpg`, 'image/jpeg');
    if (fs.existsSync(actualOutput)) {
      const ct  = isHtml ? 'text/html' : 'application/pdf';
      const ext = isHtml ? 'html' : 'pdf';
      productUrl = await uploadToR2Generic(actualOutput, `tiktok/${jobId}/product.${ext}`, ct);
    }

    tiktokJobs[jobId].status      = 'completed';
    tiktokJobs[jobId].step        = 'done';
    tiktokJobs[jobId].pdf_url     = productUrl;
    tiktokJobs[jobId].cover_url   = coverUrl;
    tiktokJobs[jobId].mockup_urls = mockupUrls;

  } catch(error) {
    console.error(`[TikTok Prod ${jobId}]`, error.message);
    tiktokJobs[jobId].status = 'failed';
    tiktokJobs[jobId].error  = error.message;
    await sendTelegram(`❌ <b>Erro ao criar produto</b>\nJob: ${jobId}\n${error.message.substring(0,300)}`);
  } finally {
    try { execSync(`rm -rf "${jobDir}"`); } catch {}
  }
}

// ── TikTok Video Creator ───────────────────────────────────────
async function createTikTokVideo(jobId, data) {
  const jobDir = `/tmp/tiktvid_${jobId}`;
  fs.mkdirSync(jobDir, { recursive: true });
  try {
    tiktokJobs[jobId].status = 'processing';

    const product_title       = cleanVal(data.product_title) || 'Digital Product';
    const hook                = cleanVal(data.hook)          || 'This will change your life';
    const cta                 = cleanVal(data.cta)           || 'Get yours now — link in bio!';
    const narration           = cleanVal(data.narration)     || '';
    const pexels_query        = cleanVal(data.pexels_query)  || 'productivity workspace';
    const angle               = parseInt(data.angle) || 0;
    const elevenlabs_voice_id = data.elevenlabs_voice_id || '21m00Tcm4TlvDq8ikWAM';

    let benefits = [];
    try {
      if (Array.isArray(data.benefits)) benefits = data.benefits;
      else if (data.benefits) benefits = JSON.parse(cleanVal(data.benefits));
    } catch {}

    const apiKey    = OPENAI_API_KEY || data.openai_api_key || '';
    const pexelsKey = data.pexels_api_key || process.env.PEXELS_API_KEY || '';
    const elKey     = ELEVENLABS_KEY || data.elevenlabs_key || '';
    const W = 1080, H = 1920;

    console.log(`[${jobId}] Criando video TikTok: "${product_title}" | angulo ${angle}`);

    // 1. Narração — TikTok Shop continua usando OpenAI TTS ou ElevenLabs (não Edge TTS)
    tiktokJobs[jobId].step = 'generating_audio';
    const audioPath = path.join(jobDir, 'narration.mp3');
    const narText = narration ||
      `${hook}. Introducing ${product_title}. ${benefits.slice(0,3).join('. ')}. ${cta}`;

    if (elKey)       await elevenLabsTTS(narText, elKey, audioPath, elevenlabs_voice_id);
    else if (apiKey) await openaiTTS(narText, apiKey, audioPath);
    else throw new Error('Nenhuma API de TTS configurada');

    let audioDuration = 45;
    try {
      const d = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`, { timeout: 15000 }).toString().trim();
      audioDuration = parseFloat(d) || 45;
    } catch {}

    // 2. Imagens DALL-E
    tiktokJobs[jobId].step = 'generating_images';
    const imagePrompts = [
      `TikTok promotional image 9:16 vertical, vibrant gradient background, modern design, theme: ${product_title}, bold clean space, no text`,
      `Flat lay digital planner ebook on tablet screen, modern workspace top view, clean background, professional photography, no text`,
      `Person working productively on laptop, cozy home office, warm lighting, organized desk, success lifestyle, vertical portrait`,
      `Abstract modern gradient background blue orange, geometric shapes, minimal, 9:16 vertical, no text`
    ];
    const sceneImages = [];
    for (let i = 0; i < imagePrompts.length; i++) {
      if (!apiKey) { console.warn(`[${jobId}] Sem OPENAI_API_KEY — pulando DALL-E`); break; }
      try {
        const imgPath = path.join(jobDir, `scene_${i}.png`);
        await dalleGenerate(imagePrompts[i], apiKey, '1024x1536', imgPath);
        sceneImages.push(imgPath);
      } catch(e) { console.warn(`[${jobId}] Img ${i}: ${e.message}`); }
    }

    // 3. B-roll Pexels
    tiktokJobs[jobId].step = 'fetching_broll';
    let brollPath = null;
    if (pexelsKey && sceneImages.length > 0) {
      try {
        const urls = await searchPexelsPortrait(pexels_query, pexelsKey, 2);
        if (urls.length > 0) {
          brollPath = path.join(jobDir, 'broll.mp4');
          await downloadFile(urls[0], brollPath);
        }
      } catch(e) { console.warn(`[${jobId}] Pexels: ${e.message}`); }
    }

    // 4. Clips
    tiktokJobs[jobId].step = 'creating_clips';
    const lastDur = Math.max(15, audioDuration - 33);
    const sceneDurations = [4, 12, 12, 10, lastDur];
    const sceneFiles     = [...sceneImages];

    const fallbackColors = ['2962ff','ff6b35','1a237e','ff5722'];
    while (sceneFiles.length < 4) {
      const fb = path.join(jobDir, `fb_${sceneFiles.length}.jpg`);
      const c  = fallbackColors[sceneFiles.length % fallbackColors.length];
      try {
        execSync(`ffmpeg -y -f lavfi -i "color=c=0x${c}:size=${W}x${H}:duration=1" -frames:v 1 "${fb}"`, { timeout: 10000 });
        sceneFiles.push(fb);
      } catch { break; }
    }

    const clipPaths = [];
    for (let i = 0; i < Math.min(sceneFiles.length, sceneDurations.length); i++) {
      const clipPath = path.join(jobDir, `clip_${i}.mp4`);
      const dur = sceneDurations[i];
      try {
        execSync(
          `ffmpeg -y -loop 1 -i "${sceneFiles[i]}" ` +
          `-vf "scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1" ` +
          `-t ${dur} -r 30 -c:v libx264 -preset fast -pix_fmt yuv420p "${clipPath}"`,
          { timeout: 90000 }
        );
        clipPaths.push(clipPath);
      } catch(e) { console.warn(`[${jobId}] Clip ${i}: ${e.message}`); }
    }

    if (brollPath && fs.existsSync(brollPath)) {
      const brollNorm = path.join(jobDir, 'broll_norm.mp4');
      try {
        execSync(
          `ffmpeg -y -i "${brollPath}" ` +
          `-vf "scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1" ` +
          `-t 10 -r 30 -c:v libx264 -preset ultrafast -an "${brollNorm}"`,
          { timeout: 120000 }
        );
        clipPaths.splice(3, 0, brollNorm);
      } catch(e) { console.warn(`[${jobId}] B-roll: ${e.message}`); }
    }

    if (clipPaths.length === 0) throw new Error('Nenhum clip gerado');

    // 5. Text overlays
    tiktokJobs[jobId].step = 'adding_overlays';
    const overlayClips = [...clipPaths];

    const addOverlay = (inputPath, outputPath, text, yBase, color) => {
      const safeText = safeFfmpegText(text, 120);
      const lines    = wrapText(safeText, 22);
      const fontfile = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
      const fontSize = 52;
      const lineH    = 65;
      const drawtext = lines.map((line, i) =>
        `drawtext=text='${line}':fontsize=${fontSize}:fontcolor=white:` +
        `x=(w-text_w)/2:y=${yBase}+${i * lineH}:` +
        `fontfile=${fontfile}:box=1:boxcolor=${color}@0.88:boxborderw=15`
      ).join(',');
      execSync(`ffmpeg -y -i "${inputPath}" -vf "${drawtext}" -c:v libx264 -preset fast "${outputPath}"`, { timeout: 60000 });
    };

    if (clipPaths[0] && fs.existsSync(clipPaths[0])) {
      const out = path.join(jobDir, 'hook_ov.mp4');
      try { addOverlay(clipPaths[0], out, hook, 'h*0.40', '0x2962ff'); overlayClips[0] = out; }
      catch(e) { console.warn(`[${jobId}] Hook overlay: ${e.message}`); }
    }
    const last = overlayClips.length - 1;
    if (overlayClips[last] && fs.existsSync(overlayClips[last])) {
      const out = path.join(jobDir, 'cta_ov.mp4');
      try { addOverlay(overlayClips[last], out, cta, 'h*0.38', '0xff6b35'); overlayClips[last] = out; }
      catch(e) { console.warn(`[${jobId}] CTA overlay: ${e.message}`); }
    }

    // 6. Concat + merge
    tiktokJobs[jobId].step = 'rendering';
    const concatTxt = path.join(jobDir, 'concat.txt');
    fs.writeFileSync(concatTxt, overlayClips.filter(p => fs.existsSync(p)).map(p => `file '${p}'`).join('\n'));
    const silentMp4 = path.join(jobDir, 'silent.mp4');
    execSync(`ffmpeg -y -f concat -safe 0 -i "${concatTxt}" -c:v libx264 -preset fast -pix_fmt yuv420p "${silentMp4}"`, { timeout: 300000 });
    const finalMp4 = path.join(jobDir, 'final.mp4');
    execSync(`ffmpeg -y -i "${silentMp4}" -i "${audioPath}" -map 0:v -map 1:a -c:v libx264 -preset fast -pix_fmt yuv420p -c:a aac -b:a 128k -t ${audioDuration} "${finalMp4}"`, { timeout: 180000 });

    // 7. Upload
    tiktokJobs[jobId].step = 'uploading';
    const videoUrl = await uploadToR2Generic(finalMp4, `tiktok/${jobId}/video_${angle}.mp4`, 'video/mp4');

    tiktokJobs[jobId].status    = 'completed';
    tiktokJobs[jobId].step      = 'done';
    tiktokJobs[jobId].video_url = videoUrl;
    console.log(`[${jobId}] Video TikTok concluido: ${videoUrl}`);

  } catch(error) {
    console.error(`[TikTok Vid ${jobId}]`, error.message);
    tiktokJobs[jobId].status = 'failed';
    tiktokJobs[jobId].error  = error.message;
    await sendTelegram(`❌ <b>Erro ao criar video</b>\nJob: ${jobId}\n${error.message.substring(0,200)}`);
  } finally {
    try { execSync(`rm -rf "${jobDir}"`); } catch {}
  }
}

// ── FacelessAI Core Job ────────────────────────────────────────
async function processJob(jobId, data) {
  const jobDir = `/tmp/${jobId}`;
  fs.mkdirSync(jobDir, { recursive: true });
  try {
    jobs[jobId].status = 'processing';
    jobs[jobId].progress = 'Iniciando...';
    const {
      script, video_clips, openai_api_key,
      tts_voice = 'en-US-GuyNeural', // Edge TTS voice — manter compatibilidade com 'alloy' via voiceMap dentro de generateTTSChunk
      tts_model = 'tts-1',           // ignorado pelo Edge TTS, mantido para não quebrar payloads existentes
      audio_url, video_title = 'FacelessAI',
      pexels_api_key, pexels_query,
      source = 'kling', language = 'en-US'
    } = data;
    jobs[jobId].video_title = video_title;

    let finalAudioPath = path.join(jobDir, 'final_audio.mp3');
    if (script) {
      jobs[jobId].progress = 'Gerando audio TTS (Edge TTS)...';
      const chunks = splitIntoChunks(script, 4000);
      const chunkPaths = [];
      for (let i = 0; i < chunks.length; i++) {
        const chunkPath = path.join(jobDir, `chunk_${i}.mp3`);
        jobs[jobId].progress = `TTS chunk ${i+1}/${chunks.length}...`;
        // openai_api_key passado aqui por compatibilidade de assinatura mas não é usado pelo Edge TTS
        await generateTTSChunk(chunks[i], tts_voice, tts_model, openai_api_key, chunkPath);
        chunkPaths.push(chunkPath);
      }
      if (chunkPaths.length === 1) { fs.copyFileSync(chunkPaths[0], finalAudioPath); }
      else {
        const listFile = path.join(jobDir, 'chunks.txt');
        fs.writeFileSync(listFile, chunkPaths.map(p => `file '${p}'`).join('\n'));
        await execAsync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${finalAudioPath}"`, { timeout: 120000 });
      }
    } else if (audio_url) {
      jobs[jobId].progress = 'Baixando audio...';
      await downloadFile(audio_url, finalAudioPath);
    } else { throw new Error('Nenhum script ou audio_url fornecido'); }

    jobs[jobId].progress = 'Calculando duracao...';
    let audioDuration;
    try {
      const { stdout: d } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${finalAudioPath}"`, { timeout: 30000 });
      audioDuration = parseFloat(d.trim());
      if (isNaN(audioDuration) || audioDuration <= 0) throw new Error('Duracao invalida');
    } catch(e) {
      const wavPath = path.join(jobDir, 'audio_check.wav');
      await execAsync(`ffmpeg -y -i "${finalAudioPath}" "${wavPath}"`, { timeout: 60000 });
      const { stdout: d } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${wavPath}"`, { timeout: 30000 });
      audioDuration = parseFloat(d.trim());
      fs.unlinkSync(wavPath);
    }

    let clipUrls = Array.isArray(video_clips) ? [...video_clips] : [];
    if ((source === 'pexels' || clipUrls.length === 0) && pexels_api_key) {
      jobs[jobId].progress = 'Buscando clips no Pexels...';
      const lang = language.startsWith('pt') ? 'pt' : 'en';
      const query = pexels_query || extractKeywords(video_title, lang);
      const pexelsUrls = await searchPexelsVideos(query, pexels_api_key, 5);
      clipUrls = [...clipUrls, ...pexelsUrls];
      if (pexelsUrls.length === 0) {
        const fbQ = lang === 'pt' ? 'natureza cosmos universo' : 'nature cosmos universe';
        const fbUrls = await searchPexelsVideos(fbQ, pexels_api_key, 5);
        clipUrls = [...clipUrls, ...fbUrls];
      }
    }
    if (clipUrls.length === 0) throw new Error('Nenhum clip de video disponivel');

    jobs[jobId].progress = 'Baixando clips...';
    const clipPaths = [];
    for (let i = 0; i < Math.min(clipUrls.length, 5); i++) {
      const clipPath = path.join(jobDir, `clip_${i}.mp4`);
      try { await downloadFile(clipUrls[i], clipPath); clipPaths.push(clipPath); }
      catch(e) { console.warn(`[${jobId}] Falha clip ${i}: ${e.message}`); }
    }
    if (clipPaths.length === 0) throw new Error('Nenhum clip baixado com sucesso');

    jobs[jobId].progress = 'Normalizando clips...';
    const normalizedPaths = [];
    for (let i = 0; i < clipPaths.length; i++) {
      const normPath = path.join(jobDir, `norm_${i}.mp4`);
      await execAsync(`ffmpeg -y -i "${clipPaths[i]}" -vf "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1" -r 30 -an -c:v libx264 -preset ultrafast -crf 28 "${normPath}"`, { timeout: 600000 });
      normalizedPaths.push(normPath);
    }

    jobs[jobId].progress = 'Montando video...';
    const loopListFile = path.join(jobDir, 'loop_list.txt');
    let totalDuration = 0;
    const loopEntries = [];
    while (totalDuration < audioDuration) {
      for (const np of normalizedPaths) {
        if (totalDuration >= audioDuration) break;
        let clipDur = 10;
        try {
          const { stdout: cd } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${np}"`, { timeout: 30000 });
          clipDur = parseFloat(cd.trim()) || 10;
        } catch {}
        loopEntries.push(`file '${np}'`);
        totalDuration += clipDur;
      }
    }
    fs.writeFileSync(loopListFile, loopEntries.join('\n'));
    const loopedVideoPath = path.join(jobDir, 'looped_video.mp4');
    await execAsync(`ffmpeg -y -f concat -safe 0 -i "${loopListFile}" -t ${audioDuration} -c:v libx264 -preset ultrafast -crf 28 "${loopedVideoPath}"`, { timeout: 900000 });

    jobs[jobId].progress = 'Mesclando video e audio...';
    const outputPath = path.join(jobDir, 'output.mp4');
    await execAsync(`ffmpeg -y -i "${loopedVideoPath}" -i "${finalAudioPath}" -map 0:v -map 1:a -c:v copy -c:a aac -shortest "${outputPath}"`, { timeout: 300000 });

    jobs[jobId].progress = 'Enviando para R2...';
    const r2Key     = `${jobId}.mp4`;
    const publicUrl = await uploadToR2(outputPath, r2Key);
    jobs[jobId].status    = 'completed';
    jobs[jobId].progress  = 'Concluido';
    jobs[jobId].video_url = publicUrl;
    jobs[jobId].source    = source;

    await updateSupabase(jobId, { status: 'completed', video_url: publicUrl, video_title: sanitizeTitle(video_title), updated_at: new Date().toISOString() });
  } catch(error) {
    console.error(`[${jobId}] ERRO:`, error.message);
    jobs[jobId].status = 'failed';
    jobs[jobId].error  = error.message;
    await updateSupabase(jobId, { status: 'failed', error: error.message });
  } finally {
    try { await execAsync(`rm -rf "${jobDir}"`); } catch {}
  }
}

// ── Montagem (imagens estáticas + zoom/crossfade) ──────────────
async function processMontageJob(jobId, data) {
  const jobDir = `/tmp/${jobId}`;
  fs.mkdirSync(jobDir, { recursive: true });
  let safeTableName = 'facelessai_jobs';
  try {
    jobs[jobId].status = 'processing';
    jobs[jobId].progress = 'Iniciando montagem...';

    const {
      scenes, video_title = 'FacelessAI', player_name,
      table_name = 'facelessai_jobs',
      openai_api_key, tts_voice = 'en-US-GuyNeural', tts_model = 'tts-1',
      transition_duration = 0.8,
      tts_provider, elevenlabs_voice_id, elevenlabs_api_key, size,
    } = data;

    safeTableName = /^[a-zA-Z0-9_]+$/.test(table_name) ? table_name : 'facelessai_jobs';

    if (!Array.isArray(scenes) || scenes.length < 2) {
      throw new Error('Precisa de um array "scenes" com no mínimo 2 itens');
    }

    const useElevenLabs = tts_provider === 'elevenlabs' || !!elevenlabs_voice_id;
    const elKey = elevenlabs_api_key || ELEVENLABS_KEY;
    const voiceIdToUse = elevenlabs_voice_id || RAUNAK_M_VOICE_ID;

    if (useElevenLabs && !elKey) {
      throw new Error('tts_provider=elevenlabs foi pedido, mas nenhuma ELEVENLABS_KEY está configurada.');
    }

    jobs[jobId].video_title = video_title;
    await createSupabaseJob(jobId, { video_title: sanitizeTitle(video_title), source: 'image_montage', player_name: player_name || null }, safeTableName);

    // TTS por cena
    const sceneAudioFiles = [];
    for (let i = 0; i < scenes.length; i++) {
      jobs[jobId].progress = `Gerando narração da cena ${i + 1}/${scenes.length}...`;
      const audioPath = path.join(jobDir, `scene_audio_${i}.mp3`);
      if (useElevenLabs) {
        await elevenLabsTTS(scenes[i].narration, elKey, audioPath, voiceIdToUse);
      } else {
        // Edge TTS para montagem também
        await generateTTSChunk(scenes[i].narration, tts_voice, tts_model, openai_api_key, audioPath);
      }
      sceneAudioFiles.push(audioPath);
    }

    const scenesWithDuration = [];
    for (let i = 0; i < scenes.length; i++) {
      const { stdout: d } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${sceneAudioFiles[i]}"`, { timeout: 30000 });
      const duration = parseFloat(d.trim()) || 4;
      scenesWithDuration.push({ ...scenes[i], duration });
    }

    jobs[jobId].progress = 'Baixando imagens das cenas...';
    for (let i = 0; i < scenesWithDuration.length; i++) {
      const scene = scenesWithDuration[i];
      const imgPath = path.join(jobDir, `scene_img_${i}.png`);
      if (scene.image_url) await downloadFile(scene.image_url, imgPath);
      else if (scene.image) fs.copyFileSync(scene.image, imgPath);
      else throw new Error(`Cena ${i} não tem image_url nem image`);
      scene.image = imgPath;
    }

    jobs[jobId].progress = 'Montando narração final...';
    const concatListPath = path.join(jobDir, 'audio_concat.txt');
    fs.writeFileSync(concatListPath, sceneAudioFiles.map(p => `file '${p}'`).join('\n'));
    const narrationPath = path.join(jobDir, 'narration.mp3');
    await execAsync(`ffmpeg -y -f concat -safe 0 -i "${concatListPath}" -c copy "${narrationPath}"`, { timeout: 120000 });

    jobs[jobId].progress = 'Renderizando vídeo (zoom + transições)...';
    const outputPath = path.join(jobDir, 'output.mp4');
    await gerarMontagem(scenesWithDuration, narrationPath, outputPath, { transitionDuration: transition_duration, tmpDir: jobDir, ...(size ? { size } : {}) });

    jobs[jobId].progress = 'Enviando para R2...';
    const r2Key = `${jobId}.mp4`;
    const publicUrl = await uploadToR2(outputPath, r2Key);

    jobs[jobId].status = 'completed';
    jobs[jobId].progress = 'Concluido';
    jobs[jobId].video_url = publicUrl;
    jobs[jobId].source = 'image_montage';

    await updateSupabase(jobId, { status: 'completed', video_url: publicUrl, video_title: sanitizeTitle(video_title), updated_at: new Date().toISOString() }, safeTableName);
  } catch (error) {
    console.error(`[${jobId}] ERRO (montagem):`, error.message);
    jobs[jobId].status = 'failed';
    jobs[jobId].error = error.message;
    await updateSupabase(jobId, { status: 'failed', error: error.message }, safeTableName);
  } finally {
    try { await execAsync(`rm -rf "${jobDir}"`); } catch {}
  }
}

// ═══════════════════════════════════════════════════════════════
// ROTAS
// ═══════════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
  res.json({
    status: 'ok', version: '6.8-edge-tts',
    storage: 'Cloudflare R2', db: 'Supabase',
    tts: 'Edge TTS (gratuito)',
    features: ['kling', 'pexels', 'queue', 'tiktok-shop', 'edge-tts'],
    queue: { length: jobQueue.length, processing: isProcessing },
    tiktok_jobs: Object.keys(tiktokJobs).length,
    openai_configured: !!OPENAI_API_KEY
  });
});

app.post('/kling-token', authMiddleware, (req, res) => {
  const { access_key, secret_key } = req.body;
  if (!access_key || !secret_key) return res.status(400).json({ error: 'access_key and secret_key required' });
  res.json({ token: generateKlingJWT(access_key, secret_key) });
});

app.post('/kling-create-tasks', authMiddleware, async (req, res) => {
  const { access_key, secret_key, scenes } = req.body;
  if (!access_key || !secret_key || !scenes) return res.status(400).json({ error: 'access_key, secret_key and scenes required' });
  const token = generateKlingJWT(access_key, secret_key);
  const taskIds = [], errors = [];
  for (let i = 0; i < scenes.length; i++) {
    try {
      const result = await klingRequest('POST', '/v1/videos/text2video', token, { model: 'kling-v1', prompt: scenes[i].prompt, duration: '5', aspect_ratio: '16:9' });
      if (result.data?.task_id) taskIds.push(result.data.task_id);
      else errors.push({ scene: i, error: JSON.stringify(result) });
    } catch(e) { errors.push({ scene: i, error: e.message }); }
  }
  res.json({ task_ids: taskIds, errors });
});

app.post('/kling-poll-tasks', authMiddleware, async (req, res) => {
  const { access_key, secret_key, task_ids, max_wait_seconds = 300 } = req.body;
  if (!access_key || !secret_key || !task_ids) return res.status(400).json({ error: 'access_key, secret_key and task_ids required' });
  const token = generateKlingJWT(access_key, secret_key);
  const videoUrls = [];
  const startTime = Date.now();
  for (const taskId of task_ids) {
    let videoUrl = null, attempts = 0;
    while (attempts < 20) {
      if ((Date.now() - startTime) > max_wait_seconds * 1000) break;
      try {
        const result = await klingRequest('GET', `/v1/videos/text2video/${taskId}`, token);
        if (result.data?.task_status === 'succeed') { videoUrl = result.data.task_result?.videos?.[0]?.url; break; }
        else if (result.data?.task_status === 'failed') break;
      } catch(e) { console.error(`Poll error for ${taskId}:`, e.message); }
      attempts++;
      await new Promise(r => setTimeout(r, 15000));
    }
    if (videoUrl) videoUrls.push(videoUrl);
  }
  res.json({ video_urls: videoUrls, count: videoUrls.length });
});

app.post('/pexels-search', authMiddleware, async (req, res) => {
  const { query, api_key, count = 5 } = req.body;
  if (!query || !api_key) return res.status(400).json({ error: 'query and api_key required' });
  try {
    const urls = await searchPexelsVideos(query, api_key, count);
    res.json({ video_urls: urls, count: urls.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/upload-image', authMiddleware, async (req, res) => {
  try {
    const { image_base64, key } = req.body;
    if (!image_base64 || !key) return res.status(400).json({ error: 'image_base64 and key required' });
    const tmpPath = `/tmp/upload_${Date.now()}_${Math.random().toString(36).slice(2)}.png`;
    fs.writeFileSync(tmpPath, Buffer.from(image_base64, 'base64'));
    const url = await uploadToR2Generic(tmpPath, key, 'image/png');
    fs.unlinkSync(tmpPath);
    res.json({ url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/resize-image', authMiddleware, async (req, res) => {
  const tmpIn = `/tmp/resize_in_${Date.now()}_${Math.random().toString(36).slice(2)}.png`;
  const tmpOut = `/tmp/resize_out_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`;
  try {
    const { image_base64, width = 1280, height = 720 } = req.body;
    if (!image_base64) return res.status(400).json({ error: 'image_base64 required' });
    fs.writeFileSync(tmpIn, Buffer.from(image_base64, 'base64'));
    await execAsync(
      `ffmpeg -y -i "${tmpIn}" -vf "scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}" -q:v 2 "${tmpOut}"`,
      { timeout: 30000 }
    );
    const outBuffer = fs.readFileSync(tmpOut);
    res.json({ image_base64: outBuffer.toString('base64'), width, height });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }
});

app.post('/render', authMiddleware, async (req, res) => {
  const jobId = req.body.job_id || `job_${Date.now()}`;
  jobs[jobId] = { status: 'queued', progress: 'Na fila...', created_at: new Date().toISOString() };
  enqueueJob(jobId, req.body);
  res.json({ job_id: jobId, status: 'queued', queue_position: jobQueue.length });
});

app.get('/status/:jobId', authMiddleware, (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ job_id: req.params.jobId, ...job });
});

app.get('/jobs', authMiddleware, (req, res) => res.json(jobs));

app.get('/queue', authMiddleware, (req, res) => {
  res.json({ queue_length: jobQueue.length, is_processing: isProcessing, pending_jobs: jobQueue.map(j => j.jobId) });
});

app.post('/tiktok/create-product', authMiddleware, (req, res) => {
  const data = req.body;
  if (!data?.title) return res.status(400).json({ error: 'title required' });
  const jobId = data.job_id || `prod_${Date.now()}_${Math.random().toString(36).substr(2,6)}`;
  tiktokJobs[jobId] = { job_id: jobId, type: 'product', status: 'queued', step: 'starting', product_title: cleanVal(data.title), created_at: new Date().toISOString() };
  createTikTokProduct(jobId, data);
  res.json({ job_id: jobId, status: 'queued', message: 'Product creation started' });
});

app.post('/tiktok/create-video', authMiddleware, (req, res) => {
  const data = req.body;
  if (!data?.product_title) return res.status(400).json({ error: 'product_title required' });
  const jobId = data.job_id || `vid_${Date.now()}_${Math.random().toString(36).substr(2,6)}`;
  tiktokJobs[jobId] = { job_id: jobId, type: 'video', status: 'queued', step: 'starting', product_title: cleanVal(data.product_title), angle: parseInt(data.angle) || 0, created_at: new Date().toISOString() };
  createTikTokVideo(jobId, data);
  res.json({ job_id: jobId, status: 'queued', message: 'Video creation started' });
});

app.get('/tiktok/status/:jobId', authMiddleware, (req, res) => {
  const job = tiktokJobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.get('/tiktok/jobs', authMiddleware, (req, res) => {
  const list = Object.values(tiktokJobs).sort((a,b) => b.created_at > a.created_at ? 1 : -1).slice(0,50);
  res.json({ total: list.length, jobs: list });
});

app.post('/tiktok/test-telegram', authMiddleware, async (req, res) => {
  try {
    await sendTelegram(
      '🤖 <b>TikTok Shop Bot ativo! v6.8-edge-tts</b>\n\nSeu sistema de automacao esta funcionando.\n\nTTS: Edge TTS (gratuito)',
      [[{ text: '✅ Recebi!', callback_data: 'test_ok' }]]
    );
    res.json({ ok: true, message: 'Telegram message sent' });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FacelessAI + TikTok Shop Render Server v6.8-edge-tts na porta ${PORT}`);
  console.log(`TTS: Edge TTS (gratuito) para FacelessAI | OpenAI/ElevenLabs mantidos para TikTok Shop`);
  console.log(`Credenciais: AUTH_KEY, R2_*, SUPABASE_KEY — todas via process.env`);
});
