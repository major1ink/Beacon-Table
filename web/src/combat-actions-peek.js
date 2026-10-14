// combat-actions-peek.js — «чем этот монстр ходит» одним взглядом, не открывая
// полную карточку: попап у строки инициативы, в котором только боевые блоки
// статблока (особенности/действия/бонусные/реакции/легендарные/логово) плюс
// короткая строка скорости-чувств и характеристики.
//
// Зачем отдельно от карточки бестиария: в ядре Foundry такого нет вообще —
// там за действиями идут в лист существа, то есть в отдельное окно, которое
// надо открыть, найти вкладку и потом закрыть; всё, чем это лечат за
// реальными столами, — сторонние модули (Token Action HUD и подобные). Нам
// дешевле сделать это сразу: посреди чужого хода нужен не весь статблок, а
// три строки «Ятаган. +4 к попаданию, 1к6+2».
//
// Данные — уже готовые markdown-поля domain.Monster (см. internal/domain/
// monster.go: Traits/Actions/…), рендерим тем же renderNoteHtml + enhanceRolls,
// что и полная карточка (pages/bestiary.js), поэтому формулы внутри
// кликабельны и кидают кубы тем же сообщением "roll_dice", что кнопки 🎲 в
// бестиарии. Ссылки .catalog-ref (@UUID из модулей Foundry) тоже живые —
// wireCatalogLinks, как и везде.
//
// Попап собирается по схеме существа (internal/schema): плитки
// характеристик и поля боевой части (schema-summary.js: compactStats,
// peekSections), кубы — кнопками.
//
// Своей истины модуль не держит: статблок тянется с сервера по monsterId и
// кэшируется на время жизни страницы — правка статблока в соседнем окне
// посреди боя это редкость, а лишний запрос на каждое открытие попапа — нет.
// Монтируется в двух местах сразу (встроенная панель ДМ-стола и вынесенное
// окно combat-tracker.html), поэтому CSS инжектится из JS — тот же приём и
// та же причина, что у status-palette.js.
import { fetchMonster } from "./api.js";
import { wireCatalogLinks } from "./catalog-links.js";
import { combatantCardHint, openCombatantCard } from "./combatant-card.js";
import { icon } from "./icons.js";
import { enhanceRolls } from "./inline-rolls.js";
import { renderNoteHtml } from "./notes/markdown.js";
import { withRollMode } from "./roll-mode.js";
import { compileSchema, createEvaluator } from "./schema-formula.js";
import { getPath } from "./schema-layout.js";
import { cardSubtitle, displayValue } from "./schema-list.js";
import { compactStats, peekSections } from "./schema-summary.js";
import { loadSchemas, schemaFor } from "./schemas.js";

const CSS = `
.actions-peek {
  position: fixed; z-index: 60; width: 360px; max-width: calc(100vw - 16px); max-height: 74vh; overflow: auto;
  display: flex; flex-direction: column; gap: 8px; padding: 10px 12px 12px;
  background: var(--glass-bg-strong);
  border: 1px solid var(--glass-border); border-radius: var(--radius);
  box-shadow: var(--shadow-float); color: var(--text); font-size: 12.5px; line-height: 1.45;
}
.actions-peek-head { display: flex; align-items: center; gap: 6px; position: sticky; top: -10px; padding: 10px 0 6px; margin: -10px 0 0; background: inherit; }
.actions-peek-name { flex: 1 1 auto; min-width: 0; font-weight: 700; font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.actions-peek-head button {
  flex: 0 0 auto; background: none; border: none; color: var(--text-dim); cursor: pointer; padding: 3px;
  display: flex; align-items: center;
}
.actions-peek-head button:hover { color: var(--text); }
.actions-peek-meta { font-size: 11.5px; opacity: 0.75; }
.actions-peek-meta strong { opacity: 0.7; font-weight: 600; }
.actions-peek-ability {
  display: flex; flex-direction: column; align-items: center; gap: 1px; padding: 3px 0;
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface);
}
.actions-peek-ability span:first-child { font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.55; }
.actions-peek-ability span:last-child { font-size: 11.5px; font-weight: 700; }
.actions-peek-stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(64px, 1fr)); gap: 4px; }
.actions-peek-stats .actions-peek-ability span:first-child { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.actions-peek-rolls { display: flex; flex-wrap: wrap; gap: 4px; }
.actions-peek-roll {
  padding: 2px 8px; border: 1px solid var(--border); border-radius: var(--radius-pill); background: var(--surface);
  color: var(--text); font-size: 11.5px; cursor: pointer;
}
.actions-peek-roll b { color: var(--accent); margin-left: 4px; }
.actions-peek-roll:hover:not(:disabled) { border-color: var(--accent); }
.actions-peek-title {
  font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.55;
  border-bottom: 1px solid var(--border); padding-bottom: 2px; margin-top: 2px;
}
.actions-peek-block p { margin: 3px 0; }
.actions-peek-block ul, .actions-peek-block ol { margin: 3px 0; padding-left: 18px; }
.actions-peek-block strong, .actions-peek-block em { color: var(--text); }
.actions-peek .inline-roll {
  color: var(--accent); text-decoration: none; border-bottom: 1px dashed var(--accent);
  cursor: pointer; font-weight: 600;
}
.actions-peek .inline-roll:hover { color: #fff; background: var(--accent); border-radius: 3px; border-bottom-color: transparent; }
.actions-peek .catalog-ref { color: var(--accent); cursor: pointer; }
.actions-peek-hint { opacity: 0.6; font-size: 11.5px; }
/* Закреплённый (следящий) попап — не у курсора, а в правом нижнем углу
   карты: он живёт весь бой и переоткрывается сам на каждом ходу, поэтому
   стоит на постоянном месте, где ничего не перекрывает (сверху справа —
   лог бросков, снизу — плашка сцены и зум).
   z-index ниже сайд-меню (vtt/side-menu.js: column z-index 41) и комбат-бара:
   выезжающие справа панели («Кубы», «Справочник») открываются поверх него,
   а не уезжают под него — в отличие от НЕзакреплённого попапа (z-index 60),
   который пользователь открыл сам у курсора и ждёт увидеть сверху. */
.actions-peek-pinned { right: 56px; bottom: 52px; max-height: 62vh; z-index: 39; }
.actions-peek-turn {
  flex: 0 0 auto; font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em;
  padding: 2px 6px; border-radius: var(--radius-pill); background: var(--accent-bg, rgba(124,108,240,0.18));
  color: var(--accent); font-weight: 700;
}
`;

let cssInjected = false;
function ensureCSS() {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
}

// monsterCache — id -> Promise<Monster>. Промис, а не готовый объект: два
// быстрых открытия подряд не должны слать два запроса.
const monsterCache = new Map();
function loadMonster(id) {
  if (!monsterCache.has(id)) monsterCache.set(id, fetchMonster(id));
  return monsterCache.get(id);
}

// invalidateActionsPeek — сбросить кэш статблоков (ДМ поправил монстра в
// соседнем окне, см. "beacon:monsterSaved" в pages/dm.js).
export function invalidateActionsPeek(monsterId) {
  if (monsterId) monsterCache.delete(monsterId);
  else monsterCache.clear();
}

let openPeek = null; // { el, combatantId, pinned }

export function closeActionsPeek() {
  if (!openPeek) return;
  openPeek.el.remove();
  openPeek = null;
}

// isActionsPeekOpen — по id БОЙЦА, а не монстра: "Гоблин-воитель" и
// "Гоблин-воитель 2" — один monsterId и два разных бойца, и повторный клик
// по второму не должен считаться повторным кликом по первому.
export function isActionsPeekOpen(combatantId) {
  return !!openPeek && (!combatantId || openPeek.combatantId === combatantId);
}

// openActionsPeek — показать попап.
//
//   combatant — боец из combat_state (нужны monsterId и name);
//   send      — функция отправки WS-команды (тем же каналом уходят броски);
//   x, y      — где открыть (обычно координаты клика по кнопке в трекере);
//   pinned    — режим "следить за ходом": попап встаёт на постоянное место в
//               углу карты, не закрывается кликом мимо и Esc и живёт, пока
//               его не сменит следующий ход (см. combat-panel.js: syncFollow).
//               Точка (x, y) в этом режиме не нужна.
export async function openActionsPeek({ x, y, combatant, send, pinned = false }) {
  ensureCSS();
  if (!combatant || !combatant.monsterId) return;
  // Повторный клик по той же кнопке закрывает попап — это переключатель, а
  // не «открыть ещё один». К следящему попапу это не относится: он
  // переоткрывается сам на каждом ходу, и "закрыться, потому что боец тот
  // же" ему нельзя (иначе ходьба по кругу гасила бы его через раз).
  if (!pinned && isActionsPeekOpen(combatant.id)) {
    closeActionsPeek();
    return;
  }
  closeActionsPeek();

  const el = document.createElement("div");
  el.className = "actions-peek" + (pinned ? " actions-peek-pinned" : "");
  document.body.appendChild(el);
  openPeek = { el, combatantId: combatant.id, pinned };
  el.textContent = "Загрузка…";
  if (!pinned) position(el, x, y);

  let monster;
  try {
    [monster] = await Promise.all([loadMonster(combatant.monsterId), loadSchemas()]);
  } catch (err) {
    if (!openPeek || openPeek.el !== el) return;
    el.textContent = "Не удалось загрузить статблок: " + err.message;
    return;
  }
  if (!openPeek || openPeek.el !== el) return; // успели закрыть, пока грузилось
  render(el, monster, combatant, send, pinned);
  if (!pinned) position(el, x, y); // высота стала известна только сейчас — вписываем в экран заново
}

// position — держим попап в пределах окна (у нижнего/правого края
// разворачиваем вверх/влево), как это уже делает палитра состояний.
function position(el, x, y) {
  const w = el.offsetWidth || 360;
  const h = el.offsetHeight || 320;
  el.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + "px";
  el.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + "px";
}

// compiledMonster — схема существа системы мира, разобранная один раз.
let compiledFor = null;
let compiledCache = null;
function compiledMonster() {
  const schema = schemaFor("monster");
  if (schema !== compiledFor) {
    compiledFor = schema;
    compiledCache = schema ? compileSchema(schema) : null;
  }
  return compiledCache;
}

function render(el, monster, combatant, send, pinned) {
  el.textContent = "";

  // sendRoll — тот же контракт, что у бестиария (pages/bestiary.js): имя
  // существа в подпись броска, чтобы в общем логе было видно, кто кидал.
  const sendRoll = (formula, label) => {
    const full = `${combatant.name} — ${label || ""}`.trim().replace(/ —$/, "");
    send(withRollMode({ type: "roll_dice", formula, label: full }));
  };

  const compiled = compiledMonster();
  el.appendChild(renderHead(combatant, cardSubtitle(compiled, monster), pinned));
  renderSchemaBody(el, compiled, monster, sendRoll);
}

function renderHead(combatant, subtitle, pinned) {
  const head = document.createElement("div");
  head.className = "actions-peek-head";
  const name = document.createElement("div");
  name.className = "actions-peek-name";
  name.textContent = combatant.name;
  name.title = subtitle;

  head.appendChild(name);
  if (pinned) {
    // Метка "ходит" — чтобы попап в углу не читался как случайно забытый
    // открытым статблок: он показывает именно того, чей сейчас ход.
    const turn = document.createElement("span");
    turn.className = "actions-peek-turn";
    turn.textContent = "ходит";
    head.appendChild(turn);
  }

  const fullBtn = document.createElement("button");
  fullBtn.type = "button";
  fullBtn.title = combatantCardHint(combatant) + " целиком";
  fullBtn.innerHTML = icon("expand", { size: 13 });
  fullBtn.onclick = () => {
    closeActionsPeek();
    openCombatantCard(combatant, { isDM: true });
  };

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  // В следящем режиме ✕ — это "убрать с глаз до следующего хода", а не
  // "выключить слежение": слежение гасится своей кнопкой в трекере.
  closeBtn.title = pinned ? "Закрыть (вернётся на следующем ходу)" : "Закрыть";
  closeBtn.innerHTML = icon("close", { size: 13 });
  closeBtn.onclick = () => closeActionsPeek();

  head.appendChild(fullBtn);
  head.appendChild(closeBtn);
  return head;
}

const EMPTY_HINT = "В статблоке не заполнены действия — открой карточку целиком и допиши.";

function hintLine(text) {
  const node = document.createElement("div");
  node.className = "actions-peek-hint";
  node.textContent = text;
  return node;
}

// metaLine — «Метка: значение» мелкой строкой; модификаторы и формулы в
// значении кликабельны ("+5" в спасбросках/навыках — тоже бросок).
function metaLine(label, value, sendRoll) {
  const line = document.createElement("div");
  line.className = "actions-peek-meta";
  const strong = document.createElement("strong");
  strong.textContent = label + ": ";
  line.append(strong, String(value));
  enhanceRolls(line, sendRoll);
  return line;
}

function titleLine(text) {
  const h = document.createElement("div");
  h.className = "actions-peek-title";
  h.textContent = text;
  return h;
}

function textBlock(raw, sendRoll) {
  const body = document.createElement("div");
  body.className = "actions-peek-block";
  body.innerHTML = renderNoteHtml(raw);
  enhanceRolls(body, sendRoll);
  wireCatalogLinks(body);
  return body;
}

function abilityCell(label, value) {
  const cell = document.createElement("div");
  cell.className = "actions-peek-ability";
  const l = document.createElement("span");
  l.textContent = label;
  l.title = label;
  const v = document.createElement("span");
  v.textContent = value;
  cell.append(l, v);
  return cell;
}

// rollButton — бросок схемы кнопкой: r — уже посчитанная формула
// (schema-formula.js: createEvaluator → rollField / row().dice()).
function rollButton(name, r, sendRoll) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "actions-peek-roll";
  b.title = r.error ? r.error.message : "Бросить " + r.formula;
  const bold = document.createElement("b");
  bold.textContent = r.error ? "!" : r.formula;
  b.append(name, bold);
  b.disabled = !!r.error || !r.dice;
  b.onclick = () => sendRoll(r.formula, name);
  return b;
}

// schemaRolls — кнопки бросков поля: кубы и броски — одна кнопка, таблица
// с колонкой кубов — кнопка на строку (подпись — первая текстовая колонка).
function schemaRolls(compiled, monster, ev, id, sendRoll) {
  const f = compiled.schema.fields[id];
  if (f.type === "dice" || f.type === "roll") {
    if (f.type === "dice" && !String(getPath(monster, f.path) ?? "").trim()) return [];
    return [rollButton(f.label, ev.rollField(id), sendRoll)];
  }
  const dice = (f.columns || []).find((c) => c.type === "dice" || c.type === "roll");
  if (!dice) return [];
  const title = (f.columns || []).find((c) => c.type === "text");
  const rows = getPath(monster, f.path);
  const out = [];
  (Array.isArray(rows) ? rows : []).forEach((row, i) => {
    if (dice.type === "dice" && !String(getPath(row, dice.path) ?? "").trim()) return;
    const name = (title && String(getPath(row, title.path) || "").trim()) || f.label;
    out.push(rollButton(name, ev.row(id, i).dice(dice.id), sendRoll));
  });
  return out;
}

// renderSchemaBody — попап по схеме существа: плитки характеристик
// (schema-summary.js: compactStats), затем секции боевой части
// (peekSections) — простые поля строками, длинные тексты блоками, кубы и
// броски кнопками. Формулы — по карточке, без модификаторов, как в самой
// карточке.
function renderSchemaBody(el, compiled, monster, sendRoll) {
  const tiles = compactStats(compiled, monster, []);
  if (tiles.length) {
    const grid = document.createElement("div");
    grid.className = "actions-peek-stats";
    for (const t of tiles) grid.appendChild(abilityCell(t.label, t.note ? `${t.value} (${t.note})` : t.value));
    el.appendChild(grid);
    enhanceRolls(grid, sendRoll);
  }

  const { fields } = compiled.schema;
  const ev = createEvaluator(compiled, monster, []);
  let any = false;
  for (const sec of peekSections(compiled)) {
    const nodes = [];
    const rolls = [];
    for (const id of sec.fields) {
      const f = fields[id];
      if (f.type === "longtext") {
        const raw = displayValue(compiled, monster, id, ev);
        if (raw.trim()) nodes.push(textBlock(raw, sendRoll));
      } else if (f.type === "dice" || f.type === "roll" || f.type === "table") {
        rolls.push(...schemaRolls(compiled, monster, ev, id, sendRoll));
      } else {
        const value = displayValue(compiled, monster, id, ev);
        if (value !== "") nodes.push(metaLine(f.label, value, sendRoll));
      }
    }
    if (rolls.length) {
      const wrap = document.createElement("div");
      wrap.className = "actions-peek-rolls";
      wrap.append(...rolls);
      nodes.push(wrap);
    }
    if (!nodes.length) continue;
    any = true;
    if (sec.title) el.appendChild(titleLine(sec.title));
    el.append(...nodes);
  }
  if (!any && !tiles.length) el.appendChild(hintLine(EMPTY_HINT));
}

// Клик мимо и Esc закрывают попап — тот же контракт, что у палитры
// состояний и контекстного меню токена. Слушатели вешаются один раз на
// модуль: попап в документе всегда максимум один.
document.addEventListener(
  "pointerdown",
  (e) => {
    if (openPeek && !openPeek.pinned && !openPeek.el.contains(e.target)) closeActionsPeek();
  },
  true
);
document.addEventListener("keydown", (e) => {
  // Esc на карте отменяет ещё и текущий инструмент ДМ — закреплённый попап
  // он гасить не должен, иначе тот исчезал бы от любой отмены.
  if (e.key === "Escape" && openPeek && !openPeek.pinned) closeActionsPeek();
});
