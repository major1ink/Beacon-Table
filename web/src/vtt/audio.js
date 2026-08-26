// Аудио: амбиент сцены + канал ДМ (cue). Перенесено из static/js/app.js
// почти без изменений — это обычные DOM <audio> элементы и математика
// синхронизации по timestamp'ам, никакого отношения к canvas/WebGL-рендеру
// не имеющая, так что переезд на PixiJS её не касается.
//
// Оба канала слышат все три роли. Синхронизация — по времени старта
// (startedAtMs из snapshot/audio_cue), не по стриму позиции: клиент сам
// считает смещение от Date.now() (через ctx.now(), с поправкой на рассинхрон
// часов клиент/сервер — см. net.js: clockOffsetMs), поэтому подключившийся
// позже слышит тот же момент трека, что и остальные, без лишнего WS-трафика.
// Громкость — источник один (то, что задал ДМ), но у каждого клиента
// локальный множитель поверх (localStorage, не шлётся по сети).
import { icon } from "../icons.js";

const LOCAL_VOL_KEY_AMBIENT = "beacon-vol-ambient";
const LOCAL_VOL_KEY_CUE = "beacon-vol-cue";

function readLocalVol(key) {
  const v = parseFloat(localStorage.getItem(key));
  return isNaN(v) ? 1 : Math.max(0, Math.min(1, v));
}

// createAudio — заводит оба канала + всплывающую кнопку "Включить звук" +
// иконку громкости в общей боковой колонке (sideMenu, см. side-menu.js — та
// же колонка, куда pages/dm.js вешает соседнюю иконку кубов). ctx получает:
// audioUnlocked (bool), showUnlockPrompt()/tryPlay()/registerUnlockable() —
// видео-слои (фон карты, токены) регистрируют через registerUnlockable свои
// <video>-элементы, чтобы один клик по кнопке разблокировал звук сразу
// everywhere (то же ограничение браузера — per-page, не per-элемент).
export function createAudio(ctx, sideMenu) {
  const ambientAudio = new Audio();
  ambientAudio.loop = true; // амбиент сцены всегда зациклен, по требованию
  const cueAudio = new Audio(); // канал ДМ — loop берётся из CueState.Loop, см. applyCue

  let localAmbientVol = readLocalVol(LOCAL_VOL_KEY_AMBIENT);
  let localCueVol = readLocalVol(LOCAL_VOL_KEY_CUE);
  let lastCueVolume = 0.8; // последняя громкость канала ДМ, заданная сервером

  let lastAmbientUrl = null;
  let lastAmbientStartedAt = null;
  // lastCueUrl — только чтобы не дёргать cueAudio.src, когда файл не
  // менялся (пауза/сик/резюм того же трека): даже присвоение ТОГО ЖЕ URL
  // заставляет браузер перечитать источник заново, со щелчком в звуке.
  let lastCueUrl = null;
  // lastCueSig — "во что уже переставили" (url+startedAtMs+paused+position),
  // см. applyCue: снапшоты канала ДМ летят на каждый чих (как и у амбиента),
  // пересчитывать currentTime есть смысл только когда реально что-то из
  // этого сдвинулось.
  let lastCueSig = null;

  ctx.audioUnlocked = false;
  const unlockables = []; // <video>/<audio> элементы других слоёв (фон карты, токены)

  function tryPlay(audioEl) {
    if (!audioEl.src) return;
    const p = audioEl.play();
    if (p && p.catch) p.catch(() => showUnlockPrompt());
  }
  ctx.tryPlay = tryPlay;

  let unlockBtn = null;
  function showUnlockPrompt() {
    if (unlockBtn || ctx.audioUnlocked) return;
    unlockBtn = document.createElement("button");
    unlockBtn.innerHTML = icon("volume", { size: 15 }) + " Включить звук";
    unlockBtn.style.cssText =
      "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:9999;" +
      "display:flex;align-items:center;gap:8px;" +
      "padding:10px 18px;border:none;border-radius:999px;background:#1f6b3a;color:#fff;" +
      "font:14px sans-serif;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,0.5);";
    unlockBtn.onclick = () => {
      ctx.audioUnlocked = true;
      tryPlay(ambientAudio);
      tryPlay(cueAudio);
      for (const el of unlockables) {
        el.muted = false;
        tryPlay(el);
      }
      unlockBtn.remove();
      unlockBtn = null;
    };
    document.body.appendChild(unlockBtn);
  }
  ctx.showUnlockPrompt = showUnlockPrompt;

  ctx.registerUnlockable = (el) => {
    unlockables.push(el);
    if (ctx.audioUnlocked) {
      el.muted = false;
      tryPlay(el);
    }
  };

  // seekTo — общая механика: выставить currentTime (в секундах, с учётом
  // Loop по модулю длительности) и либо заиграть, либо оставить на паузе,
  // дождавшись метаданных (иначе duration ещё 0 и не от чего взять остаток
  // по модулю для зацикленных треков).
  function seekTo(audioEl, positionSec, loop, play) {
    const apply = () => {
      if (loop && audioEl.duration > 0) {
        audioEl.currentTime = positionSec % audioEl.duration;
      } else {
        audioEl.currentTime = audioEl.duration > 0 ? Math.min(positionSec, audioEl.duration) : positionSec;
      }
      if (play) tryPlay(audioEl);
      else audioEl.pause();
    };
    if (audioEl.readyState >= 1 /* HAVE_METADATA */) apply();
    else audioEl.addEventListener("loadedmetadata", apply, { once: true });
  }

  // seekToStart выставляет currentTime по разнице между "сейчас" и моментом
  // старта трека на сервере и заигрывает — частный случай seekTo для
  // "обычного" (не на паузе) воспроизведения. Экспортирована наружу —
  // background.js синхронизирует по ней зацикленное mp4-фото сцены тем же
  // приёмом, что и амбиент/канал ДМ здесь.
  function seekToStart(audioEl, startedAtMs, loop) {
    const elapsed = Math.max(0, (ctx.now() - startedAtMs) / 1000);
    seekTo(audioEl, elapsed, loop, true);
  }
  ctx.seekToStart = seekToStart;

  // applyAmbient — реагирует на снапшот. Громкость обновляется всегда
  // (дёшево, не требует рестарта), а сам трек перезагружается/перематывается
  // только если реально сменился URL или момент старта — снапшоты летят на
  // каждый чих (вплоть до драга токена), нельзя дёргать плеер на каждый из них.
  function applyAmbient(url, startedAtMs, volume) {
    ambientAudio.volume = Math.max(0, Math.min(1, (volume || 0) * localAmbientVol));
    if (url === lastAmbientUrl && startedAtMs === lastAmbientStartedAt) return;
    lastAmbientUrl = url;
    lastAmbientStartedAt = startedAtMs;
    if (!url) {
      ambientAudio.pause();
      ambientAudio.removeAttribute("src");
      return;
    }
    ambientAudio.src = url;
    seekToStart(ambientAudio, startedAtMs, true);
  }

  // applyCue — реакция на "audio_cue" (см. internal/service/room.go:
  // broadcastCue). cue===null значит канал ДМ сейчас молчит. cue.paused —
  // пауза (см. pause_cue/resume_cue): позиция заморожена в cue.positionMs,
  // а не считается по cue.startedAtMs (см. domain.CueState).
  function applyCue(cue) {
    lastCueVolume = cue ? cue.volume : lastCueVolume;
    cueAudio.volume = cue ? Math.max(0, Math.min(1, cue.volume * localCueVol)) : 0;
    // Loop — как и громкость выше, применяем сразу и безусловно, а не только
    // при пересчёте позиции ниже: ДМ может переключить "зациклен" прямо у
    // играющего трека (см. dm.js: loopBtn/openTrackModal → set_cue_loop), и
    // это не должно ждать следующего реального рестарта/сика, чтобы
    // долететь до уже играющего <audio> — иначе трек доигрывает со старым
    // флагом и на конце останавливается/уходит на следующий вместо цикла.
    if (cue) cueAudio.loop = !!cue.loop;
    document.dispatchEvent(new CustomEvent("vtt:cueChanged", { detail: cue }));

    // Сигнатура — url+startedAtMs+paused+positionMs: любое из них сдвинулось —
    // значит реально нужно перемотать/переиграть. Loop сюда намеренно не
    // входит — применяется отдельно, выше, без рестарта позиции.
    const sig = cue ? `${cue.url}|${cue.startedAtMs}|${!!cue.paused}|${cue.positionMs || 0}` : null;
    if (sig === lastCueSig) return;
    lastCueSig = sig;

    if (!cue) {
      lastCueUrl = null;
      cueAudio.pause();
      cueAudio.removeAttribute("src");
      return;
    }
    // Присваивание cueAudio.src ТОМУ ЖЕ значению всё равно перезапускает
    // буферизацию (щелчок в звуке) — переприсваиваем, только если файл
    // реально сменился, а не просто пауза/сик/резюм/переключение лупа того
    // же трека.
    if (cue.url !== lastCueUrl) {
      lastCueUrl = cue.url;
      cueAudio.src = cue.url;
    }
    if (cue.paused) {
      seekTo(cueAudio, (cue.positionMs || 0) / 1000, !!cue.loop, false);
    } else {
      seekToStart(cueAudio, cue.startedAtMs, !!cue.loop);
    }
  }

  // ---- иконка громкости в общей боковой колонке ----
  // Колонку (позиционирование у правого края канваса, клик-панели вместо
  // hover) заводит sideMenu — см. side-menu.js. Кубы (pages/dm.js) вешают
  // туда же СВОЮ отдельную иконку 🎲, а не встраиваются в эту панель.
  const volumePanel = sideMenu.addIcon(icon("volume", { size: 16 }), "Громкость");

  function addVolumeRow(iconHtml, label, title) {
    const row = document.createElement("label");
    row.style.cssText = "display:flex;align-items:center;gap:7px;font:12px sans-serif;color:#eee;white-space:nowrap;";
    row.title = title;
    row.innerHTML =
      `<span style="flex:0 0 auto;opacity:0.85;display:inline-flex;align-items:center;gap:5px;">${iconHtml} ${label}</span>` +
      '<input type="range" min="0" max="100" style="flex:1 1 auto;min-width:0;">';
    volumePanel.appendChild(row);
    return row.querySelector("input");
  }
  const ambientVolSlider = addVolumeRow(icon("music", { size: 13 }), "Сцена", "Громкость сцены — амбиент-трек и звук видео-фона карты, только у тебя, на других клиентов не влияет");
  const cueVolSlider = addVolumeRow(icon("headphones", { size: 13 }), "ДМ", "Громкость канала ДМ (плейлисты) — только у тебя");
  ambientVolSlider.value = Math.round(localAmbientVol * 100);
  cueVolSlider.value = Math.round(localCueVol * 100);
  ctx.localAmbientVol = localAmbientVol;
  ambientVolSlider.oninput = () => {
    localAmbientVol = ambientVolSlider.value / 100;
    localStorage.setItem(LOCAL_VOL_KEY_AMBIENT, localAmbientVol);
    ambientAudio.volume = Math.max(0, Math.min(1, (ctx.scene.ambientVolume || 0) * localAmbientVol));
    ctx.localAmbientVol = localAmbientVol;
    document.dispatchEvent(new CustomEvent("vtt:ambientLocalVolChanged", { detail: localAmbientVol }));
  };
  cueVolSlider.oninput = () => {
    localCueVol = cueVolSlider.value / 100;
    localStorage.setItem(LOCAL_VOL_KEY_CUE, localCueVol);
    cueAudio.volume = Math.max(0, Math.min(1, lastCueVolume * localCueVol));
  };

  return { ambientAudio, cueAudio, applyAmbient, applyCue };
}
