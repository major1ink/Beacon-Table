// floating-window.js — минимальная Foundry-style "Application": перетаскиваемое
// (за шапку) и растягиваемое (нативный CSS resize) окно с iframe внутри,
// плавает поверх канваса. НЕМОДАЛЬНОЕ — канвас под окном по-прежнему кликается
// (drag токенов, зум и т.п.), окно просто лежит выше по z-index. Единственный
// сегодняшний потребитель — лист персонажа (character-sheet.html, см.
// pages/dm.js и pages/player.js), но модуль об этом ничего не знает: любой
// вызывающий передаёт свои key/title/url.
//
// Почему iframe, а не рендер character-sheet.js прямо в DOM хост-страницы:
// character-sheet.js написан как страница-синглтон (module-level me/charId/
// sheet/rollWS...) — рефакторинг под несколько одновременных инстансов на
// одной странице стоил бы отдельного большого рефакторинга. Iframe даёт
// несколько независимых JS-контекстов бесплатно (каждое окно — свой
// document/module scope), при этом остаётся тем же origin, так что cookie
// сессии и /ws/* работают без доп. телодвижений — просто перенос уже
// работающей страницы в рамку вместо отдельной вкладки браузера.

import { showConfirm } from "./modal.js";

let styleInjected = false;
function injectStyle() {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    .fw-window {
      position: fixed; display: flex; flex-direction: column;
      background: #1c1c24; border: 1px solid rgba(255,255,255,0.14); border-radius: 10px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.55); overflow: hidden;
      resize: both; min-width: 420px; min-height: 320px;
    }
    .fw-titlebar {
      flex: 0 0 auto; display: flex; align-items: center; gap: 4px; padding: 6px 6px 6px 10px;
      background: #26262f; cursor: move; user-select: none; border-bottom: 1px solid rgba(255,255,255,0.08);
    }
    .fw-title {
      flex: 1 1 auto; font: 600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #eee; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .fw-btn {
      flex: 0 0 auto; width: 26px; height: 26px; display: flex; align-items: center; justify-content: center;
      background: transparent; border: none; border-radius: 6px; color: #eee; font-size: 13px; cursor: pointer; padding: 0;
    }
    .fw-btn:hover { background: rgba(255,255,255,0.14); }
    .fw-body { flex: 1 1 auto; min-height: 0; position: relative; }
    .fw-iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: none; background: #1c1c24; }
  `;
  document.head.appendChild(style);
}

const Z_BASE = 200; // выше рейла/сайдменю/контекстных меню канваса, но ниже полноэкранных "сессия слетела"-оверлеев
let zTop = Z_BASE;
let cascadeStep = 0;
const openWindows = new Map(); // key -> HTMLElement (.fw-window)

function bringToFront(el) {
  zTop += 1;
  el.style.zIndex = String(zTop);
}

// openFloatingWindow — открывает окно с заданным key, либо (если с этим key
// уже открыто) просто поднимает существующее наверх — как повторный клик по
// вкладке того же персонажа в Foundry не плодит вторую копию листа.
//
// navigate: true — если окно с этим key уже открыто, ПЕРЕВЕСТИ его на новый
// url, а не просто поднять. Нужно, когда зовущий показывает конкретный
// документ, а не просто «открой этот инструмент»: ДМ жмёт «Показать» на
// записи журнала, а у игрока журнал уже открыт — без этого окно всплывало
// бы на прежней записи, и выглядело бы, будто кнопка ничего не сделала.
// По умолчанию false: для листа персонажа и компендиумов правильно именно
// «поднять уже открытое, ничего не перезагружая».
//
// popoutTitle/popoutFeatures — параметры window.open() для кнопки 🗗
// ("вынести" в настоящее отдельное окно браузера, полностью закрывая
// плавающее — это ставит обратно ровно то поведение, что было ДО этого UI:
// см. git history web/src/pages/dm.js:handleAdminCharacterUpdate и соседей).
export function openFloatingWindow({
  key,
  title,
  url,
  navigate = false,
  popoutFeatures = "width=1040,height=880",
  width = 1040,
  height = 880,
}) {
  injectStyle();
  const existing = openWindows.get(key);
  if (existing) {
    if (navigate) {
      const frame = existing.querySelector(".fw-iframe");
      // Сравниваем с href уже загруженной страницы (src — то, что попросили,
      // href — то, что реально открыто): иначе повторный показ той же
      // записи молча ничего не делал бы, если внутри окна успели уйти на
      // другую (см. history.replaceState в journal.js).
      const currentHref = (frame.contentWindow && frame.contentWindow.location.href) || frame.src;
      if (new URL(currentHref, location.href).href !== new URL(url, location.href).href) frame.src = url;
    }
    bringToFront(existing);
    return existing;
  }

  const w = Math.min(width, Math.round(window.innerWidth * 0.94));
  const h = Math.min(height, Math.round(window.innerHeight * 0.9));
  // Каскад — чтобы 2-3 открытых подряд окна не легли ровно друг на друга и
  // оставались видны их шапки (тот же приём, что у Foundry/большинства
  // оконных менеджеров).
  const offset = (cascadeStep++ % 8) * 28;

  const el = document.createElement("div");
  el.className = "fw-window";
  el.style.width = w + "px";
  el.style.height = h + "px";
  el.style.left = Math.max(8, Math.round((window.innerWidth - w) / 2) + offset) + "px";
  el.style.top = Math.max(8, Math.round((window.innerHeight - h) / 2) + offset) + "px";

  const titlebar = document.createElement("div");
  titlebar.className = "fw-titlebar";
  const titleEl = document.createElement("span");
  titleEl.className = "fw-title";
  titleEl.textContent = title || "";
  const popoutBtn = document.createElement("button");
  popoutBtn.type = "button";
  popoutBtn.className = "fw-btn";
  popoutBtn.textContent = "🗗";
  popoutBtn.title = "Открыть в отдельном окне браузера";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "fw-btn";
  closeBtn.textContent = "✕";
  closeBtn.title = "Закрыть";
  titlebar.append(titleEl, popoutBtn, closeBtn);

  const body = document.createElement("div");
  body.className = "fw-body";
  const iframe = document.createElement("iframe");
  iframe.className = "fw-iframe";
  iframe.src = url;
  body.appendChild(iframe);

  el.append(titlebar, body);
  document.body.appendChild(el);
  openWindows.set(key, el);
  bringToFront(el);

  function close() {
    window.removeEventListener("message", onMessage);
    el.remove();
    openWindows.delete(key);
  }
  // confirmClose — спросить встроенную страницу, можно ли её закрывать.
  // Контракт: страница вешает на свой window функцию beaconCloseGuard(),
  // которая возвращает текст предупреждения, если сейчас закрывать нельзя
  // ("" или отсутствие функции — можно молча). Нужен страницам с длительным
  // процессом внутри: закрытие iframe убивает его на полпути, а обычный
  // beforeunload браузер для удаления iframe не показывает (см.
  // web/src/pages/foundry-import.js).
  async function confirmClose() {
    let warning = "";
    try {
      const guard = iframe.contentWindow && iframe.contentWindow.beaconCloseGuard;
      if (typeof guard === "function") warning = guard() || "";
    } catch {
      /* всегда тот же origin, сюда не попадём */
    }
    if (!warning) return true;
    return showConfirm(warning, { title: "Закрыть окно", okLabel: "Закрыть", cancelLabel: "Не закрывать", danger: true });
  }

  closeBtn.onclick = async () => {
    if (await confirmClose()) close();
  };
  popoutBtn.onclick = async () => {
    // Вынос в отдельное окно перезагружает страницу с нуля — для процесса
    // внутри это то же самое, что закрытие, поэтому спрашиваем так же.
    if (!(await confirmClose())) return;
    window.open(url, key, popoutFeatures);
    close();
  };

  // Кнопка "✕ Закрыть" ВНУТРИ самого листа (character-sheet.js) в обычном
  // окне браузера делает window.close() — а у iframe это молча ничего не
  // делает (window.close работает только для окон, открытых через
  // window.open). Встроенная страница вместо этого шлёт postMessage
  // родителю — ловим его здесь и закрываем плавающее окно.
  function onMessage(e) {
    if (e.source === iframe.contentWindow && e.data && e.data.type === "beacon:closeFloatingWindow") close();
  }
  window.addEventListener("message", onMessage);

  // Поднять окно наверх кликом по шапке...
  titlebar.addEventListener("mousedown", (e) => {
    if (e.target === popoutBtn || e.target === closeBtn) return;
    bringToFront(el);
    const startX = e.clientX;
    const startY = e.clientY;
    const startLeft = el.offsetLeft;
    const startTop = el.offsetTop;
    function onMove(ev) {
      el.style.left = Math.max(0, startLeft + (ev.clientX - startX)) + "px";
      el.style.top = Math.max(0, startTop + (ev.clientY - startY)) + "px";
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
  // ...и кликом ГДЕ УГОДНО внутри самого листа — iframe того же origin, так
  // что его contentWindow можно слушать напрямую (клики внутри iframe не
  // всплывают в document родителя, это разные document, поэтому обычный
  // capture-слушатель на el их не поймал бы).
  iframe.addEventListener("load", () => {
    try {
      iframe.contentWindow.addEventListener("mousedown", () => bringToFront(el), true);
    } catch {
      /* тот же origin всегда, сюда не попадём — оставлено на всякий случай */
    }
  });

  return el;
}

// isFloatingWindowOpen — открыто ли сейчас окно с таким key. Нужно тем, у
// кого для той же сущности есть ВТОРОЕ место показа (лист персонажа: боковой
// док у игрока, см. sheet-dock.js) — чтобы не открывать копию рядом с уже
// вынесенным окном.
export function isFloatingWindowOpen(key) {
  return openWindows.has(key);
}

// postToOpenWindows — форвардит message в iframe каждого сейчас открытого
// плавающего окна, чей key начинается с keyPrefix. Нужно панели "Компендиум"
// (catalog.js) — она сама живёт в iframe и не видит postMessage, который
// шлёт ДРУГОЕ плавающее окно (карточка записи) window.parent'у (то есть в
// топ-документ, см. dm.js/player.js: слушатели "beacon:*Saved") — топ-документ
// перепосылает это сообщение сюда, чтобы открытый список сам решил, обновляться
// ли ему (проверяет message.type у себя).
export function postToOpenWindows(keyPrefix, message) {
  for (const [key, el] of openWindows) {
    if (!key.startsWith(keyPrefix)) continue;
    const iframe = el.querySelector(".fw-iframe");
    if (iframe && iframe.contentWindow) {
      iframe.contentWindow.postMessage(message, location.origin);
    }
  }
}
