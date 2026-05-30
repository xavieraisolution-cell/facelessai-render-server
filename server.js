const express = require('express');
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
app.use(express.json({ limit: '50mb' }));

const AUTH_KEY = process.env.AUTH_KEY || 'facelessai2026xaviersecretkey32x';
const jobs = {};

// ─── Auth Middleware ───────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${AUTH_KEY}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
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

function httpsPost(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ─── Split text into chunks of max N chars, breaking at sentence boundaries ───
function splitIntoChunks(text, maxChars = 4000) {
  const chunks = [];
  // Split at sentence boundaries (. ! ?)
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

  // Safety: if a single sentence > maxChars, split by word
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

// ─── Generate TTS audio for a single chunk via OpenAI ─────────────────────────
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

  const result = await httpsPost(options, body);
  if (result.statusCode !== 200) {
    throw new Error(`OpenAI TTS error ${result.statusCode}: ${result.body.toString()}`);
  }
  fs.writeFileSync(outputPath, result.body);
}

// ─── Main render job ──────────────────────────────────────────────────────────
async function processJob(jobId, data) {
  const jobDir = `/tmp/${jobId}`;
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    jobs[jobId].status = 'processing';
    jobs[jobId].progress = 'Iniciando...';

    const {
      script,
      video_clips,
      openai_api_key,
      tts_voice = 'alloy',
      tts_model = 'tts-1',
      // Legacy: single audio_url support
      audio_url,
    } = data;

    let finalAudioPath = path.join(jobDir, 'final_audio.mp3');

    // ── TTS: full script in chunks ───────────────────────────────────────────
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
        // Concatenate via FFmpeg
        jobs[jobId].progress = 'Concatenando áudios...';
        const listFile = path.join(jobDir, 'chunks.txt');
        const listContent = chunkPaths.map(p => `file '${p}'`).join('\n');
        fs.writeFileSync(listFile, listContent);
        execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${finalAudioPath}"`);
        console.log(`[${jobId}] Áudios concatenados`);
      }
    } else if (audio_url) {
      // Legacy: download pre-generated audio
      jobs[jobId].progress = 'Baixando áudio...';
      await downloadFile(audio_url, finalAudioPath);
    } else {
      throw new Error('Nenhum script ou audio_url fornecido');
    }

    // ── Get audio duration ───────────────────────────────────────────────────
    jobs[jobId].progress = 'Calculando duração do áudio...';
    let audioDuration;
    try {
      const durationOutput = execSync(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${finalAudioPath}"`
      ).toString().trim();
      audioDuration = parseFloat(durationOutput);
      if (isNaN(audioDuration) || audioDuration <= 0) throw new Error('Duração inválida');
    } catch (e) {
      // Fallback: decode and measure
      const wavPath = path.join(jobDir, 'audio_check.wav');
      execSync(`ffmpeg -y -i "${finalAudioPath}" "${wavPath}"`);
      const durationOutput = execSync(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${wavPath}"`
      ).toString().trim();
      audioDuration = parseFloat(durationOutput);
      fs.unlinkSync(wavPath);
    }
    console.log(`[${jobId}] Duração do áudio: ${audioDuration}s`);

    // ── Download video clips ─────────────────────────────────────────────────
    jobs[jobId].progress = 'Baixando clips de vídeo...';
    const clipPaths = [];
    const clips = Array.isArray(video_clips) ? video_clips : [];

    for (let i = 0; i < clips.length; i++) {
      const clipPath = path.join(jobDir, `clip_${i}.mp4`);
      try {
        await downloadFile(clips[i], clipPath);
        clipPaths.push(clipPath);
        console.log(`[${jobId}] Clip ${i + 1}/${clips.length} baixado`);
      } catch (e) {
        console.warn(`[${jobId}] Falha ao baixar clip ${i}: ${e.message}`);
      }
    }

    if (clipPaths.length === 0) throw new Error('Nenhum clip de vídeo disponível');

    // ── Build looping video to match audio duration ──────────────────────────
    jobs[jobId].progress = 'Montando vídeo...';

    // Normalize clips to 1080x1920 (vertical), 30fps, no audio
    const normalizedPaths = [];
    for (let i = 0; i < clipPaths.length; i++) {
      const normPath = path.join(jobDir, `norm_${i}.mp4`);
      execSync(
        `ffmpeg -y -i "${clipPaths[i]}" -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1" -r 30 -an -c:v libx264 -preset fast -crf 23 "${normPath}"`
      );
      normalizedPaths.push(normPath);
    }

    // Loop clips until we cover audioDuration
    const loopListFile = path.join(jobDir, 'loop_list.txt');
    let totalDuration = 0;
    const loopEntries = [];

    while (totalDuration < audioDuration) {
      for (const np of normalizedPaths) {
        if (totalDuration >= audioDuration) break;
        // Get clip duration
        let clipDur = 10;
        try {
          const cd = execSync(
            `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${np}"`
          ).toString().trim();
          clipDur = parseFloat(cd) || 10;
        } catch {}
        loopEntries.push(`file '${np}'`);
        totalDuration += clipDur;
      }
    }

    fs.writeFileSync(loopListFile, loopEntries.join('\n'));

    const loopedVideoPath = path.join(jobDir, 'looped_video.mp4');
    execSync(
      `ffmpeg -y -f concat -safe 0 -i "${loopListFile}" -t ${audioDuration} -c:v libx264 -preset fast -crf 23 "${loopedVideoPath}"`
    );

    // ── Merge video + audio ──────────────────────────────────────────────────
    jobs[jobId].progress = 'Mesclando vídeo e áudio...';
    const outputPath = path.join(jobDir, 'output.mp4');
    execSync(
      `ffmpeg -y -i "${loopedVideoPath}" -i "${finalAudioPath}" -map 0:v -map 1:a -c:v copy -c:a aac -shortest "${outputPath}"`
    );

    console.log(`[${jobId}] Vídeo final gerado: ${outputPath}`);

    // ── Upload to Supabase ───────────────────────────────────────────────────
    if (data.supabase_url && data.supabase_key) {
      jobs[jobId].progress = 'Enviando para Supabase...';
      const videoBuffer = fs.readFileSync(outputPath);
      const uploadUrl = `${data.supabase_url}/storage/v1/object/facelessai-videos/${jobId}.mp4`;

      const uploadOptions = {
        hostname: new URL(data.supabase_url).hostname,
        path: `/storage/v1/object/facelessai-videos/${jobId}.mp4`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${data.supabase_key}`,
          'Content-Type': 'video/mp4',
          'Content-Length': videoBuffer.length,
        },
      };

      const uploadResult = await httpsPost(uploadOptions, videoBuffer);
      if (uploadResult.statusCode !== 200 && uploadResult.statusCode !== 201) {
        throw new Error(`Supabase upload error ${uploadResult.statusCode}: ${uploadResult.body.toString()}`);
      }

      const publicUrl = `${data.supabase_url}/storage/v1/object/public/facelessai-videos/${jobId}.mp4`;
      jobs[jobId].status = 'completed';
      jobs[jobId].progress = 'Concluído';
      jobs[jobId].video_url = publicUrl;
      console.log(`[${jobId}] Upload concluído: ${publicUrl}`);
    } else {
      // Return base64 if no Supabase configured
      const videoBuffer = fs.readFileSync(outputPath);
      jobs[jobId].status = 'completed';
      jobs[jobId].progress = 'Concluído';
      jobs[jobId].video_base64 = videoBuffer.toString('base64');
    }

  } catch (error) {
    console.error(`[${jobId}] ERRO:`, error.message);
    jobs[jobId].status = 'failed';
    jobs[jobId].error = error.message;
  } finally {
    // Cleanup temp files
    try { execSync(`rm -rf "${jobDir}"`); } catch {}
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '5.0', jobs_in_memory: Object.keys(jobs).length });
});

app.post('/render', authMiddleware, async (req, res) => {
  const jobId = `job_${Date.now()}`;
  jobs[jobId] = { status: 'queued', progress: 'Na fila...', created_at: new Date().toISOString() };

  // Start async
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

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FacelessAI Render Server v5.0 rodando na porta ${PORT}`);
  console.log(`TTS em chunks: SIM | FFmpeg: ${execSync('ffmpeg -version').toString().split('\n')[0]}`);
});
