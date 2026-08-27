// Перенос inline-скрипта static/tv.html (переименован в broadcast.html —
// "трансляция" точнее описывает назначение экрана, чем сокращение "tv", см.
// README). initVTT остаётся async (PIXI.Application.init() в v8 — промис),
// но результат странице не нужен — вызов "выстрелил и забыл".
import { initVTT } from "../vtt/index.js";
import { initShowcaseOverlay } from "../showcase-overlay.js";

initVTT({ canvasId: "scene", role: "tv" });

// Картинка «Показать игрокам» от ДМ — полноэкранный оверлей поверх карты
// (см. web/src/showcase-overlay.js). На трансляции закрыть нельзя, показом
// управляет ДМ.
initShowcaseOverlay({ role: "tv" });

// ---- HUD зума/полноэкранного режима — те же события vtt:zoomBy/vtt:resetView,
// что и у ДМ (см. web/src/pages/dm.js), их слушает web/src/vtt/interaction.js
// одинаково для всех трёх ролей. Средняя кнопка тут отдельная от "сброса
// камеры" — настоящий Fullscreen API, потому что на ТВ/проекторе "на весь
// экран" означает "спрятать всё, кроме картинки", а не просто вписать карту
// в окно браузера.
document.getElementById("zoomInBtn").onclick = () => document.dispatchEvent(new CustomEvent("vtt:zoomBy", { detail: 1.3 }));
document.getElementById("zoomOutBtn").onclick = () => document.dispatchEvent(new CustomEvent("vtt:zoomBy", { detail: 1 / 1.3 }));

const fullscreenBtn = document.getElementById("fullscreenBtn");
fullscreenBtn.onclick = () => {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else {
    document.documentElement.requestFullscreen().catch(() => {});
  }
};
document.addEventListener("fullscreenchange", () => {
  fullscreenBtn.classList.toggle("active", !!document.fullscreenElement);
});
