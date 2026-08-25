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

const CSS = `
.actions-peek {
  position: fixed; z-index: 60; width: 360px; max-width: calc(100vw - 16px); max-height: 74vh; overflow: auto;
  display: flex; flex-direction: column; gap: 8px; padding: 10px 12px 12px;
  background: var(--glass-bg-strong); backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
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
.actions-peek-abilities { display: grid; grid-template-columns: repeat(6, 1fr); gap: 4px; }
.actions-peek-ability {
  display: flex; flex-direction: column; align-items: center; gap: 1px; padding: 3px 0;
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface);
}
.actions-peek-ability span:first-child { font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.55; }
.actions-peek-ability span:last-child { font-size: 11.5px; font-weight: 700; }
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
   лог бросков, снизу — плашка сцены и зум). */
.actions-peek-pinned { right: 56px; bottom: 52px; max-height: 62vh; }
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

const ABILITY_LABELS = [
  ["str", "СИЛ"],
  ["dex", "ЛОВ"],
  ["con", "ТЕЛ"],
  ["int", "ИНТ"],
  ["wis", "МДР"],
  ["cha", "ХАР"],
];

function fmtMod(n) {
  return n >= 0 ? "+" + n : String(n);
}

// BLOCKS — что и в каком порядке показываем. Ровно боевая часть статблока:
// описание/лор сюда не идёт (за ним — полная карточка), заклинания и
// инвентарь тоже: их рендер живёт в bestiary.js и тянет свои запросы.
const BLOCKS = [
  ["Особенности", (m) => m.traits],
  ["Действия", (m) => m.actions],
  ["Бонусные действия", (m) => m.bonusActions],
  ["Реакции", (m) => m.reactions],
  // Вступление к легендарным ("может совершить 3 легендарных действия…")
  // склеиваем с самими действиями ПУСТОЙ СТРОКОЙ, а не оборачиваем в <p>:
  // после HTML-блока marked считает следующие строки его продолжением и
  // markdown в них уже не разбирает — жирные названия действий остались бы
  // текстом "**Рывок.**".
  ["Легендарные действия", (m) => [m.legendaryActionsIntro, m.legendaryActions].filter(Boolean).join("\n\n")],
  ["Логово", (m) => m.lairActions],
];

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
    monster = await loadMonster(combatant.monsterId);
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

function render(el, monster, combatant, send, pinned) {
  el.textContent = "";

  // sendRoll — тот же контракт, что у бестиария (pages/bestiary.js): имя
  // существа в подпись броска, чтобы в общем логе было видно, кто кидал.
  const sendRoll = (formula, label) => {
    const full = `${combatant.name} — ${label || ""}`.trim().replace(/ —$/, "");
    send({ type: "roll_dice", formula, label: full });
  };

  const head = document.createElement("div");
  head.className = "actions-peek-head";
  const name = document.createElement("div");
  name.className = "actions-peek-name";
  name.textContent = combatant.name;
  name.title = [monster.size, monster.type, monster.cr ? "ПО " + monster.cr : ""].filter(Boolean).join(", ");

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
  el.appendChild(head);

  // Строки, которых нет в карточке бойца трекера (КД/HP/инициатива там уже
  // есть, и дублировать их незачем): скорость, чувства, спасброски, навыки.
  for (const [label, value] of [
    ["Скорость", monster.speed],
    ["Чувства", monster.senses],
    ["Спасброски", monster.savingThrows],
    ["Навыки", monster.skills],
    ["Иммунитет к состояниям", monster.conditionImmunities],
    ["Сопротивление урону", monster.damageResistances],
    ["Иммунитет к урону", monster.damageImmunities],
    ["Уязвимость к урону", monster.damageVulnerabilities],
  ]) {
    if (!value || !String(value).trim()) continue;
    const line = document.createElement("div");
    line.className = "actions-peek-meta";
    const strong = document.createElement("strong");
    strong.textContent = label + ": ";
    line.append(strong, String(value));
    el.appendChild(line);
    enhanceRolls(line, sendRoll); // "+5" в спасбросках/навыках — тоже бросок
  }

  const abilities = monster.abilities || {};
  const grid = document.createElement("div");
  grid.className = "actions-peek-abilities";
  for (const [key, label] of ABILITY_LABELS) {
    const score = abilities[key] ?? 10;
    const cell = document.createElement("div");
    cell.className = "actions-peek-ability";
    const l = document.createElement("span");
    l.textContent = label;
    const v = document.createElement("span");
    v.textContent = `${score} (${fmtMod(Math.floor((score - 10) / 2))})`;
    cell.append(l, v);
    grid.appendChild(cell);
  }
  el.appendChild(grid);
  enhanceRolls(grid, sendRoll); // клик по модификатору = проверка характеристики

  let any = false;
  for (const [title, get] of BLOCKS) {
    const raw = get(monster);
    if (!raw || !String(raw).trim()) continue;
    any = true;
    const h = document.createElement("div");
    h.className = "actions-peek-title";
    h.textContent = title;
    const body = document.createElement("div");
    body.className = "actions-peek-block";
    body.innerHTML = renderNoteHtml(raw);
    enhanceRolls(body, sendRoll);
    wireCatalogLinks(body);
    el.append(h, body);
  }
  if (!any) {
    const hint = document.createElement("div");
    hint.className = "actions-peek-hint";
    hint.textContent = "В статблоке не заполнены действия — открой карточку целиком и допиши.";
    el.appendChild(hint);
  }
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
