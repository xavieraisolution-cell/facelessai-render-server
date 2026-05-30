const express = require('express');
const { spawnSync } = require('child_process');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

// ── Job persistence via Supabase (sobrevive hibernação) ──────────────────────
async function saveJob(job_id, data) {
  try {
    const body = JSON.stringify({ job_id, data: JSON.stringify(data), updated_at: new Date().toISOString() });
    await supabaseRequest('POST', '/rest/v1/facelessai_jobs', body, {
      'Prefer': 'resolution=merge-duplicates'
    });
  } catch(e) { console.error('saveJob error:', e.message); }
}

async function getJob(job_id) {
  try {
    const result = await supabaseRequest('GET', `/rest/v1/facelessai_jobs?job_id=eq.${job_id}&select=data`);
    const rows = JSON.parse(result);
    if (!rows || rows.length === 0) return null;
    return JSON.parse(rows[0].data);
  } catch(e) { console.error('getJob error:', e.message); return null; }
}

function supabaseRequest(method, endpoint, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(SUPABASE_URL + endpoint);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        ...extraHeaders
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
// ─────────────────────────────────────────────────────────────────────────────

function ffmpeg(args, timeout = 300000) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const proc = spawn('ffmpeg', args, {
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > 10000) stderr = stderr.slice(-5000); });
    const timer = setTimeout(() => { proc.kill(); reject(new Error('FFmpeg timeout')); }, timeout);
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg failed (${code}): ${stderr.slice(-300)}`));
    });
    proc.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'FacelessAI Render Server v4.4', ffmpeg: getFfmpegVersion() });

});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.get('/status/:job_id', async (req, res) => {
  const job = await getJob(req.params.job_id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.post('/render', async (req, res) => {
  const { audio_url, clips, language, job_id } = req.body;

  if (!audio_url || !clips || clips.length === 0 || !job_id) {
    return res.status(400).json({
      error: 'Missing fields',
      received: { audio_url: !!audio_url, clips: (clips||[]).length, job_id: !!job_id }
    });
  }

  await saveJob(job_id, { status: 'processing', job_id, started_at: new Date().toISOString() });
  res.json({ success: true, job_id, status: 'processing', message: 'Render started' });

  renderVideo({ audio_url, clips, language, job_id }).catch(async err => {
    console.error(`[${job_id}] Fatal error:`, err.message);
    await saveJob(job_id, { status: 'error', job_id, error: err.message });
  });
});

async function renderVideo({ audio_url, clips, language, job_id }) {
  const workDir = `/tmp/${job_id}`;

  try {
    fs.mkdirSync(workDir, { recursive: true });
    console.log(`[${job_id}] Iniciando render...`);

    // Download audio
    const audioPath = path.join(workDir, 'audio.mpga');
    const audioMp3Path = path.join(workDir, 'audio.mp3');
    console.log(`[${job_id}] Baixando áudio...`);
    await downloadFile(audio_url, audioPath);
    console.log(`[${job_id}] Áudio: ${fs.statSync(audioPath).size} bytes`);

    // Converte para mp3 para leitura correta de duração
    await ffmpeg(['-y', '-i', audioPath, '-c:a', 'libmp3lame', '-q:a', '2', audioMp3Path], 120000);
    if (!fs.existsSync(audioMp3Path) || fs.statSync(audioMp3Path).size === 0) {
      throw new Error('Conversão mp3 falhou');
    }
    
    // Lê duração do mp3 gerado
    let audioDuration = getAudioDuration(audioMp3Path);
    
    // Se duração parecer errada, estima pelo tamanho do mpga original
    // OpenAI TTS gera ~32kbps = 4000 bytes/s
    if (audioDuration < 60 || audioDuration > 3600) {
      const mpgaSize = fs.statSync(audioPath).size;
      audioDuration = mpgaSize / 4000;
      console.log(`[${job_id}] Duração estimada pelo mpga: ${audioDuration}s (${mpgaSize} bytes)`);
    } else {
      console.log(`[${job_id}] Duração real: ${audioDuration}s`);
    }

    // Download clips — até 15 clips com 2GB RAM
    const clipPaths = [];
    for (let i = 0; i < Math.min(clips.length, 15); i++) {
      const clipPath = path.join(workDir, `clip_${i}.mp4`);
      try {
        await downloadFile(clips[i].url, clipPath);
        const realDur = getAudioDuration(clipPath);
        clipPaths.push({ path: clipPath, duration: realDur || clips[i].duration || 10 });
        console.log(`[${job_id}] Clip ${i+1} OK (${realDur}s)`);
      } catch(e) {
        console.error(`[${job_id}] Clip ${i} falhou:`, e.message);
      }
    }

    if (clipPaths.length === 0) throw new Error('Nenhum clip baixado');

    // Concat list embaralhada
    const concatListPath = path.join(workDir, 'clips.txt');
    let concatContent = '';
    let totalDuration = 0;
    const targetDuration = audioDuration + 60; // margem de 60s
    let pass = 0;
    while (totalDuration < targetDuration && pass < 10) {
      const shuffled = [...clipPaths].sort(() => Math.random() - 0.5);
      for (const clip of shuffled) {
        if (totalDuration >= targetDuration) break;
        concatContent += `file '${clip.path}'\n`;
        totalDuration += clip.duration;
      }
      pass++;
    }
    console.log(`[${job_id}] Video total: ${totalDuration}s para audio de ${audioDuration}s`);
    fs.writeFileSync(concatListPath, concatContent);

    // Concatenate
    const rawVideoPath = path.join(workDir, 'raw.mp4');
    console.log(`[${job_id}] Concatenando...`);
    await ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', concatListPath, '-c', 'copy', rawVideoPath], 300000);
    
    if (!fs.existsSync(rawVideoPath)) throw new Error('Concatenação falhou - raw.mp4 não criado');
    console.log(`[${job_id}] raw.mp4: ${fs.statSync(rawVideoPath).size} bytes`);

    // Merge audio + video
    const outputPath = path.join(workDir, 'output.mp4');
    console.log(`[${job_id}] Renderizando...`);
    await ffmpeg([
      '-y', '-i', rawVideoPath, '-i', audioMp3Path,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '38',
      '-c:a', 'aac', '-b:a', '64k',
      '-shortest',
      '-vf', 'scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2,setsar=1',
      '-movflags', '+faststart', outputPath
    ], 600000);

    const videoSize = fs.statSync(outputPath).size;
    console.log(`[${job_id}] Vídeo: ${videoSize} bytes`);

    // Upload to Supabase Storage via stream
    const videoFileName = `${job_id}.mp4`;
    const uploadUrl = `${SUPABASE_URL}/storage/v1/object/facelessai-video/${videoFileName}`;
    console.log(`[${job_id}] Upload Supabase...`);
    await uploadToSupabase(uploadUrl, outputPath, SUPABASE_KEY);

    const videoUrl = `${SUPABASE_URL}/storage/v1/object/public/facelessai-video/${videoFileName}`;
    console.log(`[${job_id}] Concluído: ${videoUrl}`);

    await saveJob(job_id, {
      status: 'completed',
      job_id,
      video_url: videoUrl,
      duration: audioDuration,
      size: videoSize,
      completed_at: new Date().toISOString()
    });

    fs.rmSync(workDir, { recursive: true, force: true });

  } catch(error) {
    console.error(`[${job_id}] Erro:`, error.message);
    await saveJob(job_id, { status: 'error', job_id, error: error.message });
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch(e) {}
  }
}

function uploadToSupabase(url, filePath, key) {
  return new Promise((resolve, reject) => {
    const fileSize = fs.statSync(filePath).size;
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'video/mp4',
        'Content-Length': fileSize,
        'x-upsert': 'true'
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`Upload failed: ${res.statusCode} ${data}`));
      });
    });
    req.on('error', reject);
    // Stream the file instead of loading into memory
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(req);
    fileStream.on('error', reject);
  });
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const protocol = url.startsWith('https') ? https : http;
    const request = protocol.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        return downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) { reject(new Error(`HTTP ${response.statusCode}`)); return; }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    });
    request.on('error', (err) => { fs.unlink(destPath, () => {}); reject(err); });
    request.setTimeout(120000, () => { request.destroy(); reject(new Error('Timeout')); });
  });
}

function getAudioDuration(filePath) {
  try {
    const { spawnSync } = require('child_process');
    // Tenta format duration
    const r1 = spawnSync('ffprobe', ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath], { timeout: 15000, maxBuffer: 1024 * 1024 });
    const v1 = parseFloat(r1.stdout.toString().trim());
    if (v1 && v1 > 0 && v1 < 3600) return v1;
    
    // Tenta stream duration
    const r2 = spawnSync('ffprobe', ['-v', 'quiet', '-show_entries', 'stream=duration', '-of', 'csv=p=0', filePath], { timeout: 15000, maxBuffer: 1024 * 1024 });
    const v2 = parseFloat(r2.stdout.toString().trim());
    if (v2 && v2 > 0 && v2 < 3600) return v2;

    // Estima pelo tamanho do arquivo (mp3 ~128kbps = 16KB/s, mpga ~128kbps)
    const fileSize = fs.statSync(filePath).size;
    const estimated = fileSize / 16000; // bytes / (128kbps / 8)
    console.log(`[duration] estimado pelo tamanho: ${estimated}s (${fileSize} bytes)`);
    if (estimated > 0 && estimated < 3600) return estimated;
    
    return 420; // fallback 7min
  } catch(e) { 
    console.error('getAudioDuration error:', e.message);
    return 420; 
  }
}

function getFfmpegVersion() {
  try {
    const result = spawnSync('ffmpeg', ['-version'], { timeout: 5000, maxBuffer: 1024 * 1024 });
    return result.stdout.toString().split('\n')[0].trim();
  } catch(e) { return 'not found'; }
}

app.listen(PORT, () => {
  console.log(`🎬 FacelessAI Render Server v4.4 na porta ${PORT}`);
  console.log(`FFmpeg: ${getFfmpegVersion()}`);
  console.log(`Supabase: ${SUPABASE_URL ? 'configurado' : 'NÃO configurado'}`);
});
