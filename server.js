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

function authMiddleware(req, res, next) {
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${AUTH_KEY}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

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

function klingRequest(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.klingai.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      }
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

  const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
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
    hostname: host,
    path: reqPath,
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      'Content-Length': fileBuffer.length,
      'x-amz-date': datetime,
      'x-amz-content-sha256': payloadHash,
      'Authorization': authorization,
    },
  }, fileBuffer);

  if (result.statusCode !== 200) {
    throw new Error(`R2 upload error ${result.statusCode}: ${result.body.toString()}`);
  }
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
    } else {
      current += sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  const finalChunks = [];
  for (const chunk of chunks) {
    if (chunk.length <= maxChars) {
      finalChunks.push(chunk);
    } else {
      const words = chunk.split(' ');
      let part = '';
      for (const word of words) {
        if ((part + ' ' + word).length > maxChars) {
          if (part.trim()) finalChunks.push(part.trim());
          part = word;
        } else {
          part += ' ' + word;
        }
      }
      if (part.trim()) finalChunks.push(part.trim());
    }
  }
  return finalChunks;
}

async function generateTTSChunk(text, voice, model, apiKey, outputPath) {
  const body = JSON.stringify({ model, input: text, voice, response_format: 'mp3' });
  const options = {
    hostname: 'api.openai.com',
    path: '/v1/audio/speech',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  };
  const result = await httpsRequest(options, body);
  if (result.statusCode !== 200) {
    throw new Error(`OpenAI TTS error ${result.statusCode}: ${result.body.toString()}`);
  }
  fs.writeFileSync(outputPath, result.body);
}

async function processJob(jobId, data) {
  const jobDir = `/tmp/${jobId}`;
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    jobs[jobId].status = 'processing';
    jobs[jobId].progress = 'Iniciando...';

    const { script, video_clips, openai_api_key, tts_voice = 'alloy', tts_model = 'tts-1', audio_url, video_title = 'Curiosidades Misteriosas' } = data;
    jobs[jobId].video_title = video_title;

    let finalAudioPath = path.join(jobDir, 'final_audio.mp3');

    if (script && openai_api_key) {
      jobs[jobId].progress = 'Gerando áudio TTS...';
      const chunks = splitIntoChunks(script, 4000);
      console.log(`[${jobId}] Dividindo roteiro em ${chunks.length} chunks`);

      const chunkPaths = [];
      for (let i = 0; i < chunks.length; i++) {
        const chunkPath = path.join(jobDir, `chunk_${i}.mp3`);
        jobs[jobId].progress = `TTS chunk ${i + 1}/${chunks.length}...`;
        await generateTTSChunk(chunks[i], tts_voice, tts_model, openai_api_key, chunkPath);
        chunkPaths.push(chunkPath);
        console.log(`[${jobId}] Chunk ${i + 1}/${chunks.length} gerado`);
      }

      if (chunkPaths.length === 1) {
        fs.copyFileSync(chunkPaths[0], finalAudioPath);
      } else {
        jobs[jobId].progress = 'Concatenando áudios...';
        const listFile = path.join(jobDir, 'chunks.txt');
        fs.writeFileSync(listFile, chunkPaths.map(p => `file '${p}'`).join('\n'));
        execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${finalAudioPath}"`);
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
      const d = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${finalAudioPath}"`).toString().trim();
      audioDuration = parseFloat(d);
      if (isNaN(audioDuration) || audioDuration <= 0) throw new Error('Duração inválida');
    } catch (e) {
      const wavPath = path.join(jobDir, 'audio_check.wav');
      execSync(`ffmpeg -y -i "${finalAudioPath}" "${wavPath}"`);
      const d = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${wavPath}"`).toString().trim();
      audioDuration = parseFloat(d);
      fs.unlinkSync(wavPath);
    }
    console.log(`[${jobId}] Duração: ${audioDuration}s`);

    jobs[jobId].progress = 'Baixando clips...';
    const clipPaths = [];
    const clips = Array.isArray(video_clips) ? video_clips.slice(0, 5) : [];
    for (let i = 0; i < clips.length; i++) {
      const clipPath = path.join(jobDir, `clip_${i}.mp4`);
      try {
        await downloadFile(clips[i], clipPath);
        clipPaths.push(clipPath);
        console.log(`[${jobId}] Clip ${i + 1}/${clips.length} baixado`);
      } catch (e) {
        console.warn(`[${jobId}] Falha clip ${i}: ${e.message}`);
      }
    }
    if (clipPaths.length === 0) throw new Error('Nenhum clip de vídeo disponível');

    jobs[jobId].progress = 'Normalizando clips...';
    const normalizedPaths = [];
    for (let i = 0; i < clipPaths.length; i++) {
      const normPath = path.join(jobDir, `norm_${i}.mp4`);
      execSync(`ffmpeg -y -i "${clipPaths[i]}" -vf "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1" -r 30 -an -c:v libx264 -preset ultrafast -crf 28 "${normPath}"`, { timeout: 120000 });
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
          const cd = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${np}"`).toString().trim();
          clipDur = parseFloat(cd) || 10;
        } catch {}
        loopEntries.push(`file '${np}'`);
        totalDuration += clipDur;
      }
    }
    fs.writeFileSync(loopListFile, loopEntries.join('\n'));

    const loopedVideoPath = path.join(jobDir, 'looped_video.mp4');
    execSync(`ffmpeg -y -f concat -safe 0 -i "${loopListFile}" -t ${audioDuration} -c:v libx264 -preset ultrafast -crf 28 "${loopedVideoPath}"`, { timeout: 300000 });

    jobs[jobId].progress = 'Mesclando vídeo e áudio...';
    const outputPath = path.join(jobDir, 'output.mp4');
    execSync(`ffmpeg -y -i "${loopedVideoPath}" -i "${finalAudioPath}" -map 0:v -map 1:a -c:v copy -c:a aac -shortest "${outputPath}"`, { timeout: 120000 });

    jobs[jobId].progress = 'Enviando para Cloudflare R2...';
    const r2Key = `${jobId}.mp4`;
    const publicUrl = await uploadToR2(outputPath, r2Key);
    console.log(`[${jobId}] Upload R2: ${publicUrl}`);

    jobs[jobId].status = 'completed';
    jobs[jobId].progress = 'Concluído';
    jobs[jobId].video_url = publicUrl;

    await updateSupabase(jobId, {
      status: 'completed',
      video_url: publicUrl,
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
  res.json({ status: 'ok', version: '5.7', storage: 'Cloudflare R2', db: 'Supabase' });
});

// ── Gera JWT para Kling AI ─────────────────────────────────────────────────
app.post('/kling-token', authMiddleware, (req, res) => {
  const { access_key, secret_key } = req.body;
  if (!access_key || !secret_key) {
    return res.status(400).json({ error: 'access_key and secret_key required' });
  }
  const token = generateKlingJWT(access_key, secret_key);
  res.json({ token });
});

// ── Cria tarefas de vídeo no Kling AI ─────────────────────────────────────
app.post('/kling-create-tasks', authMiddleware, async (req, res) => {
  const { access_key, secret_key, scenes } = req.body;
  if (!access_key || !secret_key || !scenes) {
    return res.status(400).json({ error: 'access_key, secret_key and scenes required' });
  }

  const token = generateKlingJWT(access_key, secret_key);
  const taskIds = [];
  const errors = [];

  for (let i = 0; i < scenes.length; i++) {
    try {
      const result = await klingRequest('POST', '/v1/videos/text2video', token, {
        model: 'kling-v1',
        prompt: scenes[i].prompt,
        duration: '5',
        aspect_ratio: '16:9'
      });

      if (result.data && result.data.task_id) {
        taskIds.push(result.data.task_id);
        console.log(`Kling scene ${i+1} task_id: ${result.data.task_id}`);
      } else {
        errors.push({ scene: i, error: JSON.stringify(result) });
        console.error(`Kling scene ${i+1} error:`, JSON.stringify(result));
      }
    } catch (e) {
      errors.push({ scene: i, error: e.message });
    }
  }

  res.json({ task_ids: taskIds, errors });
});

// ── Faz polling das tarefas Kling e retorna URLs dos vídeos ───────────────
app.post('/kling-poll-tasks', authMiddleware, async (req, res) => {
  const { access_key, secret_key, task_ids, max_wait_seconds = 300 } = req.body;
  if (!access_key || !secret_key || !task_ids) {
    return res.status(400).json({ error: 'access_key, secret_key and task_ids required' });
  }

  const token = generateKlingJWT(access_key, secret_key);
  const videoUrls = [];
  const startTime = Date.now();

  for (const taskId of task_ids) {
    let videoUrl = null;
    let attempts = 0;

    while (attempts < 20) {
      if ((Date.now() - startTime) > max_wait_seconds * 1000) {
        console.warn(`Timeout waiting for task ${taskId}`);
        break;
      }

      try {
        const result = await klingRequest('GET', `/v1/videos/text2video/${taskId}`, token);

        if (result.data && result.data.task_status === 'succeed') {
          videoUrl = result.data.task_result?.videos?.[0]?.url;
          console.log(`Task ${taskId} done: ${videoUrl}`);
          break;
        } else if (result.data && result.data.task_status === 'failed') {
          console.error(`Task ${taskId} failed`);
          break;
        } else {
          console.log(`Task ${taskId} status: ${result.data?.task_status} (attempt ${attempts+1})`);
        }
      } catch (e) {
        console.error(`Poll error for ${taskId}:`, e.message);
      }

      attempts++;
      await new Promise(r => setTimeout(r, 15000));
    }

    if (videoUrl) videoUrls.push(videoUrl);
  }

  res.json({ video_urls: videoUrls, count: videoUrls.length });
});

app.post('/render', authMiddleware, async (req, res) => {
  const jobId = req.body.job_id || `job_${Date.now()}`;
  jobs[jobId] = { status: 'queued', progress: 'Na fila...', created_at: new Date().toISOString() };
  processJob(jobId, req.body).catch(console.error);
  res.json({ job_id: jobId, status: 'queued' });
});

app.get('/status/:jobId', authMiddleware, (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ job_id: req.params.jobId, ...job });
});

app.get('/jobs', authMiddleware, (req, res) => {
  res.json(jobs);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FacelessAI Render Server v5.7 rodando na porta ${PORT}`);
  console.log(`Storage: R2 | DB: Supabase | FFmpeg: ${execSync('ffmpeg -version').toString().split('\n')[0]}`);
});
