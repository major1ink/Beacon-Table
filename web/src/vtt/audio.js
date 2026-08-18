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
  let lastCueUrl = null;
  let lastCueStartedAt = null;

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

  // seekToStart выставляет currentTime по разнице между "сейчас" и моментом
  // старта трека на сервере, дождавшись метаданных (иначе duration ещё 0 и
  // не от чего взять остаток по модулю для зацикленных треков).
  function seekToStart(audioEl, startedAtMs, loop) {
    const apply = () => {
      const elapsed = Math.max(0, (ctx.now() - startedAtMs) / 1000);
      if (loop && audioEl.duration > 0) {
        audioEl.currentTime = elapsed % audioEl.duration;
      } else {
        audioEl.currentTime = audioEl.duration > 0 ? Math.min(elapsed, audioEl.duration) : elapsed;
      }
      tryPlay(audioEl);
    };
    if (audioEl.readyState >= 1 /* HAVE_METADATA */) apply();
    else audioEl.addEventListener("loadedmetadata", apply, { once: true });
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
  // broadcastCue). cue===null значит канал ДМ сейчас молчит.
  function applyCue(cue) {
    lastCueVolume = cue ? cue.volume : lastCueVolume;
    cueAudio.volume = cue ? Math.max(0, Math.min(1, cue.volume * localCueVol)) : 0;
    const url = cue ? cue.url : null;
    const startedAtMs = cue ? cue.startedAtMs : null;
    document.dispatchEvent(new CustomEvent("vtt:cueChanged", { detail: cue }));
    if (url === lastCueUrl && startedAtMs === lastCueStartedAt) return;
    lastCueUrl = url;
    lastCueStartedAt = startedAtMs;
    if (!cue) {
      cueAudio.pause();
      cueAudio.removeAttribute("src");
      return;
    }
    cueAudio.loop = !!cue.loop;
    cueAudio.src = cue.url;
    seekToStart(cueAudio, startedAtMs, !!cue.loop);
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
  const ambientVolSlider = addVolumeRow(icon("music", { size: 13 }), "Сцена", "Громкость музыки сцены — только у тебя, на других клиентов не влияет");
  const cueVolSlider = addVolumeRow(icon("headphones", { size: 13 }), "ДМ", "Громкость канала ДМ (плейлисты) — только у тебя");
  ambientVolSlider.value = Math.round(localAmbientVol * 100);
  cueVolSlider.value = Math.round(localCueVol * 100);
  ambientVolSlider.oninput = () => {
    localAmbientVol = ambientVolSlider.value / 100;
    localStorage.setItem(LOCAL_VOL_KEY_AMBIENT, localAmbientVol);
    ambientAudio.volume = Math.max(0, Math.min(1, (ctx.scene.ambientVolume || 0) * localAmbientVol));
  };
  cueVolSlider.oninput = () => {
    localCueVol = cueVolSlider.value / 100;
    localStorage.setItem(LOCAL_VOL_KEY_CUE, localCueVol);
    cueAudio.volume = Math.max(0, Math.min(1, lastCueVolume * localCueVol));
  };

  return { ambientAudio, cueAudio, applyAmbient, applyCue };
}
