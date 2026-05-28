const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const AUTH_KEY = process.env.AUTH_KEY || 'facelessai2026xaviersecretkey32x';
const UPLOAD_DIR = '/tmp/faceless_renders';

// Garante que o diretório de upload existe
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Middleware de autenticação
app.use((req, res, next) => {
  const auth = req.headers['authorization'];
  if (!auth || auth !== `Bearer ${AUTH_KEY}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'FacelessAI Render Server' });
});

// Função para baixar arquivo
async function downloadFile(url, destPath) {
  const response = await axios({ url, responseType: 'stream' });
  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destPath);
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

// Rota principal de render
app.post('/render', async (req, res) => {
  const jobId = req.body.job_id || `job_${Date.now()}`;
  const jobDir = path.join(UPLOAD_DIR, jobId);

  try {
    fs.mkdirSync(jobDir, { recursive: true });

    const {
      audio_url,
      clips = [],
      subtitle_text = '',
      output_resolution = '1920x1080',
      thumbnail_text = ''
    } = req.body;

    console.log(`[${jobId}] Iniciando render...`);
    console.log(`[${jobId}] Clips: ${clips.length}, Audio: ${audio_url ? 'sim' : 'não'}`);

    // Baixa o áudio se disponível
    let audioPath = null;
    if (audio_url && audio_url !== 'PENDING') {
      audioPath = path.join(jobDir, 'audio.mp3');
      console.log(`[${jobId}] Baixando áudio...`);
      await downloadFile(audio_url, audioPath);
    }

    // Baixa os vídeos
    const videoPaths = [];
    for (let i = 0; i < Math.min(clips.length, 6); i++) {
      const clip = clips[i];
      const videoUrl = clip.url || clip;
      if (!videoUrl) continue;
      const videoPath = path.join(jobDir, `clip_${i}.mp4`);
      console.log(`[${jobId}] Baixando clip ${i + 1}...`);
      try {
        await downloadFile(videoUrl, videoPath);
        videoPaths.push(videoPath);
      } catch (e) {
        console.error(`[${jobId}] Erro ao baixar clip ${i}: ${e.message}`);
      }
    }

    if (videoPaths.length === 0) {
      return res.status(400).json({ error: 'Nenhum clip de vídeo disponível' });
    }

    // Cria arquivo de lista para concatenação
    const listFile = path.join(jobDir, 'clips.txt');
    const listContent = videoPaths.map(p => `file '${p}'`).join('\n');
    fs.writeFileSync(listFile, listContent);

    const concatVideo = path.join(jobDir, 'concat.mp4');
    const outputVideo = path.join(jobDir, 'output.mp4');

    // Concatena os vídeos
    console.log(`[${jobId}] Concatenando vídeos...`);
    await execAsync(
      `ffmpeg -y -f concat -safe 0 -i "${listFile}" -c:v libx264 -preset fast -crf 23 -an "${concatVideo}"`
    );

    // Monta o vídeo final com ou sem áudio
    if (audioPath) {
      console.log(`[${jobId}] Adicionando áudio...`);
      await execAsync(
        `ffmpeg -y -i "${concatVideo}" -i "${audioPath}" -c:v copy -c:a aac -shortest "${outputVideo}"`
      );
    } else {
      fs.copyFileSync(concatVideo, outputVideo);
    }

    console.log(`[${jobId}] Render concluído!`);

    // Lê o arquivo final e retorna como base64 (para testes)
    // Em produção, faria upload para S3/Cloudinary/Supabase Storage
    const videoBase64 = fs.readFileSync(outputVideo).toString('base64');
    const videoSize = fs.statSync(outputVideo).size;

    // Limpa arquivos temporários
    setTimeout(() => {
      try { fs.rmSync(jobDir, { recursive: true }); } catch (e) {}
    }, 60000);

    res.json({
      success: true,
      job_id: jobId,
      video_size: videoSize,
      video_base64: videoBase64,
      message: 'Render concluído com sucesso'
    });

  } catch (error) {
    console.error(`[${jobId}] Erro:`, error.message);
    try { fs.rmSync(jobDir, { recursive: true }); } catch (e) {}
    res.status(500).json({
      error: error.message,
      job_id: jobId
    });
  }
});

app.listen(PORT, () => {
  console.log(`FacelessAI Render Server rodando na porta ${PORT}`);
});
