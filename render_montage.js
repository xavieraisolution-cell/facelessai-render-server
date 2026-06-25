const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const EXEC_OPTS = { maxBuffer: 1024 * 1024 * 20 };

/**
 * Funde uma lista de clipes 2 a 2, em rodadas (árvore binária), até sobrar 1 só.
 * Cada chamada de ffmpeg processa só 2 streams pequenos por vez — nunca o vídeo
 * acumulado inteiro (diferente da versão sequencial anterior, que re-codificava
 * tudo que já tinha sido montado em cada passo, virando O(n²) de trabalho total).
 * Árvore binária: O(n log n), mesma vantagem de memória.
 */
async function mergeListInPairs(files, transitionDuration, tmpDir, label) {
  let current = files;
  let round = 0;

  while (current.length > 1) {
    const next = [];
    for (let i = 0; i < current.length; i += 2) {
      if (i + 1 >= current.length) {
        // número ímpar de itens nessa rodada — o último sobra sozinho pra próxima rodada
        next.push(current[i]);
        continue;
      }
      const a = current[i];
      const b = current[i + 1];
      const out = `${tmpDir}/${label}_r${round}_${i}.mp4`;
      const offset = a.duration - transitionDuration;
      const cmd = `ffmpeg -y -i "${a.file}" -i "${b.file}" -filter_complex "[0:v][1:v]xfade=transition=fade:duration=${transitionDuration}:offset=${offset.toFixed(3)}[outv]" -map "[outv]" -c:v libx264 -pix_fmt yuv420p "${out}"`;
      await execAsync(cmd, EXEC_OPTS);

      const newDuration = a.duration + b.duration - transitionDuration;
      next.push({ file: out, duration: newDuration });

      try { await execAsync(`rm -f "${a.file}" "${b.file}"`); } catch (e) { /* não crítico */ }
    }
    current = next;
    round++;
  }

  return current[0];
}

/**
 * Gera um vídeo de montagem a partir de imagens estáticas com efeito Ken Burns
 * (zoom lento) + crossfade entre cenas, sincronizado com áudio de narração.
 *
 * HISTÓRICO DE BUGS JÁ CORRIGIDOS NESSE ARQUIVO (não reintroduzir):
 * 1. execSync bloqueava o servidor inteiro durante o render -> exec assíncrono.
 * 2. Sem padding de duração, vídeo terminava antes do áudio -> cada clipe ganha
 *    +transitionDuration de duração antes do xfade "comer" essa sobra.
 * 3. Um único filtro xfade com N streams simultâneos causava OOM (Render reportou
 *    "Ran out of memory, used over 2GB") a partir de ~20-30 cenas -> fusão 2 a 2.
 * 4. Fusão 2 a 2 SEQUENCIAL (sempre fundindo no acumulado inteiro) resolvia a
 *    memória mas virava O(n²) de tempo total (cada passo re-codifica tudo que já
 *    foi montado) -> trocado por fusão em ÁRVORE BINÁRIA (mergeListInPairs acima),
 *    O(n log n), mesma vantagem de memória sem o custo de tempo.
 * 5. zoompan com d=1 NUNCA anima de verdade (testado empiricamente: diff de pixel
 *    entre frame inicial e final ~0, mesmo com zoomRate alto) -> d precisa ser o
 *    número TOTAL de frames do clipe (duração × fps), calculado por cena.
 *
 * @param {Array<{image: string, duration: number}>} scenes
 * @param {string} audioFile
 * @param {string} outputFile
 * @param {object} opts - { transitionDuration=0.8, fps=25, size='1080x1920', zoomRate=0.0012, maxZoom=1.15 }
 */
async function gerarMontagem(scenes, audioFile, outputFile, opts = {}) {
  const {
    transitionDuration = 0.8,
    fps = 25,
    size = '1080x1920', // vertical 9:16 -- necessário pra classificação automática como YouTube Short (vídeos horizontais nunca qualificam, independente da duração) e compatível sem reencode com TikTok/Instagram Reels/Facebook Reels
    zoomRate = 0.0012,
    maxZoom = 1.15,
    tmpDir = '/tmp',
  } = opts;

  if (scenes.length < 2) {
    throw new Error('Precisa de no mínimo 2 cenas pra ter crossfade. Com 1 cena, gera o clipe direto sem xfade.');
  }

  // 1. Gera cada clipe individual com zoompan, sequencialmente.
  const [outW, outH] = size.split('x').map(Number);
  // Resolução intermediária maior, mantendo o MESMO aspect ratio do size final, antes do zoompan reduzir.
  // Antes era fixa em 2560x1440 (16:9) -- com size vertical (9:16) isso distorcia a imagem, porque o zoompan
  // redimensiona pra `s=` sem preservar aspect ratio sozinho. Múltiplo de 2x dá margem pro zoom sem perder nitidez.
  const upscaleW = outW * 2;
  const upscaleH = outH * 2;
  const clipFiles = [];
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    const out = `${tmpDir}/clip_${i}.mp4`;
    const paddedDuration = s.duration + transitionDuration;
    const totalFrames = Math.round(paddedDuration * fps); // zoompan precisa de d = total de frames do clipe pra animar de verdade — d=1 NÃO anima (testado e confirmado, ver nota no topo do arquivo)
    const cmd = `ffmpeg -y -loop 1 -framerate ${fps} -i "${s.image}" -vf "scale=${upscaleW}:${upscaleH}:force_original_aspect_ratio=increase,crop=${upscaleW}:${upscaleH},zoompan=z='min(zoom+${zoomRate},${maxZoom})':d=${totalFrames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${size}:fps=${fps}" -t ${paddedDuration} -c:v libx264 -pix_fmt yuv420p "${out}"`;
    await execAsync(cmd, EXEC_OPTS);
    clipFiles.push({ file: out, duration: paddedDuration });
  }

  // 2. Funde em árvore binária (rápido e com memória limitada)
  const merged = await mergeListInPairs(clipFiles, transitionDuration, tmpDir, 'merge');

  // 3. Mux com o áudio de narração (copy de vídeo — já está codificado)
  const finalCmd = `ffmpeg -y -i "${merged.file}" -i "${audioFile}" -map 0:v -map 1:a -c:v copy -c:a aac "${outputFile}"`;
  await execAsync(finalCmd, EXEC_OPTS);

  try { await execAsync(`rm -f "${merged.file}"`); } catch (e) { /* não crítico */ }

  return { outputFile, videoDuration: merged.duration };
}

module.exports = { gerarMontagem };
