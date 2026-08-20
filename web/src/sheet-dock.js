// sheet-dock.js — боковая колонка слева от карты, в которой у игрока по
// умолчанию открывается лист персонажа (см. pages/player.js:
// openCharacterSheet). Альтернатива плавающему окну (floating-window.js): за
// столом лист нужен открытым ПОСТОЯННО (ХП, ячейки, ресурсы отмечают по ходу
// боя), а плавающее окно для этого приходится всё время таскать, чтобы оно
// не закрывало карту. Док карту не перекрывает — он её ужимает (канвас
// пересчитывает размер сам, см. vtt/index.js: ResizeObserver на
// canvas.parentElement).
//
// Внутри — тот же iframe с той же character-sheet.html, что и у плавающего
// окна: страница написана как синглтон-документ (см. комментарий в
// floating-window.js о том, почему iframe, а не рендер в DOM хоста), и
// переключение "док ⇄ отдельное окно" не требует от неё вообще ничего —
// меняется только рамка вокруг.
//
// Одновременно открыт максимум один док (лист одного персонажа): это боковая
// колонка фиксированного места на экране, а не оконный менеджер — второй
// персонаж просто заменяет содержимое. Нужно два листа рядом — второй
// выносится кнопкой ⧉ в плавающее окно.

import { openFloatingWindow } from "./floating-window.js";

const WIDTH_KEY = "beacon:sheetDockWidth";
const MIN_WIDTH = 300;
const MAX_WIDTH_FRACTION = 0.72; // не даём доку съесть всю карту целиком

let styleInjected = false;
function injectStyle() {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    .sheet-dock {
      flex: 0 0 auto; position: relative; display: none; flex-direction: column;
      min-width: 0; background: var(--panel-bg, #1c1c25);
      border-right: 1px solid var(--border, rgba(255,255,255,0.08));
    }
    .sheet-dock.open { display: flex; }
    .sheet-dock-header {
      flex: 0 0 auto; display: flex; align-items: center; gap: 2px; padding: 6px 6px 6px 12px;
      border-bottom: 1px solid var(--border, rgba(255,255,255,0.08));
      background: var(--rail-bg, #191921);
    }
    .sheet-dock-title {
      flex: 1 1 auto; min-width: 0; font: 600 12.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--text, #eee); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .sheet-dock-body { flex: 1 1 auto; min-height: 0; position: relative; }
    .sheet-dock-iframe {
      position: absolute; inset: 0; width: 100%; height: 100%; border: none;
      background: var(--bg, #131318);
    }
    /* Ручка ширины — узкая полоска поверх правой границы дока; тянется мышью,
       ширина запоминается в localStorage на все следующие открытия. */
    .sheet-dock-resizer {
      position: absolute; top: 0; right: -3px; bottom: 0; width: 7px; z-index: 3;
      cursor: col-resize; background: transparent;
    }
    .sheet-dock-resizer:hover, .sheet-dock.resizing .sheet-dock-resizer {
      background: linear-gradient(90deg, transparent 2px, var(--accent, #7c6cf0) 2px, var(--accent, #7c6cf0) 5px, transparent 5px);
    }
    /* Пока тянем ручку — гасим указатель внутри iframe, иначе он перехватывает
       mousemove на себя и колонка "залипает" на границе. */
    .sheet-dock.resizing .sheet-dock-iframe { pointer-events: none; }
  `;
  document.head.appendChild(style);
}

// current — что сейчас показано в доке: { key, title, url }, либо null.
let current = null;
let dockEl = null;
let iframeEl = null;
let titleEl = null;
// notifyLayout — вызывающий сообщает соседям по странице, что колонка
// изменила ширину (появилась/пропала/растянулась) и им надо перемериться.
// Своего знания про канвас у дока нет: он просто занимает место в потоке,
// а кто на это реагирует — дело страницы (см. pages/player.js).
let notifyLayout = () => {};

function clampWidth(px) {
  return Math.max(MIN_WIDTH, Math.min(Math.round(window.innerWidth * MAX_WIDTH_FRACTION), px));
}

function storedWidth() {
  const raw = parseInt(localStorage.getItem(WIDTH_KEY) || "", 10);
  return clampWidth(Number.isFinite(raw) ? raw : 420);
}

// build — одноразовая сборка разметки дока внутри hostEl (пустой <aside> в
// разметке страницы, см. player.html: #sheetDock).
function build(hostEl) {
  injectStyle();
  dockEl = hostEl;
  dockEl.classList.add("sheet-dock");
  dockEl.style.width = storedWidth() + "px";

  const header = document.createElement("div");
  header.className = "sheet-dock-header";
  titleEl = document.createElement("span");
  titleEl.className = "sheet-dock-title";

  const popoutBtn = document.createElement("button");
  popoutBtn.type = "button";
  popoutBtn.className = "icon-btn";
  popoutBtn.title = "Открыть в отдельном окне";
  popoutBtn.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="4" y="6" width="16" height="13" rx="2"/><line x1="4" y1="10" x2="20" y2="10"/></svg>';
  popoutBtn.onclick = () => {
    const opened = current;
    closeSheetDock();
    if (opened) openFloatingWindow({ key: opened.key, title: opened.title, url: opened.url });
  };

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "icon-btn";
  closeBtn.title = "Закрыть";
  closeBtn.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' +
    '<line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg>';
  closeBtn.onclick = () => closeSheetDock();

  header.append(titleEl, popoutBtn, closeBtn);

  const body = document.createElement("div");
  body.className = "sheet-dock-body";
  iframeEl = document.createElement("iframe");
  iframeEl.className = "sheet-dock-iframe";
  body.appendChild(iframeEl);

  const resizer = document.createElement("div");
  resizer.className = "sheet-dock-resizer";
  resizer.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = dockEl.offsetWidth;
    dockEl.classList.add("resizing");
    function onMove(ev) {
      dockEl.style.width = clampWidth(startW + (ev.clientX - startX)) + "px";
      notifyLayout();
    }
    function onUp() {
      dockEl.classList.remove("resizing");
      localStorage.setItem(WIDTH_KEY, String(dockEl.offsetWidth));
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      notifyLayout();
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  dockEl.append(header, body, resizer);

  // Кнопка "✕" ВНУТРИ самого листа шлёт родителю то же сообщение, что и из
  // плавающего окна (см. character-sheet.js: closeBtn) — там она не знает,
  // в какой рамке открыта.
  window.addEventListener("message", (e) => {
    if (e.origin !== location.origin || !e.data) return;
    if (e.data.type === "beacon:closeFloatingWindow" && iframeEl && e.source === iframeEl.contentWindow) closeSheetDock();
  });
  window.addEventListener("resize", () => {
    if (!dockEl.classList.contains("open")) return;
    dockEl.style.width = clampWidth(dockEl.offsetWidth) + "px";
    notifyLayout();
  });
}

// openSheetDock — показать лист в левой колонке. Повторный вызов с тем же
// key ничего не перезагружает (иначе клик по чипу уже открытого персонажа
// сбрасывал бы прокрутку листа и несохранённый ввод).
export function openSheetDock(hostEl, { key, title, url, onLayoutChange }) {
  if (!dockEl) build(hostEl);
  if (onLayoutChange) notifyLayout = onLayoutChange;
  titleEl.textContent = title || "";
  if (!current || current.key !== key) {
    iframeEl.src = url;
    current = { key, title, url };
  } else {
    current.title = title;
  }
  const wasOpen = dockEl.classList.contains("open");
  dockEl.classList.add("open");
  if (!wasOpen) notifyLayout();
  return dockEl;
}

export function closeSheetDock() {
  if (!dockEl || !dockEl.classList.contains("open")) return;
  dockEl.classList.remove("open");
  iframeEl.removeAttribute("src");
  current = null;
  notifyLayout();
}

// isSheetDockOpen — нужен вызывающему, чтобы решить, куда открывать лист по
// клику: в док (по умолчанию) или поднять уже вынесенное плавающее окно.
export function isSheetDockOpen(key) {
  return !!current && (!key || current.key === key);
}
