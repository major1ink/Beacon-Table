// tutorial.js — режим обучения: пошаговый тур по экрану. Шаг — подсвеченный
// элемент интерфейса плюс карточка рядом с ним: что это и что с этим сделать.
//
// Зачем не модалка с текстом. Подсказки у инструментов (tooltip.js) отвечают
// на «что делает эта кнопка», но не на «с чего вообще начать»: новому
// ведущему стол показывает два десятка иконок и пустую сетку. Тур ведёт по
// ним в том порядке, в котором стол готовят к первой игре, и всё, что
// человек делает по ходу, — настоящие сцены и персонажи этого мира, не
// песочница.
//
// Экран под туром остаётся рабочим: затемнение — только тень вокруг
// подсвеченного элемента (pointer-events: none), клики проходят. Иначе
// «нажми «+ Сцена»» пришлось бы делать за человека, а такое не запоминается.
//
// Шаг — {title, text, target?, placement?, before?, waitFor?}:
//   text      — абзацы через пустую строку; клавиши в [квадратных скобках]
//               становятся чипами, как в подсказках (tooltip.js).
//   target    — CSS-селектор или функция → элемент. Нет элемента (панель ещё
//               не открылась, нет цели) — карточка по центру, без подсветки.
//   placement — right/left/top/bottom; без него — куда влезает.
//   before()  — открыть нужную панель перед показом; может быть async.
//   waitFor() — правда → шаг закрывается сам (человек сделал, что просили).
//
// Стиль модуль вносит сам (как modal.js): тур ходит по нескольким страницам
// (worlds.html → dm.html), и требовать CSS от каждой незачем.
import { icon } from "./icons.js";
import { renderWithKeys } from "./tooltip.js";

// STORAGE_PREFIX — прогресс тура (номер шага) в localStorage этого браузера:
// перезагрузка страницы возвращает на тот же шаг, а не на первый. Сам факт
// «обучение включено» — на сервере (см. api.js: fetchTutorial), прогресс —
// нет: он никому, кроме этой вкладки, не нужен.
const STORAGE_PREFIX = "bt.tutorial.step.";

// SPOT_PAD — зазор между краем элемента и рамкой подсветки.
const SPOT_PAD = 6;
// CARD_GAP — расстояние от подсветки до карточки.
const CARD_GAP = 14;
// EDGE — поле до краёв окна, ближе карточку не ставим.
const EDGE = 12;
// TICK — как часто перемерять цель: панели выезжают с анимацией, списки
// дорастают после fetch — подписаться на всё это нельзя, проще спрашивать.
const TICK = 150;

let styleInjected = false;
function injectStyle() {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    /* 450 — выше плавающих окон (200+) и оверлея лута (400), ниже модалок
       (500): вопрос «сохранить?» должен перекрывать и тур. */
    .bt-tour-spot {
      position: fixed; z-index: 450; pointer-events: none;
      border-radius: 14px; border: 2px solid var(--accent, #7c6cf0);
      box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.5), 0 0 0 5px rgba(124, 108, 240, 0.28);
      transition: top .18s ease-out, left .18s ease-out, width .18s ease-out, height .18s ease-out;
    }
    .bt-tour-spot.bt-tour-spot--none { border-color: transparent; box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.5); }
    .bt-tour-card {
      position: fixed; z-index: 451; box-sizing: border-box; width: min(360px, calc(100vw - 24px));
      display: flex; flex-direction: column; gap: 8px; padding: 14px 16px 12px;
      background: var(--glass-bg-strong, rgba(22, 22, 29, 0.92)); color: var(--text, #eee);
      backdrop-filter: var(--glass-blur, blur(20px)); -webkit-backdrop-filter: var(--glass-blur, blur(20px));
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.07)); border-radius: var(--radius-lg, 18px);
      box-shadow: var(--shadow-float, 0 16px 40px rgba(0, 0, 0, 0.45));
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 13px; line-height: 1.5;
      transition: top .18s ease-out, left .18s ease-out;
      animation: bt-tour-in .16s ease-out;
    }
    @keyframes bt-tour-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
    /* Шапка — ручка: карточку можно оттащить, если она легла на то, с чем
       шаг просит поработать (перетащить существо на карту). */
    .bt-tour-head { display: flex; align-items: center; gap: 8px; cursor: grab; user-select: none; -webkit-user-select: none; touch-action: none; }
    .bt-tour-card.bt-tour-card--dragging { transition: none; }
    .bt-tour-card.bt-tour-card--dragging .bt-tour-head { cursor: grabbing; }
    .bt-tour-counter {
      flex: 0 0 auto; padding: 2px 8px; border-radius: var(--radius-pill, 999px);
      background: var(--accent-bg, rgba(124, 108, 240, 0.16)); color: var(--accent, #7c6cf0);
      font-size: 11px; font-weight: 600; letter-spacing: 0.04em;
    }
    .bt-tour-title { flex: 1 1 auto; margin: 0; font-size: 14px; font-weight: 600; }
    .bt-tour-text { margin: 0; color: var(--text, #eee); }
    .bt-tour-text + .bt-tour-text { margin-top: 2px; }
    .bt-tour-text .bt-tip-key {
      display: inline-block; padding: 0 5px; margin: 0 1px; border-radius: 5px; font: inherit; font-size: 11px; line-height: 17px;
      background: var(--surface, #26262f); border: 1px solid var(--border, rgba(255,255,255,0.08)); color: var(--text, #eee);
    }
    .bt-tour-foot { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
    .bt-tour-skip {
      flex: 1 1 auto; text-align: left; padding: 6px 0; background: none; border: none; cursor: pointer; font: inherit; font-size: 12px;
      color: var(--text-dim, rgba(238,238,238,0.55));
    }
    .bt-tour-skip:hover { color: var(--text, #eee); }
    .bt-tour-btn {
      flex: 0 0 auto; display: inline-flex; align-items: center; gap: 4px; padding: 7px 12px; border: none; border-radius: var(--radius, 10px);
      cursor: pointer; font: inherit; font-size: 12px; background: var(--surface, #26262f); color: var(--text, #eee);
    }
    .bt-tour-btn:hover { background: var(--surface-hover, #303039); }
    .bt-tour-btn:disabled { opacity: 0.4; cursor: default; }
    .bt-tour-btn.primary { background: var(--accent, #7c6cf0); color: #fff; }
    .bt-tour-btn.primary:hover { background: var(--accent-hover, #6a5ae0); }
    .bt-tour-btn svg { display: block; }
    /* Подсказки инструментов (tooltip.js) лежат ниже тени тура — под ней их
       не прочесть; поднимаем на время тура. */
    body.bt-tour-active .bt-tip { z-index: 452; }
  `;
  document.head.appendChild(style);
}

function resolveTarget(target) {
  if (!target) return null;
  let el = null;
  try {
    el = typeof target === "function" ? target() : document.querySelector(target);
  } catch {
    el = null;
  }
  if (!el || !el.isConnected) return null;
  // Спрятанный элемент (панель закрыта, вкладка не активна) подсвечивать
  // нечем — карточка встанет по центру.
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) return null;
  return el;
}

// readStep/writeStep — прогресс в localStorage; приватное окно и запрет
// site data просто вернут первый шаг.
function readStep(key) {
  if (!key) return 0;
  try {
    const n = parseInt(localStorage.getItem(STORAGE_PREFIX + key) || "", 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}
function writeStep(key, n) {
  if (!key) return;
  try {
    if (n === null) localStorage.removeItem(STORAGE_PREFIX + key);
    else localStorage.setItem(STORAGE_PREFIX + key, String(n));
  } catch {
    /* нет localStorage — прогресс не переживёт перезагрузку, и только */
  }
}

// HINT_PREFIX — разовые подсказки вне шагов тура (см. tourHintOnce).
const HINT_PREFIX = "bt.tutorial.hint.";

// tourHintOnce — можно ли показать подсказку key: правда только в первый
// раз, дальше она считается показанной. Для сообщений вроде «теперь потяни
// за значок» после «Изменить размер»: новому ведущему они объясняют жест,
// а на десятый раз только мешают — тот же жест подписан в title кнопки.
// Показывать или нет вообще (обучение включено?) решает вызывающий.
export function tourHintOnce(key) {
  try {
    if (localStorage.getItem(HINT_PREFIX + key)) return false;
    localStorage.setItem(HINT_PREFIX + key, "1");
  } catch {
    /* нет localStorage — подсказка покажется снова, это не страшно */
  }
  return true;
}

// clearTourProgress — забыть, на каком шаге остановились, и какие разовые
// подсказки уже показывали: тур с этим ключом начнётся с начала (тумблер
// «Режим обучения» в настройках).
export function clearTourProgress(key) {
  writeStep(key, null);
  try {
    const stale = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(HINT_PREFIX)) stale.push(k);
    }
    stale.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* см. writeStep */
  }
}

// startTour — запустить тур. opts:
//   key       — под каким именем хранить прогресс (свой у каждой страницы);
//               без ключа тур каждый раз идёт с первого шага.
//   onFinish  — дошли до конца («Готово»).
//   onSkip    — «Пропустить обучение».
// Возвращает {next, prev, stop, index}. Повторный запуск на той же странице
// сначала останавливает прежний тур.
let active = null;
export function startTour(steps, { key, onFinish, onSkip } = {}) {
  if (active) active.stop();
  injectStyle();

  const spot = document.createElement("div");
  spot.className = "bt-tour-spot bt-tour-spot--none";
  const card = document.createElement("div");
  card.className = "bt-tour-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-live", "polite");
  document.body.append(spot, card);
  document.body.classList.add("bt-tour-active");

  let index = Math.min(readStep(key), steps.length - 1);
  let timer = null;
  let stopped = false;
  let currentTarget = null;
  let placement = "";
  // dragged — {x, y}, куда человек оттащил карточку за шапку; пока стоит,
  // update() её не переставляет. Сбрасывается на следующем шаге: там
  // карточка снова встаёт у своей цели.
  let dragged = null;

  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    window.removeEventListener("resize", update);
    window.removeEventListener("scroll", update, true);
    spot.remove();
    card.remove();
    document.body.classList.remove("bt-tour-active");
    if (active === ctl) active = null;
  }

  function finish() {
    writeStep(key, null);
    stop();
    if (onFinish) onFinish();
  }

  function skip() {
    writeStep(key, null);
    stop();
    if (onSkip) onSkip();
  }

  async function show(i) {
    index = Math.max(0, Math.min(i, steps.length - 1));
    writeStep(key, index);
    const step = steps[index];
    placement = step.placement || "";
    dragged = null;
    if (step.before) {
      try {
        await step.before();
      } catch (err) {
        console.error("режим обучения: шаг не подготовился:", err);
      }
      if (stopped || steps[index] !== step) return;
    }
    // Уже сделано (пароль задан, мир есть) — шаг не показываем вовсе, а не
    // мигаем им до первого тика.
    if (waitDone(step)) {
      if (index === steps.length - 1) finish();
      else show(index + 1);
      return;
    }
    render(step);
    update();
  }

  function waitDone(step) {
    if (!step.waitFor) return false;
    try {
      return !!step.waitFor();
    } catch {
      return false;
    }
  }

  function render(step) {
    card.replaceChildren();
    const head = document.createElement("div");
    head.className = "bt-tour-head";
    const counter = document.createElement("span");
    counter.className = "bt-tour-counter";
    counter.textContent = `${index + 1} / ${steps.length}`;
    const title = document.createElement("h3");
    title.className = "bt-tour-title";
    title.textContent = step.title;
    head.append(counter, title);
    head.addEventListener("pointerdown", startDrag);
    card.appendChild(head);
    for (const para of String(step.text).split(/\n\s*\n/)) {
      const p = document.createElement("p");
      p.className = "bt-tour-text";
      renderWithKeys(p, para.trim());
      card.appendChild(p);
    }
    const foot = document.createElement("div");
    foot.className = "bt-tour-foot";
    const skipBtn = document.createElement("button");
    skipBtn.type = "button";
    skipBtn.className = "bt-tour-skip";
    skipBtn.textContent = "Пропустить обучение";
    skipBtn.onclick = skip;
    const prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.className = "bt-tour-btn";
    prevBtn.innerHTML = icon("chevron-left", { size: 14 }) + "<span>Назад</span>";
    prevBtn.disabled = index === 0;
    prevBtn.onclick = () => show(index - 1);
    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "bt-tour-btn primary";
    const last = index === steps.length - 1;
    nextBtn.innerHTML = last ? "<span>Готово</span>" + icon("check", { size: 14 }) : "<span>Далее</span>" + icon("chevron-right", { size: 14 });
    nextBtn.onclick = () => (last ? finish() : show(index + 1));
    foot.append(skipBtn, prevBtn, nextBtn);
    card.appendChild(foot);
  }

  // update — перемерить цель и расставить подсветку с карточкой. Зовётся
  // по таймеру: цель может появиться, исчезнуть или переехать в любой момент.
  function update() {
    if (stopped) return;
    const step = steps[index];
    if (waitDone(step)) {
      if (index === steps.length - 1) finish();
      else show(index + 1);
      return;
    }
    const el = resolveTarget(step.target);
    if (el !== currentTarget) {
      currentTarget = el;
      // Подсветка на новом месте не должна «ехать» через весь экран от
      // прежней цели — без перехода на первый кадр.
      spot.style.transition = "none";
      requestAnimationFrame(() => (spot.style.transition = ""));
      // Цель в прокручиваемой панели (тумблер в конце «Настроек») — докрутить
      // до неё; следующий тик перемерит.
      if (el) el.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    if (!el) {
      spot.classList.add("bt-tour-spot--none");
      spot.style.left = Math.round(vw / 2) + "px";
      spot.style.top = Math.round(vh / 2) + "px";
      spot.style.width = "0px";
      spot.style.height = "0px";
      placeCard((vw - cw) / 2, (vh - ch) / 2);
      return;
    }
    const r = el.getBoundingClientRect();
    const sx = r.left - SPOT_PAD;
    const sy = r.top - SPOT_PAD;
    const sw = r.width + SPOT_PAD * 2;
    const sh = r.height + SPOT_PAD * 2;
    spot.classList.remove("bt-tour-spot--none");
    spot.style.left = Math.round(sx) + "px";
    spot.style.top = Math.round(sy) + "px";
    spot.style.width = Math.round(sw) + "px";
    spot.style.height = Math.round(sh) + "px";

    // Карточка — сбоку от цели, куда влезает; предпочтение — из шага.
    const fits = {
      right: sx + sw + CARD_GAP + cw + EDGE <= vw,
      left: sx - CARD_GAP - cw - EDGE >= 0,
      bottom: sy + sh + CARD_GAP + ch + EDGE <= vh,
      top: sy - CARD_GAP - ch - EDGE >= 0,
    };
    let side = placement && fits[placement] ? placement : "";
    if (!side) side = ["right", "left", "bottom", "top"].find((s) => fits[s]) || "bottom";
    let x;
    let y;
    if (side === "right" || side === "left") {
      x = side === "right" ? sx + sw + CARD_GAP : sx - CARD_GAP - cw;
      y = sy + sh / 2 - ch / 2;
    } else {
      x = sx + sw / 2 - cw / 2;
      y = side === "bottom" ? sy + sh + CARD_GAP : sy - CARD_GAP - ch;
    }
    placeCard(x, y);
  }

  // placeCard — поставить карточку в (x, y), не выпуская за края окна.
  // Оттащенная руками остаётся где оставили (с тем же зажимом: окно могли
  // уменьшить).
  function placeCard(x, y) {
    if (dragged) ({ x, y } = dragged);
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    x = Math.max(EDGE, Math.min(x, window.innerWidth - cw - EDGE));
    y = Math.max(EDGE, Math.min(y, window.innerHeight - ch - EDGE));
    card.style.left = Math.round(x) + "px";
    card.style.top = Math.round(y) + "px";
  }

  // startDrag — перетаскивание карточки за шапку (pointer capture: курсор
  // может уйти с шапки быстрее, чем карточка догонит).
  function startDrag(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const head = e.currentTarget;
    const rect = card.getBoundingClientRect();
    const dx = e.clientX - rect.left;
    const dy = e.clientY - rect.top;
    card.classList.add("bt-tour-card--dragging");
    head.setPointerCapture(e.pointerId);
    const move = (ev) => {
      dragged = { x: ev.clientX - dx, y: ev.clientY - dy };
      placeCard(dragged.x, dragged.y);
    };
    const end = () => {
      head.removeEventListener("pointermove", move);
      head.removeEventListener("pointerup", end);
      head.removeEventListener("pointercancel", end);
      card.classList.remove("bt-tour-card--dragging");
    };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", end);
    head.addEventListener("pointercancel", end);
  }

  const ctl = {
    next: () => show(index + 1),
    prev: () => show(index - 1),
    stop,
    get index() {
      return index;
    },
  };
  active = ctl;
  timer = setInterval(update, TICK);
  window.addEventListener("resize", update);
  window.addEventListener("scroll", update, true);
  show(index);
  return ctl;
}

// stopTour — снять тур с экрана, не трогая прогресс (тумблер выключил
// обучение; уход со страницы и так всё уберёт).
export function stopTour() {
  if (active) active.stop();
}

// tourRunning — идёт ли тур на этой странице.
export function tourRunning() {
  return !!active;
}
