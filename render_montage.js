const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const EXEC_OPTS = { maxBuffer: 1024 * 1024 * 20 };

/**
 * Gera um vídeo de montagem a partir de imagens estáticas com efeito Ken Burns
 * (zoom lento) + crossfade entre cenas, sincronizado com áudio de narração.
 *
 * HISTÓRICO DE BUGS JÁ CORRIGIDOS NESSE ARQUIVO (não reintroduzir):
 * 1. execSync bloqueava o servidor inteiro durante o render -> trocado por exec assíncrono.
 * 2. Sem padding de duração, vídeo terminava antes do áudio -> cada clipe ganha
 *    +transitionDuration de duração antes do xfade "comer" essa sobra.
 * 3. Um único filtro xfade com N streams simultâneos (todas as cenas de uma vez)
 *    causava "Ran out of memory (used over 2GB)" no Render a partir de ~20-30 cenas.
 *    Corrigido fundindo os clipes 2 a 2, sequencialmente — nunca mais que 2 streams
 *    de vídeo decodificados ao mesmo tempo, independente de quantas cenas existam.
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

  // 1. Gera cada clipe individual com zoompan, sequencialmente.
  // JÁ com o padding do crossfade somado na duração.
  const clipFiles = [];
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    const out = `${tmpDir}/clip_${i}.mp4`;
    const paddedDuration = s.duration + transitionDuration;
    const cmd = `ffmpeg -y -loop 1 -framerate ${fps} -i "${s.image}" -vf "scale=2560:1440,zoompan=z='min(zoom+${zoomRate},${maxZoom})':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${size}:fps=${fps}" -t ${paddedDuration} -c:v libx264 -pix_fmt yuv420p "${out}"`;
    await execAsync(cmd, EXEC_OPTS);
    clipFiles.push({ file: out, duration: paddedDuration });
  }

  // 2. Funde os clipes DOIS A DOIS, sequencialmente (não 1 filtro com N entradas).
  // Cada chamada de ffmpeg aqui só abre 2 streams de vídeo por vez — memória
  // não escala com o número total de cenas, só com a duração acumulada.
  let mergedFile = clipFiles[0].file;
  let mergedDuration = clipFiles[0].duration;

  for (let i = 1; i < clipFiles.length; i++) {
    const nextOut = `${tmpDir}/merged_${i}.mp4`;
    const offset = mergedDuration - transitionDuration;
    const cmd = `ffmpeg -y -i "${mergedFile}" -i "${clipFiles[i].file}" -filter_complex "[0:v][1:v]xfade=transition=fade:duration=${transitionDuration}:offset=${offset.toFixed(3)}[outv]" -map "[outv]" -c:v libx264 -pix_fmt yuv420p "${nextOut}"`;
    await execAsync(cmd, EXEC_OPTS);

    if (mergedFile !== clipFiles[0].file) {
      try { await execAsync(`rm -f "${mergedFile}"`); } catch (e) { /* não crítico */ }
    }

    mergedDuration = mergedDuration + clipFiles[i].duration - transitionDuration;
    mergedFile = nextOut;
  }

  // 3. Mux com o áudio de narração (copy de vídeo — já está codificado, não reprocessa)
  const finalCmd = `ffmpeg -y -i "${mergedFile}" -i "${audioFile}" -map 0:v -map 1:a -c:v copy -c:a aac "${outputFile}"`;
  await execAsync(finalCmd, EXEC_OPTS);

  // 4. Limpeza
  for (const c of clipFiles) {
    try { await execAsync(`rm -f "${c.file}"`); } catch (e) { /* não crítico */ }
  }
  try { await execAsync(`rm -f "${mergedFile}"`); } catch (e) { /* não crítico */ }

  return { outputFile, videoDuration: mergedDuration };
}

module.exports = { gerarMontagem };
