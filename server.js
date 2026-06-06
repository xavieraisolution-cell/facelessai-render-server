const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '50mb' }));

const AUTH_KEY = process.env.AUTH_KEY || 'facelessai2026xaviersecretkey32x';
const R2_ACCOUNT_ID = 'dcd6de84a693624dc026f7bb36c15512';
const R2_ACCESS_KEY = 'b87fed362846fe8a45021f67254cada5';
const R2_SECRET_KEY = '6a4511f9fe8039b9839486dcdc3075dcfd2aad4355e73f98de4eecd24ccf0ed9';
const R2_BUCKET = 'facelessai-videos';
const R2_PUBLIC_URL = 'https://pub-5a163e6e865546d38356eb3df280caaa.r2.dev';
const SUPABASE_URL = 'https://fnzzqfffzvlffgilfpoz.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZuenpxZmZmenZsZmZnaWxmcG96Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTk1OTk0NiwiZXhwIjoyMDk1NTM1OTQ2fQ.BT6WFo6HzkvrweJHXZTyDxNnwtLh2AZzbp5aTbXPgzM';

const jobs = {};

// ── v5.10: Job Queue — processa um job por vez ──
const jobQueue = [];
let isProcessing = false;

async function enqueueJob(jobId, data) {
  jobQueue.push({ jobId, data });
  console.log(`[Queue] Job ${jobId} adicionado. Fila: ${jobQueue.length} jobs.`);
  if (!isProcessing) {
    processQueue();
  }
}

async function processQueue() {
  if (jobQueue.length === 0) {
    isProcessing = false;
    return;
  }
  isProcessing = true;
  const { jobId, data } = jobQueue.shift();
  console.log(`[Queue] Iniciando job ${jobId}. Restam ${jobQueue.length} na fila.`);
  try {
    await processJob(jobId, data);
  } catch (e) {
    console.error(`[Queue] Erro no job ${jobId}:`, e.message);
  }
  processQueue();
}
// ────────────────────────────────────────────────

function authMiddleware(req, res, next) {
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${AUTH_KEY}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── v5.9: extract short keyword query from long titles ──
function extractKeywords(title, language = 'en') {
  const stopwordsEN = new Set([
    'a','an','the','and','or','but','in','on','at','to','for','of','with',
    'by','from','is','was','are','were','be','been','being','have','has',
    'had','do','does','did','will','would','could','should','may','might',
    'what','when','where','who','how','why','which','that','this','these',
    'those','if','then','than','so','yet','both','either','whether','while',
    'into','through','during','before','after','above','below','between',
    'your','my','his','her','its','our','their','you','we','they','he','she',
    'it','i','me','him','us','them','first','last','new','old','just','can',
    'get','got','make','made','take','took','give','gave','come','came',
    'feet','fell','happen','happened','happens','things','thing','about',
    'also','back','even','here','still','such','take','well','much','many',
    'really','very','never','always','every','each','most','more','some',
    'actually','literally','basically','truly','completely','absolutely'
  ]);

  const stopwordsPT = new Set([
    'o','a','os','as','um','uma','uns','umas','e','ou','mas','em','no','na',
    'nos','nas','ao','aos','de','do','da','dos','das','por','para','com',
    'que','se','não','mais','muito','bem','como','quando','onde','quem',
    'qual','quais','este','esta','estes','estas','esse','essa','isso','aqui',
    'foi','ser','estar','ter','haver','fazer','ir','vir','ver','dar','saber',
    'já','ainda','também','então','assim','porque','pois','até','após',
    'antes','depois','desde','entre','durante','contra','sobre','pelo','pela'
  ]);

  const stopwords = language === 'pt' ? stopwordsPT : stopwordsEN;

  const words = title
    .toLowerCase()
    .replace(/[^a-záéíóúãõàâêôü\s]/gi, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopwords.has(w));

  const keywords = words.slice(0, 3).join(' ');
  return keywords || title.split(' ').slice(0, 2).join(' ');
}
// ────────────────────────────────────────────────────────────

function generateKlingJWT(ak, sk) {
  function base64url(obj) {
    return Buffer.from(JSON.stringify(obj)).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }
  const now = Math.floor(Date.now() / 1000);
  const header = base64url({ alg: 'HS256', typ: 'JWT' });
  const payload = base64url({ iss: ak, exp: now + 1800, nbf: now - 5 });
  const sig = crypto.createHmac('sha256', sk)
    .update(`${header}.${payload}`)
    .digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${header}.${payload}.${sig}`;
}

function klingRequest(method, reqPath, token, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.klingai.com',
      path: reqPath,
      method,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    };
    if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function searchPexelsVideos(query, apiKey, count = 5) {
  return new Promise((resolve, reject) => {
    const encodedQuery = encodeURIComponent(query);
    const options = {
      hostname: 'api.pexels.com',
      path: `/videos/search?query=${encodedQuery}&per_page=${count}&orientation=landscape&size=medium`,
      method: 'GET',
      headers: { 'Authorization': apiKey }
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          const urls = [];
          if (data.videos) {
            for (const video of data.videos) {
              const file = video.video_files
                .filter(f => f.quality === 'hd' || f.quality === 'sd')
                .sort((a, b) => b.width - a.width)[0];
              if (file) urls.push(file.link);
            }
          }
          resolve(urls);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
      }
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

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

async function updateSupabase(jobId, data) {
  try {
    const body = JSON.stringify(data);
    const url = new URL(SUPABASE_URL);
    await httpsRequest({
      hostname: url.hostname,
      path: `/rest/v1/facelessai_jobs?job_id=eq.${jobId}`,
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Prefer': 'return=minimal'
      },
    }, body);
    console.log(`[${jobId}] Supabase atualizado: ${JSON.stringify(data)}`);
  } catch (e) {
    console.warn(`[${jobId}] Falha ao atualizar Supabase: ${e.message}`);
  }
}

function signR2Request(method, key, contentType, bodyBuffer) {
  const now = new Date();
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 8);
  const datetime = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const region = 'auto';
  const service = 's3';
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
    headers: {
      'Content-Type': contentType, 'Content-Length': fileBuffer.length,
      'x-amz-date': datetime, 'x-amz-content-sha256': payloadHash, 'Authorization': authorization,
    },
  }, fileBuffer);
  if (result.statusCode !== 200) throw new Error(`R2 upload error ${result.statusCode}: ${result.body.toString()}`);
  return `${R2_PUBLIC_URL}/${key}`;
}

function splitIntoChunks(text, maxChars = 4000) {
  const chunks = [];
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  let current = '';
  for (const sentence of sentences) {
    if ((current + sentence).length > maxChars) {
      if (current.trim()) chunks.push(current.trim());
      current = sentence;
    } else { current += sentence; }
  }
  if (current.trim()) chunks.push(current.trim());
  const finalChunks = [];
  for (const chunk of chunks) {
    if (chunk.length <= maxChars) { finalChunks.push(chunk); continue; }
    const words = chunk.split(' ');
    let part = '';
    for (const word of words) {
      if ((part + ' ' + word).length > maxChars) {
        if (part.trim()) finalChunks.push(part.trim());
        part = word;
      } else { part += ' ' + word; }
    }
    if (part.trim()) finalChunks.push(part.trim());
  }
  return finalChunks;
}

async function generateTTSChunk(text, voice, model, apiKey, outputPath) {
  const body = JSON.stringify({ model, input: text, voice, response_format: 'mp3' });
  const result = await httpsRequest({
    hostname: 'api.openai.com', path: '/v1/audio/speech', method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, body);
  if (result.statusCode !== 200) throw new Error(`OpenAI TTS error ${result.statusCode}: ${result.body.toString()}`);
  fs.writeFileSync(outputPath, result.body);
}

async function processJob(jobId, data) {
  const jobDir = `/tmp/${jobId}`;
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    jobs[jobId].status = 'processing';
    jobs[jobId].progress = 'Iniciando...';

    const {
      script, video_clips, openai_api_key, tts_voice = 'alloy',
      tts_model = 'tts-1', audio_url, video_title = 'FacelessAI',
      pexels_api_key, pexels_query, source = 'kling', language = 'en-US'
    } = data;
    jobs[jobId].video_title = video_title;

    let finalAudioPath = path.join(jobDir, 'final_audio.mp3');

    if (script && openai_api_key) {
      jobs[jobId].progress = 'Gerando áudio TTS...';
      const chunks = splitIntoChunks(script, 4000);
      const chunkPaths = [];
      for (let i = 0; i < chunks.length; i++) {
        const chunkPath = path.join(jobDir, `chunk_${i}.mp3`);
        jobs[jobId].progress = `TTS chunk ${i + 1}/${chunks.length}...`;
        await generateTTSChunk(chunks[i], tts_voice, tts_model, openai_api_key, chunkPath);
        chunkPaths.push(chunkPath);
      }
      if (chunkPaths.length === 1) {
        fs.copyFileSync(chunkPaths[0], finalAudioPath);
      } else {
        const listFile = path.join(jobDir, 'chunks.txt');
        fs.writeFileSync(listFile, chunkPaths.map(p => `file '${p}'`).join('\n'));
        execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${finalAudioPath}"`, { timeout: 120000 });
      }
    } else if (audio_url) {
      jobs[jobId].progress = 'Baixando áudio...';
      await downloadFile(audio_url, finalAudioPath);
    } else {
      throw new Error('Nenhum script ou audio_url fornecido');
    }

    jobs[jobId].progress = 'Calculando duração...';
    let audioDuration;
    try {
      const d = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${finalAudioPath}"`, { timeout: 30000 }).toString().trim();
      audioDuration = parseFloat(d);
      if (isNaN(audioDuration) || audioDuration <= 0) throw new Error('Duração inválida');
    } catch (e) {
      const wavPath = path.join(jobDir, 'audio_check.wav');
      execSync(`ffmpeg -y -i "${finalAudioPath}" "${wavPath}"`, { timeout: 60000 });
      const d = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${wavPath}"`, { timeout: 30000 }).toString().trim();
      audioDuration = parseFloat(d);
      fs.unlinkSync(wavPath);
    }

    let clipUrls = Array.isArray(video_clips) ? [...video_clips] : [];

    // ── v5.9: usa extractKeywords para query curta e eficaz no Pexels ──
    if ((source === 'pexels' || clipUrls.length === 0) && pexels_api_key) {
      jobs[jobId].progress = 'Buscando clips no Pexels...';
      const lang = language.startsWith('pt') ? 'pt' : 'en';
      const query = pexels_query || extractKeywords(video_title, lang);
      console.log(`[${jobId}] Pexels query: "${query}" (título: "${video_title}")`);
      const pexelsUrls = await searchPexelsVideos(query, pexels_api_key, 5);
      clipUrls = [...clipUrls, ...pexelsUrls];
      console.log(`[${jobId}] Pexels encontrou ${pexelsUrls.length} clips para "${query}"`);

      if (pexelsUrls.length === 0) {
        const fallbackQuery = lang === 'pt' ? 'natureza cosmos universo' : 'nature cosmos universe';
        console.log(`[${jobId}] Fallback Pexels query: "${fallbackQuery}"`);
        const fallbackUrls = await searchPexelsVideos(fallbackQuery, pexels_api_key, 5);
        clipUrls = [...clipUrls, ...fallbackUrls];
        console.log(`[${jobId}] Fallback encontrou ${fallbackUrls.length} clips`);
      }
    }

    if (clipUrls.length === 0) throw new Error('Nenhum clip de vídeo disponível');

    jobs[jobId].progress = 'Baixando clips...';
    const clipPaths = [];
    for (let i = 0; i < Math.min(clipUrls.length, 5); i++) {
      const clipPath = path.join(jobDir, `clip_${i}.mp4`);
      try {
        await downloadFile(clipUrls[i], clipPath);
        clipPaths.push(clipPath);
      } catch (e) {
        console.warn(`[${jobId}] Falha clip ${i}: ${e.message}`);
      }
    }
    if (clipPaths.length === 0) throw new Error('Nenhum clip baixado com sucesso');

    jobs[jobId].progress = 'Normalizando clips...';
    const normalizedPaths = [];
    for (let i = 0; i < clipPaths.length; i++) {
      const normPath = path.join(jobDir, `norm_${i}.mp4`);
      // ── v5.10: timeout aumentado para 10 minutos ──
      execSync(`ffmpeg -y -i "${clipPaths[i]}" -vf "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1" -r 30 -an -c:v libx264 -preset ultrafast -crf 28 "${normPath}"`, { timeout: 600000 });
      normalizedPaths.push(normPath);
    }

    jobs[jobId].progress = 'Montando vídeo...';
    const loopListFile = path.join(jobDir, 'loop_list.txt');
    let totalDuration = 0;
    const loopEntries = [];
    while (totalDuration < audioDuration) {
      for (const np of normalizedPaths) {
        if (totalDuration >= audioDuration) break;
        let clipDur = 10;
        try {
          const cd = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${np}"`, { timeout: 30000 }).toString().trim();
          clipDur = parseFloat(cd) || 10;
        } catch {}
        loopEntries.push(`file '${np}'`);
        totalDuration += clipDur;
      }
    }
    fs.writeFileSync(loopListFile, loopEntries.join('\n'));

    const loopedVideoPath = path.join(jobDir, 'looped_video.mp4');
    // ── v5.10: timeout aumentado para 15 minutos ──
    execSync(`ffmpeg -y -f concat -safe 0 -i "${loopListFile}" -t ${audioDuration} -c:v libx264 -preset ultrafast -crf 28 "${loopedVideoPath}"`, { timeout: 900000 });

    jobs[jobId].progress = 'Mesclando vídeo e áudio...';
    const outputPath = path.join(jobDir, 'output.mp4');
    execSync(`ffmpeg -y -i "${loopedVideoPath}" -i "${finalAudioPath}" -map 0:v -map 1:a -c:v copy -c:a aac -shortest "${outputPath}"`, { timeout: 300000 });

    jobs[jobId].progress = 'Enviando para Cloudflare R2...';
    const r2Key = `${jobId}.mp4`;
    const publicUrl = await uploadToR2(outputPath, r2Key);

    jobs[jobId].status = 'completed';
    jobs[jobId].progress = 'Concluído';
    jobs[jobId].video_url = publicUrl;
    jobs[jobId].source = source;

    await updateSupabase(jobId, {
      status: 'completed',
      video_url: publicUrl,
      video_title: video_title,
      updated_at: new Date().toISOString()
    });

  } catch (error) {
    console.error(`[${jobId}] ERRO:`, error.message);
    jobs[jobId].status = 'failed';
    jobs[jobId].error = error.message;
    await updateSupabase(jobId, { status: 'failed', error: error.message });
  } finally {
    try { execSync(`rm -rf "${jobDir}"`); } catch {}
  }
}

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '5.10',
    storage: 'Cloudflare R2',
    db: 'Supabase',
    features: ['kling', 'pexels', 'queue'],
    queue: { length: jobQueue.length, processing: isProcessing }
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
  const taskIds = [];
  const errors = [];
  for (let i = 0; i < scenes.length; i++) {
    try {
      const result = await klingRequest('POST', '/v1/videos/text2video', token, {
        model: 'kling-v1', prompt: scenes[i].prompt, duration: '5', aspect_ratio: '16:9'
      });
      if (result.data && result.data.task_id) taskIds.push(result.data.task_id);
      else errors.push({ scene: i, error: JSON.stringify(result) });
    } catch (e) { errors.push({ scene: i, error: e.message }); }
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
    let videoUrl = null;
    let attempts = 0;
    while (attempts < 20) {
      if ((Date.now() - startTime) > max_wait_seconds * 1000) break;
      try {
        const result = await klingRequest('GET', `/v1/videos/text2video/${taskId}`, token);
        if (result.data && result.data.task_status === 'succeed') {
          videoUrl = result.data.task_result?.videos?.[0]?.url;
          break;
        } else if (result.data && result.data.task_status === 'failed') break;
      } catch (e) { console.error(`Poll error for ${taskId}:`, e.message); }
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
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/render', authMiddleware, async (req, res) => {
  const jobId = req.body.job_id || `job_${Date.now()}`;
  jobs[jobId] = { status: 'queued', progress: 'Na fila...', created_at: new Date().toISOString() };
  // ── v5.10: usa fila em vez de processar diretamente ──
  enqueueJob(jobId, req.body);
  res.json({ job_id: jobId, status: 'queued', queue_position: jobQueue.length });
});

app.get('/status/:jobId', authMiddleware, (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ job_id: req.params.jobId, ...job });
});

app.get('/jobs', authMiddleware, (req, res) => res.json(jobs));

// ── v5.10: endpoint para ver status da fila ──
app.get('/queue', authMiddleware, (req, res) => {
  res.json({
    queue_length: jobQueue.length,
    is_processing: isProcessing,
    pending_jobs: jobQueue.map(j => j.jobId)
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FacelessAI Render Server v5.10 rodando na porta ${PORT}`);
  console.log(`Storage: R2 | DB: Supabase | Features: Kling AI + Pexels + Smart Keywords + Job Queue`);
  console.log(`FFmpeg: ${execSync('ffmpeg -version').toString().split('\n')[0]}`);
});
