// Перенос inline-скрипта static/tv.html (переименован в broadcast.html —
// "трансляция" точнее описывает назначение экрана, чем сокращение "tv", см.
// README). initVTT остаётся async (PIXI.Application.init() в v8 — промис),
// но результат странице не нужен — вызов "выстрелил и забыл".
import { initVTT } from "../vtt/index.js";
import { initShowcaseOverlay } from "../showcase-overlay.js";
import { broadcastAccessGranted, requestBroadcastAccess, broadcastRequestState } from "../api.js";

// Экран трансляции работает без аккаунта — вместо него ключ трансляции (см.
// internal/service/broadcast.go). Попасть к нему можно двумя путями:
//
//  1. ссылка с ключом — её сервер меняет на cookie ещё до загрузки страницы
//     (см. apihttp.API.BroadcastEntry); годится, когда есть чем открыть
//     ссылку: телефон, ноутбук, второе окно ДМ;
//  2. подтверждение с пульта — этот файл: экран показывает четыре знака и
//     ждёт, пока ДМ нажмёт «Пустить» у себя в «Настройках». Ради него всё и
//     затевалось: длинную ссылку с ключом на телевизоре не набрать.
//
// Проверка в async-функции, а не через top-level await: сборка идёт под
// browserslist-цель Vite, где TLA поддержан не везде (см. web/vite.config.js).
boot();

async function boot() {
  if (await broadcastAccessGranted()) {
    startTable();
    return;
  }
  await waitForApproval();
}

function startTable() {
  initVTT({ canvasId: "scene", role: "tv" });

  // Картинка «Показать игрокам» от ДМ — полноэкранный оверлей поверх карты
  // (см. web/src/showcase-overlay.js). На трансляции закрыть нельзя, показом
  // управляет ДМ.
  initShowcaseOverlay({ role: "tv" });

  initZoomHud();
}

// POLL_MS — как часто спрашиваем, ответил ли ДМ. Две секунды: экран стоит и
// ждёт, пока человек дойдёт до стола, — чаще ни к чему, реже заметно на глаз.
const POLL_MS = 2000;

// waitForApproval — заявка на доступ и ожидание ответа ДМ. Заявка живёт
// минуты (domain.BroadcastRequestTTL), поэтому истёкшую подаём заново сами:
// экран в комнате мог простоять всю подготовку к игре.
async function waitForApproval() {
  const view = showWaitingScreen();

  for (;;) {
    let request;
    try {
      request = await requestBroadcastAccess();
    } catch (e) {
      view.showError(e.message || "сервер недоступен");
      await sleep(POLL_MS * 2);
      continue;
    }

    // Доступ уже есть (ДМ пустил этот экран раньше, cookie на месте) —
    // сервер отвечает сразу "approved", заявку заводить не за чем.
    if (request.state === "approved") {
      location.reload();
      return;
    }

    view.showCode(request.code);

    const done = await pollRequest(request.id, view);
    if (done) return;
    // Заявка истекла или ДМ отказал — заходим на второй круг с новым кодом.
  }
}

// pollRequest — опрос одной заявки. true — экран пущен и страница уже
// перезагружается; false — заявку нужно подавать заново.
async function pollRequest(id, view) {
  for (;;) {
    await sleep(POLL_MS);

    let state;
    try {
      ({ state } = await broadcastRequestState(id));
    } catch {
      continue; // сеть моргнула — не теряем заявку, просто пробуем снова
    }

    if (state === "approved") {
      // Cookie зрителя пришла вместе с этим ответом — перезагрузка открывает
      // уже стол, и ключ нигде на экране не появляется.
      view.showApproved();
      location.reload();
      return true;
    }
    if (state === "rejected") {
      view.showRejected();
      await sleep(POLL_MS * 3);
      return false;
    }
    if (state === "unknown") {
      return false; // истекла — подадим новую
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// showWaitingScreen — экран ожидания вместо стола. Читают его с нескольких
// метров, через комнату, поэтому код набран крупно, а всё остальное —
// подписи к нему.
function showWaitingScreen() {
  document.getElementById("zoomHud")?.remove();
  const wrap = document.getElementById("canvasWrap");
  wrap.replaceChildren();
  wrap.style.cssText += ";display:flex;align-items:center;justify-content:center;padding:6vmin;text-align:center;";

  const box = document.createElement("div");
  box.style.cssText = "max-width:34ch;color:#e8e8ea;font:400 clamp(16px,2vmin,22px)/1.5 system-ui,sans-serif;";

  const title = document.createElement("p");
  title.style.cssText = "margin:0 0 .4em;font-size:1.4em;font-weight:600;text-wrap:balance;";
  title.textContent = "Подключение к столу";

  const code = document.createElement("p");
  code.style.cssText =
    "margin:.3em 0;font-size:clamp(48px,12vmin,140px);font-weight:700;letter-spacing:.12em;" +
    "font-variant-numeric:tabular-nums;color:#fff;";
  code.textContent = "····";

  const hint = document.createElement("p");
  hint.style.cssText = "margin:.6em 0 0;color:#a9adb4;";
  hint.textContent = "Назовите этот код ДМ — он пустит экран из раздела «Настройки» на своём столе.";

  box.append(title, code, hint);
  wrap.appendChild(box);

  return {
    showCode(value) {
      code.textContent = value;
      code.style.color = "#fff";
      hint.textContent = "Назовите этот код ДМ — он пустит экран из раздела «Настройки» на своём столе.";
    },
    showApproved() {
      title.textContent = "Готово";
      code.textContent = "✓";
      hint.textContent = "Открываю стол…";
    },
    showRejected() {
      title.textContent = "ДМ отклонил подключение";
      code.textContent = "✕";
      code.style.color = "#e0756e";
      hint.textContent = "Сейчас попробуем ещё раз — с новым кодом.";
    },
    showError(message) {
      title.textContent = "Нет связи с сервером";
      code.textContent = "···";
      hint.textContent = message;
    },
  };
}

// ---- HUD зума/полноэкранного режима — те же события vtt:zoomBy/vtt:resetView,
// что и у ДМ (см. web/src/pages/dm.js), их слушает web/src/vtt/interaction.js
// одинаково для всех трёх ролей. Средняя кнопка тут отдельная от "сброса
// камеры" — настоящий Fullscreen API, потому что на ТВ/проекторе "на весь
// экран" означает "спрятать всё, кроме картинки", а не просто вписать карту
// в окно браузера.
function initZoomHud() {
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
}
