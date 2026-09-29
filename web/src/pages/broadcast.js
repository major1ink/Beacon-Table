// Перенос inline-скрипта static/tv.html (переименован в broadcast.html —
// "трансляция" точнее описывает назначение экрана, чем сокращение "tv", см.
// README). initVTT остаётся async (PIXI.Application.init() в v8 — промис).
//
// legacy-dom импортируется первым: полифилы нужны до остального кода.
import "../legacy-dom.js";
import { initVTT } from "../vtt/index.js";
import { initShowcaseOverlay } from "../showcase-overlay.js";
import { createDiceFx } from "../dice-fx.js";
import { broadcastAccessGranted, requestBroadcastAccess, broadcastRequestState, probeBroadcastCookie } from "../api.js";

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
// Проверка в async-функции, а не через top-level await: в старых браузерах телевизоров TLA нет.
//
// guard — сторож из public/broadcast-guard.js, если он загрузился.
const guard = window.__beaconBroadcast;
guard?.started();
boot().catch((e) => {
  console.error(e);
  guard?.fatal(e);
});

async function boot() {
  if (await broadcastAccessGranted()) {
    setTries(0);
    startTable();
    return;
  }
  // Вход по ключу в адресе уже пробовали: новые заявки не заводим, проверяем cookie.
  if (getTries() >= 1 && (await giveUpIfCookiesLost())) return;
  await waitForApproval();
}

// Счётчик попыток входа по ключу в адресе. Хранится в window.name: оно переживает
// перезагрузку и редирект, а cookie и localStorage могут не работать.
const TRIES_PREFIX = "beaconTvTries=";

function getTries() {
  const name = window.name || "";
  return name.indexOf(TRIES_PREFIX) === 0 ? parseInt(name.slice(TRIES_PREFIX.length), 10) || 0 : 0;
}

function setTries(n) {
  try {
    if (n) window.name = TRIES_PREFIX + n;
    else if ((window.name || "").indexOf(TRIES_PREFIX) === 0) window.name = "";
  } catch {
    /* window.name недоступно — счёт просто не ведём */
  }
}

// probeCookies проверяет, что умеет хранить браузер, и отправляет итог в отчёт о баге.
async function probeCookies() {
  const result = {};
  result.cookieEnabled = navigator.cookieEnabled ? "да" : "нет";
  try {
    document.cookie = "beacon_t=1; path=/; max-age=60";
    result.docCookie = document.cookie.indexOf("beacon_t=1") >= 0 ? "да" : "нет";
  } catch {
    result.docCookie = "ошибка";
  }
  for (const [key, store] of [
    ["localStorage", () => window.localStorage],
    ["sessionStorage", () => window.sessionStorage],
  ]) {
    try {
      const st = store();
      st.setItem("beacon_t", "1");
      result[key] = st.getItem("beacon_t") === "1" ? "да" : "нет";
      st.removeItem("beacon_t");
    } catch {
      result[key] = "нет";
    }
  }
  // первый запрос ставит cookie, второй показывает, вернул ли её браузер
  try {
    await probeBroadcastCookie();
    result.serverCookie = (await probeBroadcastCookie()) ? "да" : "нет";
  } catch {
    result.serverCookie = "ошибка запроса";
  }
  guard?.note(result);
  return result;
}

// giveUpIfCookiesLost останавливает экран, если браузер не сохраняет cookie от сервера.
// Если cookie работают, сбрасывает счётчик попыток и возвращает false.
async function giveUpIfCookiesLost() {
  const result = await probeCookies();
  if (result.serverCookie === "да") {
    setTries(0);
    return false;
  }
  guard?.note({ login: "остановлен: браузер не сохраняет cookie от сервера" });
  showWaitingScreen().showNoAccess();
  return true;
}

function startTable() {
  initVTT({ canvasId: "scene", role: "tv" }).catch((e) => {
    console.error("стол не запустился:", e);
    guard?.fatal(e);
  });

  // Картинка «Показать игрокам» от ДМ — полноэкранный оверлей поверх карты
  // (см. web/src/showcase-overlay.js). На трансляции закрыть нельзя, показом
  // управляет ДМ.
  initShowcaseOverlay({ role: "tv" });

  // Режим задаёт ДМ в настройках стола.
  let dice3d = false;
  const diceFx = createDiceFx(document.getElementById("canvasWrap"), {
    role: "tv",
    getMode: () => (dice3d ? "3d" : "full"),
  });
  document.addEventListener("vtt:combatState", (e) => {
    const next = !!e.detail.broadcastDice3d;
    if (next && !dice3d) {
      dice3d = true;
      diceFx.warm();
    } else dice3d = next;
  });
  document.addEventListener("vtt:rollResult", (e) => diceFx.play(e.detail));

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
  // пока ДМ не ответил, проверяем, что умеет браузер
  probeCookies();

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

    let state, key;
    try {
      ({ state, key } = await broadcastRequestState(id));
    } catch {
      continue; // сеть моргнула — не теряем заявку, просто пробуем снова
    }

    if (state === "approved") {
      view.showApproved();
      // cookie могла не сохраниться: без проверки перезагрузка снова покажет код
      if (await broadcastAccessGranted()) {
        setTries(0);
        location.reload();
        return true;
      }
      guard?.note({ accessAfterApproval: "нет: cookie из ответа не сохранилась" });
      if (key) {
        // вход по ссылке с ключом: cookie из ответа на переход принимаются надёжнее
        setTries(1);
        location.replace("/broadcast.html?key=" + encodeURIComponent(key));
        return true;
      }
      view.showNoAccess();
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
  // запасное значение перед clamp(): в Chromium до 79 его нет
  box.style.cssText =
    "max-width:34ch;color:#e8e8ea;font:400 20px/1.5 sans-serif;font:400 clamp(16px,2vmin,22px)/1.5 system-ui,sans-serif;";

  const title = document.createElement("p");
  title.style.cssText = "margin:0 0 .4em;font-size:1.4em;font-weight:600;text-wrap:balance;";
  title.textContent = "Подключение к столу";

  const code = document.createElement("p");
  code.style.cssText =
    "margin:.3em 0;font-size:12vmin;font-size:clamp(48px,12vmin,140px);font-weight:700;letter-spacing:.12em;" +
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
    showNoAccess() {
      title.textContent = "Браузер не запомнил доступ";
      code.textContent = "✕";
      code.style.color = "#e0756e";
      hint.textContent =
        "ДМ вас пустил, но этот браузер не сохраняет доступ. Подробности уже переданы на стол — ДМ увидит их в «Настройки» → «Сервер» → «Сообщить о баге». Попробуйте другой браузер на этом устройстве.";
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
    // Развернули на весь экран — зона показа (или вся карта) заново
    // вписывается в окно целиком, а не остаётся с прежним паном/зумом.
    document.dispatchEvent(new CustomEvent("vtt:resetView"));
  });
}
