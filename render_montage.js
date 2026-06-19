const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

/**
 * Gera um vídeo de montagem a partir de imagens estáticas com efeito Ken Burns
 * (zoom lento) + crossfade entre cenas, sincronizado com áudio de narração.
 *
 * IMPORTANTE: usa exec assíncrono (não execSync) de propósito. Com execSync,
 * o servidor Node fica 100% bloqueado durante todo o render (minutos, com 30
 * cenas) e não consegue responder NEM o /status NEM o /health — foi
 * exatamente isso que causou timeout no n8n no primeiro teste com 30 cenas
 * reais (o teste com 4 cenas era rápido demais pra revelar o problema).
 *
 * LÓGICA DE TIMING VALIDADA: cada clipe é gerado com duração = duração_da_cena + transitionDuration.
 * Sem esse padding, o vídeo final termina ANTES do áudio acabar.
 *
 * @param {Array<{image: string, duration: number}>} scenes - cada cena com caminho da imagem
 *   e duração em segundos (vem do tempo de fala da TTS daquele trecho de narração)
 * @param {string} audioFile - caminho do áudio de narração já gerado (TTS)
 * @param {string} outputFile - caminho do mp4 final
 * @param {object} opts - { transitionDuration=0.8, fps=25, size='1280x720', zoomRate=0.0012, maxZoom=1.15 }
 */
async function gerarMontagem(scenes, audioFile, outputFile, opts = {}) {
  const {
    transitionDuration = 0.8,
    fps = 25,
    size = '1280x720',
    zoomRate = 0.0012,
    maxZoom = 1.15,
    tmpDir = '/tmp',
  } = opts;

  if (scenes.length < 2) {
    throw new Error('Precisa de no mínimo 2 cenas pra ter crossfade. Com 1 cena, gera o clipe direto sem xfade.');
  }

  // 1. Gera cada clipe individual com zoompan, sequencialmente (não Promise.all —
  // 30 processos ffmpeg simultâneos sobrecarregariam a CPU do servidor de uma vez).
  // JÁ com o padding do crossfade somado na duração.
  const clipFiles = [];
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    const out = `${tmpDir}/clip_${i}.mp4`;
    const paddedDuration = s.duration + transitionDuration;
    const cmd = `ffmpeg -y -loop 1 -framerate ${fps} -i "${s.image}" -vf "scale=2560:1440,zoompan=z='min(zoom+${zoomRate},${maxZoom})':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${size}:fps=${fps}" -t ${paddedDuration} -c:v libx264 -pix_fmt yuv420p "${out}"`;
    await execAsync(cmd, { maxBuffer: 1024 * 1024 * 20 });
    clipFiles.push({ file: out, duration: paddedDuration });
  }

  // 2. Monta a cadeia de xfade dinamicamente (offset calculado cumulativamente)
  let filter = '';
  let cumulative = clipFiles[0].duration;
  let prevLabel = '0:v';

  for (let i = 1; i < clipFiles.length; i++) {
    const offset = cumulative - transitionDuration;
    const outLabel = i === clipFiles.length - 1 ? 'outv' : `v${i}`;
    filter += `[${prevLabel}][${i}:v]xfade=transition=fade:duration=${transitionDuration}:offset=${offset.toFixed(3)}[${outLabel}];`;
    cumulative = cumulative + clipFiles[i].duration - transitionDuration;
    prevLabel = outLabel;
  }
  filter = filter.slice(0, -1); // remove o ';' final

  // 3. Renderiza final: vídeo (chain de xfade) + áudio de narração
  const inputs = clipFiles.map(c => `-i "${c.file}"`).join(' ');
  const audioInputIndex = clipFiles.length;
  const finalCmd = `ffmpeg -y ${inputs} -i "${audioFile}" -filter_complex "${filter}" -map "[outv]" -map ${audioInputIndex}:a -c:v libx264 -c:a aac -pix_fmt yuv420p "${outputFile}"`;
  await execAsync(finalCmd, { maxBuffer: 1024 * 1024 * 20 });

  // 4. Limpeza dos clipes temporários
  for (const c of clipFiles) {
    try { await execAsync(`rm -f "${c.file}"`); } catch (e) { /* não crítico */ }
  }

  return { outputFile, videoDuration: cumulative };
}

module.exports = { gerarMontagem };
