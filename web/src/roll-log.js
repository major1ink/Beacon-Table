// roll-log.js — единственный лог бросков кубов на весь проект. Заменяет шесть
// почти одинаковых копий: слушатель vtt:rollResult в web/src/dice.js (стол) и
// showRollResult в bestiary/spellbook/itembook/character-sheet (панели книг и
// листа).
//
// Данные — payload roll_result из комнаты (internal/service/room.go: relayRoll):
// { name, formula, rolls[], modifier, total, label? }. Лог чисто клиентский,
// сервер историю не хранит (бросок эфемерен, как animate_attack).
//
// Вид карточки — в стиле Foundry: строка «кто», тусклая строка-формула
// («рецепт» — что кидали), ниже раскладка блоками (значение каждой кости +
// модификатор-чип + итог). Поведение — в стиле Roll20: новые карточки снизу,
// тело всегда проскроллено вниз. На столе (plate) лог — плавающее окно:
// таскается, тянется, сворачивается, закрывается до кнопки «Чат». Второй
// вкладкой там же живёт чат стола (chat.js, opts.chat).

import { rollGroups } from "./dice.js";
import { icon } from "./icons.js";
import { attachDrag } from "./drag.js";
import { createChatPane } from "./chat.js";

// createRollLog(container, opts) → { push, clear, el }
//   container — элемент-хост; модуль строит внутри .roll-log-body и вешает
//     классы .roll-log / .roll-log--<layout>.
//   opts.layout — "plate" (плавающее окно поверх канваса, стол) | "strip"
//     (нижняя приклеенная лента в панели).
//   opts.max — сколько карточек держать (по умолчанию 30).
//   opts.corner — только для plate: угол, где живёт кнопка «Чат» и откуда
//     впервые появляется окно ("bottom-left" | "top-right").
//   opts.storageKey — только для plate: ключ localStorage для положения,
//     размера и состояния окна (по умолчанию — по пути страницы).
//   opts.chat — только для plate: { role, selfId, send } — вкладка «Чат»
//     (chat.js); в результате возвращается как chat.
export function createRollLog(container, { layout = "strip", max = 30, corner = "bottom-left", storageKey, chat } = {}) {
  container.classList.add("roll-log", `roll-log--${layout}`);
  if (layout === "plate") return createPlate(container, { max, corner, storageKey, chat });

  // Пока броска не было — лога не видно (лента не ест высоту панели).
  // Первый push его показывает.
  container.classList.add("hidden");

  const body = document.createElement("div");
  body.className = "roll-log-body";
  container.appendChild(body);

  function push(data) {
    container.classList.remove("hidden");
    body.appendChild(renderCard(data));
    while (body.children.length > max) body.removeChild(body.firstChild);
    // Roll20-поведение: свежий бросок всегда виден, старые уезжают вверх.
    body.scrollTop = body.scrollHeight;
  }

  function clear() {
    body.replaceChildren();
    container.classList.add("hidden");
  }

  return { push, clear, el: container };
}

// ---- plate: плавающее окно поверх канваса ----
// Хост на весь канвас (клики сквозь него), внутри кнопка «Чат» и окно.
// Координаты — left/top относительно хоста, а не угол экрана: перетаскивание
// и растягивание не спорят с прибитым углом, окно не уходит за карту.
const MIN_W = 200;
const MIN_H = 140;
const EDGE = 10;

function createPlate(container, { max, corner, storageKey, chat: chatOpts }) {
  container.classList.add(corner === "top-right" ? "roll-log--tr" : "roll-log--bl");
  const key = storageKey || "beacon:rollLog:" + location.pathname;

  // shown — в режиме open окно не лезет на карту, пока броска не было и
  // пользователь сам не нажал «Чат».
  // С чатом окно по умолчанию просторнее: лента и поле ввода в 264×240 не влезают.
  const state = Object.assign({ x: null, y: null, w: chatOpts ? 320 : 264, h: chatOpts ? 360 : 240, mode: "open", tab: "rolls" }, load(key));
  if (!chatOpts) state.tab = "rolls";
  let shown = false;
  // Непрочитанные — по вкладкам, на кнопке и в шапке сумма.
  const unread = { rolls: 0, chat: 0 };

  const fab = document.createElement("button");
  fab.type = "button";
  fab.className = "roll-log-fab";
  fab.title = "Открыть лог бросков";
  const fabBadge = document.createElement("span");
  fabBadge.className = "roll-log-badge";
  fab.innerHTML = icon("chat", { size: 15 });
  fab.append("Чат", fabBadge);

  const win = document.createElement("div");
  win.className = "roll-log-win";

  const head = document.createElement("div");
  head.className = "roll-log-head";
  const title = document.createElement("span");
  title.className = "roll-log-title";
  title.textContent = "Броски";
  // С чатом вместо заголовка — вкладки со счётчиками.
  const tabs = {};
  const tabBadges = {};
  if (chatOpts) {
    title.classList.add("roll-log-tabs");
    title.textContent = "";
    for (const [id, label] of [
      ["chat", "Чат"],
      ["rolls", "Броски"],
    ]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "roll-log-tab";
      b.textContent = label;
      const badge = document.createElement("span");
      badge.className = "roll-log-badge";
      b.appendChild(badge);
      b.onclick = () => {
        state.tab = id;
        if (state.mode === "collapsed") state.mode = "open";
        save();
        render();
        scrollActive(true);
      };
      tabs[id] = b;
      tabBadges[id] = badge;
      title.appendChild(b);
    }
  }
  const headBadge = document.createElement("span");
  headBadge.className = "roll-log-badge";
  const collapseBtn = document.createElement("button");
  collapseBtn.type = "button";
  collapseBtn.className = "icon-btn";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "icon-btn";
  closeBtn.title = "Убрать — вернуть можно кнопкой «Чат»";
  closeBtn.innerHTML = icon("close", { size: 13 });
  head.append(title, headBadge, collapseBtn, closeBtn);

  const body = document.createElement("div");
  body.className = "roll-log-body";
  const empty = document.createElement("div");
  empty.className = "roll-log-empty";
  empty.textContent = "Бросков пока не было";

  const grip = document.createElement("div");
  grip.className = "roll-log-resize";
  grip.title = "Потяни, чтобы изменить размер";

  // Телефон: окно с чатом — во весь экран, как лист персонажа. На это время
  // оно переезжает в body: у обёртки канваса свой stacking context, z-index
  // над колонкой иконок не поднять. Брейкпоинт общий с theme.css.
  const fullMedia = chatOpts && typeof matchMedia === "function" ? matchMedia("(max-width: 860px), (max-height: 500px)") : null;
  let chat = null;
  const chatHost = document.createElement("div");
  if (chatOpts) {
    chat = createChatPane(chatHost, {
      ...chatOpts,
      onMessage: (m, own) => {
        // Своё непрочитанным не считаем, но окно поднимаем, как на бросок.
        if (!own && !(isVisible() && state.tab === "chat")) unread.chat += 1;
        else if (own && state.tab !== "chat") state.tab = "chat";
        if (own) shown = true;
        else if (state.mode === "open") shown = true;
        render();
      },
    });
  }

  win.append(head, body, empty, chatHost, grip);
  container.append(fab, win);

  function save() {
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch {
      /* приватный режим */
    }
  }

  function hostSize() {
    return { W: container.clientWidth, H: container.clientHeight };
  }

  // state не трогаем: временное сжатие хоста (лоток кубов на телефоне) не
  // должно переезжать окно навсегда.
  function place() {
    const { W, H } = hostSize();
    if (!W || !H) return;
    const collapsed = state.mode === "collapsed";
    const w = Math.max(MIN_W, Math.min(state.w, W - EDGE));
    const h = collapsed ? head.offsetHeight || 36 : Math.max(MIN_H, Math.min(state.h, H - EDGE));
    if (state.x === null || state.y === null) {
      state.x = corner === "top-right" ? W - w - EDGE : EDGE;
      state.y = corner === "top-right" ? EDGE : H - h - EDGE;
    }
    win.style.width = w + "px";
    win.style.height = collapsed ? "" : h + "px";
    win.style.left = Math.max(0, Math.min(state.x, W - w)) + "px";
    win.style.top = Math.max(0, Math.min(state.y, H - h)) + "px";
  }

  function isVisible() {
    return state.mode === "open" && shown;
  }

  function setBadge(b, n) {
    b.textContent = n > 99 ? "99+" : String(n);
    b.hidden = n === 0;
  }

  function render() {
    const closed = state.mode === "closed";
    const collapsed = state.mode === "collapsed";
    const visible = !closed && shown;
    win.hidden = !visible;
    fab.hidden = visible;
    win.classList.toggle("collapsed", collapsed);
    const chatTab = !!chat && state.tab === "chat";
    body.hidden = chatTab;
    empty.hidden = chatTab || body.children.length > 0;
    chatHost.hidden = !chatTab;
    for (const id in tabs) tabs[id].classList.toggle("active", state.tab === id);
    collapseBtn.title = collapsed ? "Развернуть" : "Свернуть до шапки";
    collapseBtn.innerHTML = icon(collapsed ? "chevron-down" : "minus", { size: 13 });
    const full = !!fullMedia && fullMedia.matches && visible && !collapsed;
    win.classList.toggle("roll-log-win--full", full);
    if (full && win.parentElement !== document.body) document.body.appendChild(win);
    else if (!full && win.parentElement !== container) container.appendChild(win);
    if (visible && !collapsed) unread[state.tab] = 0;
    for (const id in tabBadges) setBadge(tabBadges[id], unread[id]);
    const total = unread.rolls + unread.chat;
    setBadge(fabBadge, total);
    // Точка на кнопке: число там общее с бросками и не говорит, что кто-то написал.
    fab.classList.toggle("has-unread", unread.chat > 0);
    if (chat) chat.setViewing(visible && !collapsed && state.tab === "chat");
    // В шапке сумма только у свёрнутого окна: у развёрнутого счётчики на вкладках.
    setBadge(headBadge, collapsed || !chat ? total : 0);
    if (visible) place();
  }

  // focus только по клику на вкладку: кнопка «Чат» на телефоне не должна сразу выкатывать клавиатуру.
  function scrollActive(focus = false) {
    body.scrollTop = body.scrollHeight;
    if (focus && chat && state.tab === "chat") chat.focus();
  }

  fab.onclick = () => {
    state.mode = "open";
    shown = true;
    save();
    render();
    scrollActive();
  };
  closeBtn.onclick = () => {
    state.mode = "closed";
    shown = false;
    save();
    render();
  };
  collapseBtn.onclick = () => {
    state.mode = state.mode === "collapsed" ? "open" : "collapsed";
    save();
    render();
    if (state.mode === "open") body.scrollTop = body.scrollHeight;
  };

  let start = null;
  attachDrag(head, {
    onStart: () => {
      start = { x: state.x, y: state.y };
    },
    onMove: (dx, dy) => {
      if (win.classList.contains("roll-log-win--full")) return; // во весь экран таскать нечего
      const { W, H } = hostSize();
      state.x = Math.max(0, Math.min(start.x + dx, W - win.offsetWidth));
      state.y = Math.max(0, Math.min(start.y + dy, H - win.offsetHeight));
      place();
    },
    onEnd: save,
  });
  attachDrag(grip, {
    onStart: () => {
      start = { w: state.w, h: state.h };
    },
    onMove: (dx, dy) => {
      const { W, H } = hostSize();
      state.w = Math.max(MIN_W, Math.min(start.w + dx, W - state.x));
      state.h = Math.max(MIN_H, Math.min(start.h + dy, H - state.y));
      place();
    },
    onEnd: save,
  });
  head.addEventListener("dblclick", (e) => {
    if (!e.target.closest("button")) collapseBtn.onclick();
  });

  // Канвас сжался (панели, поворот телефона) — окно не должно остаться за краем.
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => !win.hidden && place()).observe(container);
  // Поворот телефона / ресайз — окно переезжает между плашкой и полным экраном.
  if (fullMedia && fullMedia.addEventListener) fullMedia.addEventListener("change", () => render());

  function push(data) {
    body.appendChild(renderCard(data));
    while (body.children.length > max) body.removeChild(body.firstChild);
    if (!(isVisible() && state.tab === "rolls")) unread.rolls += 1;
    if (state.mode === "open") shown = true;
    render();
    // Roll20-поведение: свежий бросок всегда виден, старые уезжают вверх.
    body.scrollTop = body.scrollHeight;
  }

  function clear() {
    body.replaceChildren();
    unread.rolls = 0;
    render();
  }

  render();
  return { push, clear, el: container, chat };
}

function load(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "null");
    if (!v || typeof v !== "object") return {};
    const out = {};
    for (const k of ["x", "y", "w", "h"]) if (Number.isFinite(v[k])) out[k] = v[k];
    if (["open", "collapsed", "closed"].includes(v.mode)) out.mode = v.mode;
    if (["rolls", "chat"].includes(v.tab)) out.tab = v.tab;
    return out;
  } catch {
    return {};
  }
}

function renderCard({ name, label, formula, rolls, modifier, total, hidden }) {
  const card = document.createElement("div");
  card.className = "roll-card" + (hidden ? " is-hidden" : "");

  const who = document.createElement("div");
  who.className = "roll-card-who";
  // label — необязательная подпись броска ("Атлетика", "Спасбросок Ловкости",
  // "Гоблин — Укус"), см. internal/domain/message.go: ClientMsg.Label.
  who.textContent = label ? `${name} — ${label}` : name;
  if (hidden) {
    who.insertAdjacentHTML("afterbegin", icon("eye-off", { size: 12 }));
    who.title = "Скрытый бросок — видят ДМ и бросивший";
  }
  card.appendChild(who);

  const recipe = document.createElement("div");
  recipe.className = "roll-card-formula";
  recipe.textContent = formula;
  card.appendChild(recipe);

  const brk = document.createElement("div");
  brk.className = "roll-card-break";

  const list = rolls || [];
  if (list.length) {
    // rollGroups раскладывает плоский список значений обратно по членам формулы
    // (см. dice.js). null — формулу не разобрать: показываем значения как есть,
    // без подсветки крит/провал (не знаем граней кости).
    const groups = rollGroups(formula, list);
    const dice = groups
      ? groups.flatMap((g) => g.values.map((v) => ({ v, sides: g.sides })))
      : list.map((v) => ({ v, sides: 0 }));
    for (const d of dice) {
      const die = document.createElement("span");
      die.className = "roll-die";
      // Крит/провал подсвечиваем только на натуральной d20 — как в Foundry.
      if (d.sides === 20 && d.v === 20) die.classList.add("is-crit");
      else if (d.sides === 20 && d.v === 1) die.classList.add("is-fumble");
      die.textContent = d.v;
      brk.appendChild(die);
    }
    if (modifier) {
      const op = document.createElement("span");
      op.className = "roll-op";
      op.textContent = (modifier > 0 ? "+ " : "− ") + Math.abs(modifier);
      brk.appendChild(op);
    }
  }
  // Периодический модификатор без кости («−1» от кровотечения, см.
  // service.Room.applyPeriodicModifiers) шлёт пустой rolls — кидать нечего,
  // число уже готово: показываем только итог.

  const eq = document.createElement("span");
  eq.className = "roll-eq";
  eq.append("= ");
  const strong = document.createElement("b");
  strong.textContent = total;
  eq.appendChild(strong);
  brk.appendChild(eq);

  card.appendChild(brk);
  return card;
}
