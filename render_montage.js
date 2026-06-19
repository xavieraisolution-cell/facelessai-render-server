const { execSync } = require('child_process');

/**
 * Gera um vídeo de montagem a partir de imagens estáticas com efeito Ken Burns
 * (zoom lento) + crossfade entre cenas, sincronizado com áudio de narração.
 *
 * LÓGICA VALIDADA: cada clipe é gerado com duração = duração_da_cena + transitionDuration.
 * Sem esse padding, o vídeo final termina ANTES do áudio acabar (testado: com 4 cenas
 * e crossfade de 0.8s, o vídeo ficava 2.49s mais curto que o áudio — proporcionalmente,
 * em 30 cenas isso vira ~23s de vídeo faltando no final).
 *
 * @param {Array<{image: string, duration: number}>} scenes - cada cena com caminho da imagem
 *   e duração em segundos (vem do tempo de fala da TTS daquele trecho de narração)
 * @param {string} audioFile - caminho do áudio de narração já gerado (TTS)
 * @param {string} outputFile - caminho do mp4 final
 * @param {object} opts - { transitionDuration=0.8, fps=25, size='1280x720', zoomRate=0.0012, maxZoom=1.15 }
 */
function gerarMontagem(scenes, audioFile, outputFile, opts = {}) {
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

  // 1. Gera cada clipe individual com zoompan, JÁ com o padding do crossfade somado
  const clipFiles = scenes.map((s, i) => {
    const out = `${tmpDir}/clip_${i}.mp4`;
    const paddedDuration = s.duration + transitionDuration;
    const cmd = `ffmpeg -y -loop 1 -framerate ${fps} -i "${s.image}" -vf "scale=3840:2160,zoompan=z='min(zoom+${zoomRate},${maxZoom})':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${size}:fps=${fps}" -t ${paddedDuration} -c:v libx264 -pix_fmt yuv420p "${out}"`;
    execSync(cmd, { stdio: ['ignore', 'ignore', 'ignore'] });
    return { file: out, duration: paddedDuration };
  });

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
  const cmd = `ffmpeg -y ${inputs} -i "${audioFile}" -filter_complex "${filter}" -map "[outv]" -map ${audioInputIndex}:a -c:v libx264 -c:a aac -pix_fmt yuv420p "${outputFile}"`;
  execSync(cmd, { stdio: ['ignore', 'ignore', 'ignore'] });

  // 4. Limpeza dos clipes temporários
  clipFiles.forEach(c => execSync(`rm -f "${c.file}"`));

  return { outputFile, videoDuration: cumulative };
}

module.exports = { gerarMontagem };
