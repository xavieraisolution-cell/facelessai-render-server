const express = require('express');
const { execSync, exec } = require('child_process');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  global: {
    WebSocket: ws
  }
});
// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'FacelessAI FFmpeg Render Server',
    version: '1.0.0',
    ffmpeg: getFfmpegVersion()
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Main render endpoint
app.post('/render', async (req, res) => {
  const { audio_url, clips, language, job_id } = req.body;

  if (!audio_url || !clips || !job_id) {
    return res.status(400).json({ error: 'Missing required fields: audio_url, clips, job_id' });
  }

  console.log(`[Render] Starting job: ${job_id}`);
  console.log(`[Render] Audio: ${audio_url}`);
  console.log(`[Render] Clips: ${clips.length}`);
  console.log(`[Render] Language: ${language}`);

  const workDir = `/tmp/${job_id}`;
  
  try {
    // Create work directory
    fs.mkdirSync(workDir, { recursive: true });

    // Step 1: Download audio
    console.log('[Render] Downloading audio...');
    const audioPath = path.join(workDir, 'audio.mpga');
    await downloadFile(audio_url, audioPath);
    console.log('[Render] Audio downloaded:', fs.statSync(audioPath).size, 'bytes');

    // Step 2: Get audio duration
    const audioDuration = getAudioDuration(audioPath);
    console.log('[Render] Audio duration:', audioDuration, 'seconds');

    // Step 3: Download video clips
    console.log('[Render] Downloading video clips...');
    const clipPaths = [];
    for (let i = 0; i < Math.min(clips.length, 6); i++) {
      const clipPath = path.join(workDir, `clip_${i}.mp4`);
      try {
        await downloadFile(clips[i].url, clipPath);
        clipPaths.push({ path: clipPath, duration: clips[i].duration || 10 });
        console.log(`[Render] Clip ${i + 1} downloaded`);
      } catch (e) {
        console.error(`[Render] Failed to download clip ${i}:`, e.message);
      }
    }

    if (clipPaths.length === 0) {
      throw new Error('No video clips downloaded');
    }

    // Step 4: Create video concat list
    const concatListPath = path.join(workDir, 'clips.txt');
    let concatContent = '';
    let totalClipDuration = 0;
    
    // Loop clips to match audio duration
    let clipIndex = 0;
    while (totalClipDuration < audioDuration + 5) {
      const clip = clipPaths[clipIndex % clipPaths.length];
      concatContent += `file '${clip.path}'\n`;
      totalClipDuration += clip.duration;
      clipIndex++;
      if (clipIndex > 50) break; // Safety limit
    }
    
    fs.writeFileSync(concatListPath, concatContent);
    console.log('[Render] Concat list created, total clip duration:', totalClipDuration);

    // Step 5: Concatenate clips
    const rawVideoPath = path.join(workDir, 'raw_video.mp4');
    console.log('[Render] Concatenating clips...');
    execSync(`ffmpeg -y -f concat -safe 0 -i "${concatListPath}" -c copy "${rawVideoPath}" 2>&1`, {
      timeout: 120000
    });

    // Step 6: Merge audio + video + trim to audio length
    const outputPath = path.join(workDir, 'output.mp4');
    console.log('[Render] Merging audio and video...');
    execSync(
      `ffmpeg -y -i "${rawVideoPath}" -i "${audioPath}" ` +
      `-map 0:v:0 -map 1:a:0 ` +
      `-c:v libx264 -preset fast -crf 23 ` +
      `-c:a aac -b:a 192k ` +
      `-t ${audioDuration} ` +
      `-vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1" ` +
      `-movflags +faststart ` +
      `"${outputPath}" 2>&1`,
      { timeout: 300000 }
    );

    console.log('[Render] Video rendered:', fs.statSync(outputPath).size, 'bytes');

    // Step 7: Upload to Supabase
    console.log('[Render] Uploading to Supabase...');
    const videoBuffer = fs.readFileSync(outputPath);
    const videoFileName = `${job_id}.mp4`;

    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('facelessai-videos')
      .upload(videoFileName, videoBuffer, {
        contentType: 'video/mp4',
        upsert: true
      });

    if (uploadError) throw new Error(`Supabase upload failed: ${uploadError.message}`);

    // Get public URL
    const { data: urlData } = supabase.storage
      .from('facelessai-videos')
      .getPublicUrl(videoFileName);

    const videoUrl = urlData.publicUrl;
    console.log('[Render] Video uploaded:', videoUrl);

    // Cleanup
    fs.rmSync(workDir, { recursive: true, force: true });
    console.log('[Render] Cleanup done');

    res.json({
      success: true,
      job_id,
      video_url: videoUrl,
      duration: audioDuration,
      message: 'Video rendered and uploaded successfully'
    });

  } catch (error) {
    console.error('[Render] Error:', error.message);
    
    // Cleanup on error
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch(e) {}
    
    res.status(500).json({
      success: false,
      job_id,
      error: error.message
    });
  }
});

// Helper: Download file
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const protocol = url.startsWith('https') ? https : http;
    
    const request = protocol.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        return downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode} for ${url}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    });
    
    request.on('error', (err) => { fs.unlink(destPath, () => {}); reject(err); });
    request.setTimeout(60000, () => { request.destroy(); reject(new Error('Download timeout')); });
  });
}

// Helper: Get audio duration
function getAudioDuration(filePath) {
  try {
    const output = execSync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${filePath}"`,
      { timeout: 10000 }
    ).toString().trim();
    return parseFloat(output) || 600;
  } catch (e) {
    console.error('Failed to get duration:', e.message);
    return 600;
  }
}

// Helper: Get FFmpeg version
function getFfmpegVersion() {
  try {
    return execSync('ffmpeg -version 2>&1 | head -1').toString().trim();
  } catch(e) {
    return 'not found';
  }
}

app.listen(PORT, () => {
  console.log(`🎬 FacelessAI Render Server running on port ${PORT}`);
  console.log(`FFmpeg: ${getFfmpegVersion()}`);
});
