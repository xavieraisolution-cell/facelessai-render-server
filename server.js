const express = require('express');
const { execSync } = require('child_process');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

// ── Job persistence (arquivo em vez de memória RAM) ──────────────────────────
const JOBS_DIR = '/tmp/facelessai_jobs';
if (!fs.existsSync(JOBS_DIR)) fs.mkdirSync(JOBS_DIR, { recursive: true });

function saveJob(job_id, data) {
  try { fs.writeFileSync(path.join(JOBS_DIR, `${job_id}.json`), JSON.stringify(data)); }
  catch(e) { console.error('saveJob error:', e.message); }
}

function getJob(job_id) {
  try {
    const file = path.join(JOBS_DIR, `${job_id}.json`);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch(e) { return null; }
}
// ─────────────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'FacelessAI Render Server v3.1', ffmpeg: getFfmpegVersion() });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Check job status
app.get('/status/:job_id', (req, res) => {
  const job = getJob(req.params.job_id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// Start render - responds immediately, processes in background
app.post('/render', (req, res) => {
  const { audio_url, clips, language, job_id } = req.body;

  if (!audio_url || !clips || clips.length === 0 || !job_id) {
    return res.status(400).json({ 
      error: 'Missing fields',
      received: { audio_url: !!audio_url, clips: (clips||[]).length, job_id: !!job_id }
    });
  }

  // Respond immediately
  const initialJob = { status: 'processing', job_id, started_at: new Date().toISOString() };
  saveJob(job_id, initialJob);
  res.json({ success: true, job_id, status: 'processing', message: 'Render started' });

  // Process in background
  renderVideo({ audio_url, clips, language, job_id }).catch(err => {
    console.error(`[${job_id}] Fatal error:`, err.message);
    saveJob(job_id, { status: 'error', job_id, error: err.message });
  });
});

async function renderVideo({ audio_url, clips, language, job_id }) {
  const workDir = `/tmp/${job_id}`;
  
  try {
    fs.mkdirSync(workDir, { recursive: true });
    console.log(`[${job_id}] Iniciando render...`);
    console.log(`[${job_id}] Clips: ${clips.length}, Audio: ${audio_url ? 'sim' : 'não'}`);

    // Download audio
    const audioPath = path.join(workDir, 'audio.mpga');
    console.log(`[${job_id}] Baixando áudio...`);
    await downloadFile(audio_url, audioPath);
    console.log(`[${job_id}] Áudio: ${fs.statSync(audioPath).size} bytes`);

    const audioDuration = getAudioDuration(audioPath);
    console.log(`[${job_id}] Duração: ${audioDuration}s`);

    // Download clips
    const clipPaths = [];
    for (let i = 0; i < Math.min(clips.length, 6); i++) {
      const clipPath = path.join(workDir, `clip_${i}.mp4`);
      try {
        await downloadFile(clips[i].url, clipPath);
        clipPaths.push({ path: clipPath, duration: clips[i].duration || 10 });
        console.log(`[${job_id}] Clip ${i+1} OK`);
      } catch(e) {
        console.error(`[${job_id}] Clip ${i} falhou:`, e.message);
      }
    }

    if (clipPaths.length === 0) throw new Error('Nenhum clip baixado');

    // Concat list
    const concatListPath = path.join(workDir, 'clips.txt');
    let concatContent = '';
    let totalDuration = 0;
    let idx = 0;
    while (totalDuration < audioDuration + 5 && idx < 50) {
      const clip = clipPaths[idx % clipPaths.length];
      concatContent += `file '${clip.path}'\n`;
      totalDuration += clip.duration;
      idx++;
    }
    fs.writeFileSync(concatListPath, concatContent);

    // Concatenate
    const rawVideoPath = path.join(workDir, 'raw.mp4');
    console.log(`[${job_id}] Concatenando...`);
    execSync(`ffmpeg -y -f concat -safe 0 -i "${concatListPath}" -c copy "${rawVideoPath}"`, { timeout: 120000 });

    // Merge
    const outputPath = path.join(workDir, 'output.mp4');
    console.log(`[${job_id}] Renderizando...`);
    execSync(
      `ffmpeg -y -i "${rawVideoPath}" -i "${audioPath}" ` +
      `-map 0:v:0 -map 1:a:0 ` +
      `-c:v libx264 -preset ultrafast -crf 35 ` +
      `-c:a aac -b:a 96k ` +
      `-t ${Math.min(audioDuration, 600)} ` +
      `-vf "scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2,setsar=1" ` +
      `-movflags +faststart "${outputPath}"`,
      { timeout: 600000 }
    );

    const videoSize = fs.statSync(outputPath).size;
    console.log(`[${job_id}] Vídeo: ${videoSize} bytes`);

    // Upload to Supabase
    const videoBuffer = fs.readFileSync(outputPath);
    const videoFileName = `${job_id}.mp4`;
    const uploadUrl = `${SUPABASE_URL}/storage/v1/object/facelessai-video/${videoFileName}`;
    
    console.log(`[${job_id}] Upload Supabase...`);
    await uploadToSupabase(uploadUrl, videoBuffer, SUPABASE_KEY);

    const videoUrl = `${SUPABASE_URL}/storage/v1/object/public/facelessai-video/${videoFileName}`;
    console.log(`[${job_id}] Concluído: ${videoUrl}`);

    saveJob(job_id, {
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
    saveJob(job_id, { status: 'error', job_id, error: error.message });
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch(e) {}
  }
}

function uploadToSupabase(url, buffer, key) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'video/mp4',
        'Content-Length': buffer.length,
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
    req.write(buffer);
    req.end();
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
    const output = execSync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${filePath}"`, { timeout: 10000 }).toString().trim();
    return parseFloat(output) || 600;
  } catch(e) { return 600; }
}

function getFfmpegVersion() {
  try { return execSync('ffmpeg -version 2>&1 | head -1').toString().trim(); }
  catch(e) { return 'not found'; }
}

app.listen(PORT, () => {
  console.log(`🎬 FacelessAI Render Server v3.1 na porta ${PORT}`);
  console.log(`FFmpeg: ${getFfmpegVersion()}`);
  console.log(`Supabase: ${SUPABASE_URL ? 'configurado' : 'NÃO configurado'}`);
});
