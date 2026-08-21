// status-palette.js — «быстрое меню состояний» ДМ: сетка иконок всех
// состояний текущего мира, ЛКМ — повесить/снять, ПКМ — подробности
// (уровень, длительность, «только для ДМ»). Прямой аналог палитры статусов
// в Token HUD у Foundry, но монтируется в трёх местах сразу:
//
//   1. ПКМ по токену на карте → пункт «Состояния» (web/src/pages/dm.js);
//   2. карточка бойца в трекере инициативы (web/src/combat-panel.js) — она
//      же работает и в вынесенном окне combat-tracker.html;
//   3. чип «Накладывает: …» в карточке заклинания — там палитра не нужна,
//      применяется сразу один конкретный slug (см. applySpellStatus ниже).
//
// Общий модуль по тому же принципу, что и combat-panel.js: сюда передают
// send (функция отправки WS-команды) и цель, а КТО его вызвал — dm.html или
// combat-tracker.html — модуль не знает и знать не должен.
//
// Своей истины модуль не держит вообще: список наложенных меток приходит с
// сервера (scene/combat_state), палитра только шлёт команды и перерисовывает
// себя по свежим данным (см. refreshOpenPalette).
import { fetchConditions } from "./api.js";
import { icon } from "./icons.js";
import { describeModifier, loadModifierTargets } from "./modifier-editor.js";

// ---- CSS ----
// Стили инжектятся из JS, а не лежат в dm.html, потому что палитра нужна
// сразу на нескольких страницах (dm.html, combat-tracker.html, а через
// combat-panel.js — везде, где он смонтирован). Копировать один и тот же
// блок в каждый html — ровно та беда, ради которой compendium/combat-панели
// в своё время и переехали в общие модули. Инжектится один раз на документ.
const CSS = `
.status-palette {
  position: fixed; z-index: 60; width: 296px; max-height: 72vh; overflow: auto;
  display: flex; flex-direction: column; gap: 8px; padding: 10px;
  background: var(--glass-bg-strong); backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid var(--glass-border); border-radius: var(--radius);
  box-shadow: var(--shadow-float); color: var(--text); font-size: 13px;
}
.status-palette-head { display: flex; align-items: center; gap: 6px; }
.status-palette-head input {
  flex: 1; min-width: 0; padding: 5px 8px; border-radius: var(--radius);
  border: 1px solid var(--border); background: var(--surface); color: var(--text);
}
.status-palette-close { background: none; border: none; color: var(--text-dim); cursor: pointer; padding: 2px; }
.status-palette-close:hover { color: var(--text); }
.status-palette-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 5px; }
.status-cell {
  position: relative; aspect-ratio: 1; display: flex; align-items: center; justify-content: center;
  font-size: 19px; line-height: 1; cursor: pointer; user-select: none;
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--surface); opacity: 0.5; transition: opacity .12s, box-shadow .12s;
}
.status-cell:hover { opacity: 0.85; background: var(--surface-hover); }
.status-cell.active { opacity: 1; box-shadow: inset 0 0 0 2px var(--cell-color, var(--accent)); }
.status-cell img { width: 76%; height: 76%; object-fit: contain; }
.status-cell-level {
  position: absolute; right: 1px; bottom: 0; font-size: 10px; font-weight: 700;
  padding: 0 3px; border-radius: var(--radius-pill); background: var(--bg); color: var(--text);
}
.status-cell-rounds {
  position: absolute; left: 1px; top: 0; font-size: 9px; padding: 0 3px;
  border-radius: var(--radius-pill); background: var(--bg); color: var(--text-dim);
}
.status-palette-detail {
  display: flex; flex-direction: column; gap: 6px; padding: 8px;
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel-bg);
}
.status-palette-detail h4 { margin: 0; font-size: 13px; }
.status-palette-detail p { margin: 0; font-size: 12px; color: var(--text-dim); }
.status-palette-row { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.status-palette-row input[type="number"] {
  width: 62px; padding: 3px 5px; border-radius: var(--radius);
  border: 1px solid var(--border); background: var(--surface); color: var(--text);
}
.status-palette-foot { display: flex; gap: 6px; }
.status-palette-foot button {
  flex: 1; padding: 5px 8px; border-radius: var(--radius); border: 1px solid var(--border);
  background: var(--surface); color: var(--text); cursor: pointer; font-size: 12px;
}
.status-palette-foot button:hover { background: var(--surface-hover); }
.status-palette-empty { color: var(--text-dim); font-size: 12px; margin: 0; }
/* чипы наложенных меток — карточка бойца в трекере, лист персонажа */
.status-chips { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.status-chip {
  display: inline-flex; align-items: center; gap: 3px; padding: 1px 6px 1px 4px;
  border-radius: var(--radius-pill); background: var(--surface); color: var(--text);
  border: 1px solid var(--chip-color, var(--border)); font-size: 11px; line-height: 1.6;
  cursor: default; max-width: 100%;
}
.status-chip.clickable { cursor: pointer; }
.status-chip.clickable:hover { background: var(--surface-hover); }
.status-chip img { width: 12px; height: 12px; object-fit: contain; }
.status-chip-add {
  display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px;
  border-radius: var(--radius-pill); border: 1px dashed var(--border); background: none;
  color: var(--text-dim); cursor: pointer; padding: 0;
}
.status-chip-add:hover { color: var(--text); border-color: var(--text-dim); }
`;

let cssInjected = false;
function ensureCSS() {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
}

// ---- справочник состояний ----
// Кэш на страницу: палитра открывается часто (в бою — на каждое второе
// действие), а список меняется только когда ДМ правит его в конструкторе.
// invalidateConditions() зовут оттуда через событие ниже.
let conditionsCache = null;
let conditionsPromise = null;

export async function loadConditions() {
  if (conditionsCache) return conditionsCache;
  if (!conditionsPromise) {
    conditionsPromise = fetchConditions()
      .then((list) => {
        conditionsCache = Array.isArray(list) ? list : [];
        return conditionsCache;
      })
      .catch(() => [])
      .finally(() => {
        conditionsPromise = null;
      });
  }
  return conditionsPromise;
}

export function invalidateConditions() {
  conditionsCache = null;
}

// Конструктор состояний (conditions.html) живёт в отдельном плавающем окне и
// сообщает о правке тем же postMessage-механизмом, что и остальные карточки
// (см. floating-window.js: postToOpenWindows, "beacon:*Saved") — ловим его и
// сбрасываем кэш, чтобы палитра не показывала старое имя/иконку.
window.addEventListener("message", (e) => {
  if (e.data && e.data.type === "beacon:conditionSaved") invalidateConditions();
});

// ---- вспомогательное ----

// statusVisual — общий рендер «картинка или глиф» для ячейки палитры и для
// чипа: у карточки может быть свой арт (Condition.ImageURL), иначе рисуем
// эмодзи (Condition.Icon). Тот же контракт, что и на стороне сцены (см.
// web/src/vtt/layers/tokens.js) — оба места читают одни и те же два поля.
function statusVisual(st, alt) {
  if (st && st.imageUrl) {
    const img = document.createElement("img");
    img.src = st.imageUrl;
    img.alt = alt || "";
    return img;
  }
  const span = document.createElement("span");
  span.textContent = (st && st.icon) || "❔";
  return span;
}

// statusTargetMsg — цель команды: ровно одно из двух полей (см.
// domain.ClientMsg и room_statuses.go: resolveStatusTarget).
function targetFields(target) {
  return target.tokenId ? { tokenId: target.tokenId } : { combatantId: target.combatantId };
}

// ---- чипы наложенных меток ----

// renderStatusChips — строка чипов «что сейчас висит». Используется в
// карточке бойца трекера и на листе персонажа. onAdd (если передан)
// дорисовывает кнопку «+», открывающую палитру; onRemove делает чипы
// кликабельными на снятие. Игроку передают ни то, ни другое — он видит
// только текст (наложение состояний доступно лишь ДМ, см. Room.authorize).
export function renderStatusChips(statuses, { onAdd, onRemove, addTitle } = {}) {
  ensureCSS();
  const wrap = document.createElement("div");
  wrap.className = "status-chips";
  for (const st of statuses || []) {
    const chip = document.createElement("span");
    chip.className = "status-chip" + (onRemove ? " clickable" : "");
    if (st.color) chip.style.setProperty("--chip-color", st.color);
    chip.appendChild(statusVisual(st, st.name));
    const label = document.createElement("span");
    label.textContent = st.name + (st.level ? ` ${st.level}` : "") + (st.rounds ? ` · ${st.rounds}р` : "");
    chip.appendChild(label);
    const hints = [st.source, st.hidden ? "только для ДМ" : ""].filter(Boolean);
    chip.title = hints.length ? `${st.name} (${hints.join("; ")})` : st.name;
    if (st.hidden) chip.style.opacity = "0.6";
    if (onRemove) chip.onclick = () => onRemove(st);
    wrap.appendChild(chip);
  }
  if (onAdd) {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "status-chip-add";
    add.innerHTML = icon("plus", { size: 12 });
    add.title = addTitle || "Наложить состояние";
    add.onclick = (e) => {
      e.stopPropagation();
      onAdd(e);
    };
    wrap.appendChild(add);
  }
  return wrap;
}

// ---- сама палитра ----

let openPalette = null; // { el, target, send, statusesFor, detailSlug }

// closeStatusPalette — закрыть открытую палитру (её же зовёт клик мимо/Esc).
export function closeStatusPalette() {
  if (!openPalette) return;
  openPalette.el.remove();
  openPalette = null;
}

// refreshStatusPalette — перерисовать открытую палитру по свежему состоянию
// с сервера. Зовётся из dm.js/combat-panel.js на "vtt:sceneUpdated"/
// "vtt:combatState": палитра не хранит наложенные метки у себя, она их
// каждый раз перечитывает через statusesFor() (см. openStatusPalette).
export function refreshStatusPalette() {
  if (openPalette) renderPalette(openPalette);
}

// openStatusPalette — показать палитру у точки (x, y) экрана.
//
//   target      — { tokenId } либо { combatantId } (см. targetFields);
//   send        — функция отправки WS-команды;
//   statusesFor — () => массив наложенных меток цели ПРЯМО СЕЙЧАС; именно
//                 функция, а не массив: пока палитра открыта, состояние
//                 приходит с сервера ещё несколько раз, и читать его надо
//                 в момент отрисовки (тот же приём, что у «vtt:toggleTokenLight»
//                 в dm.js — там ровно эта проблема уже ловилась);
//   title       — подпись цели в шапке («Гоблин 2»).
export async function openStatusPalette({ x, y, target, send, statusesFor, title }) {
  ensureCSS();
  closeStatusPalette();
  const el = document.createElement("div");
  el.className = "status-palette";
  document.body.appendChild(el);
  openPalette = { el, target, send, statusesFor, title, detailSlug: "", filter: "" };
  positionPalette(el, x, y);
  el.textContent = "Загрузка…";
  await Promise.all([loadConditions(), loadModifierTargets()]);
  if (!openPalette || openPalette.el !== el) return; // успели закрыть, пока грузились
  renderPalette(openPalette);
  positionPalette(el, x, y);
}

// positionPalette — держим палитру в пределах окна (у нижнего/правого края
// разворачиваем вверх/влево), как это уже делает контекстное меню токена.
function positionPalette(el, x, y) {
  const w = el.offsetWidth || 296;
  const h = el.offsetHeight || 320;
  const left = Math.max(8, Math.min(x, window.innerWidth - w - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - h - 8));
  el.style.left = left + "px";
  el.style.top = top + "px";
}

function renderPalette(state) {
  const { el, send, target } = state;
  const applied = state.statusesFor() || [];
  const appliedBySlug = new Map(applied.map((st) => [st.slug, st]));
  el.innerHTML = "";

  // ---- шапка: поиск + закрыть ----
  const head = document.createElement("div");
  head.className = "status-palette-head";
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = state.title ? `Состояния — ${state.title}` : "Состояние…";
  search.value = state.filter;
  search.oninput = () => {
    state.filter = search.value;
    renderPalette(state);
    // фокус теряется при перерисовке — возвращаем и ставим курсор в конец
    const next = el.querySelector(".status-palette-head input");
    if (next) {
      next.focus();
      next.setSelectionRange(next.value.length, next.value.length);
    }
  };
  const close = document.createElement("button");
  close.type = "button";
  close.className = "status-palette-close";
  close.innerHTML = icon("close", { size: 14 });
  close.title = "Закрыть";
  close.onclick = closeStatusPalette;
  head.append(search, close);
  el.appendChild(head);

  // ---- сетка ----
  const filter = state.filter.trim().toLowerCase();
  const list = (conditionsCache || []).filter(
    (c) => !filter || [c.name, c.slug, ...(c.tags || [])].join(" ").toLowerCase().includes(filter)
  );
  if (list.length === 0) {
    const empty = document.createElement("p");
    empty.className = "status-palette-empty";
    empty.textContent = conditionsCache && conditionsCache.length
      ? "Ничего не найдено."
      : "В этом мире ещё нет состояний — заведи их в конструкторе (Компендиум → Состояния).";
    el.appendChild(empty);
  } else {
    const grid = document.createElement("div");
    grid.className = "status-palette-grid";
    for (const cond of list) {
      const slug = cond.slug || "";
      const st = appliedBySlug.get(slug);
      const cell = document.createElement("div");
      cell.className = "status-cell" + (st ? " active" : "");
      if (cond.color) cell.style.setProperty("--cell-color", cond.color);
      cell.appendChild(statusVisual(cond, cond.name));
      cell.title = `${cond.name}${slug ? ` (${slug})` : ""}\nЛКМ — повесить/снять, ПКМ — подробности`;
      if (st && st.level) {
        const lvl = document.createElement("span");
        lvl.className = "status-cell-level";
        lvl.textContent = st.level;
        cell.appendChild(lvl);
      }
      if (st && st.rounds) {
        const r = document.createElement("span");
        r.className = "status-cell-rounds";
        r.textContent = st.rounds;
        cell.appendChild(r);
      }
      // Карточка без slug'а вешать нечего — метка ссылается именно на него
      // (см. domain.AppliedStatus). Не прячем такую карточку, а показываем
      // погашенной с подсказкой: иначе ДМ не поймёт, почему заведённое им
      // состояние «пропало» из палитры.
      if (!slug) {
        cell.style.cursor = "not-allowed";
        cell.title = `${cond.name}\nУ карточки не заполнен slug — заполни его в конструкторе, иначе состояние не на что повесить.`;
      } else {
        cell.onclick = () => {
          if (st) send({ type: "remove_status", ...targetFields(target), statusSlug: slug });
          else send({ type: "apply_status", ...targetFields(target), statusSlug: slug });
          state.detailSlug = "";
        };
        cell.oncontextmenu = (e) => {
          e.preventDefault();
          state.detailSlug = state.detailSlug === slug ? "" : slug;
          renderPalette(state);
        };
      }
      grid.appendChild(cell);
    }
    el.appendChild(grid);
  }

  // ---- подробности выбранной карточки (ПКМ) ----
  if (state.detailSlug) {
    const cond = (conditionsCache || []).find((c) => c.slug === state.detailSlug);
    if (cond) el.appendChild(detailBlock(cond, appliedBySlug.get(cond.slug), state));
  }

  // ---- подвал ----
  const foot = document.createElement("div");
  foot.className = "status-palette-foot";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.textContent = "Снять все";
  clear.disabled = applied.length === 0;
  clear.onclick = () => send({ type: "clear_statuses", ...targetFields(target) });
  foot.appendChild(clear);
  el.appendChild(foot);
}

// detailBlock — раскрытая по ПКМ карточка: описание, механика и точная
// настройка уже висящей метки (уровень/раунды/скрытность). Пока метка не
// наложена, доступна только справка — иначе пришлось бы городить «наложить с
// параметрами», а ДМ всё равно сначала кликает, потом уточняет.
function detailBlock(cond, applied, state) {
  const { send, target } = state;
  const box = document.createElement("div");
  box.className = "status-palette-detail";

  const h = document.createElement("h4");
  h.textContent = cond.name;
  box.appendChild(h);

  // Сначала то, что приложение реально применяет (см. domain.Modifier), —
  // ДМ должен видеть, что метка не просто значок; потом текстовая механика
  // (преимущество/помеха и прочее неарифметическое).
  for (const m of cond.modifiers || []) {
    const line = document.createElement("p");
    line.textContent = "▸ " + describeModifier(m);
    line.style.color = "var(--text)";
    box.appendChild(line);
  }
  if (cond.mechanics) {
    const p = document.createElement("p");
    p.textContent = cond.mechanics;
    box.appendChild(p);
  }

  if (!applied) {
    const hint = document.createElement("p");
    hint.textContent = "Не наложено. ЛКМ по иконке — повесить.";
    box.appendChild(hint);
    return box;
  }

  if (cond.levels > 1) {
    const row = document.createElement("div");
    row.className = "status-palette-row";
    const label = document.createElement("span");
    label.textContent = `Уровень (0–${cond.levels}):`;
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.max = String(cond.levels);
    input.value = String(applied.level || 0);
    input.title = "0 — снять состояние целиком";
    input.onchange = () => {
      const v = parseInt(input.value, 10);
      if (Number.isNaN(v)) return;
      send({ type: "set_status_level", ...targetFields(target), statusSlug: cond.slug, level: v });
    };
    row.append(label, input);
    box.appendChild(row);
  }

  const roundsRow = document.createElement("div");
  roundsRow.className = "status-palette-row";
  const roundsLabel = document.createElement("span");
  roundsLabel.textContent = "Раундов:";
  const rounds = document.createElement("input");
  rounds.type = "number";
  rounds.min = "0";
  rounds.value = String(applied.rounds || 0);
  rounds.title = "0 — бессрочно. Счётчик уменьшается в начале хода этого бойца.";
  rounds.onchange = () => {
    const v = parseInt(rounds.value, 10);
    if (Number.isNaN(v)) return;
    send({ type: "set_status_rounds", ...targetFields(target), statusSlug: cond.slug, rounds: v });
  };
  roundsRow.append(roundsLabel, rounds);
  box.appendChild(roundsRow);

  const hiddenRow = document.createElement("label");
  hiddenRow.className = "status-palette-row";
  const hidden = document.createElement("input");
  hidden.type = "checkbox";
  hidden.checked = !!applied.hidden;
  // Перевесить метку с теми же параметрами, но с другим флагом — отдельной
  // команды «сменить скрытность» нет: apply_status по существующему slug'у
  // не плодит вторую метку, а правит эту (см. room_statuses.go: putStatus).
  hidden.onchange = () =>
    send({
      type: "apply_status",
      ...targetFields(target),
      statusSlug: cond.slug,
      rounds: applied.rounds || 0,
      level: applied.level || 0,
      hidden: hidden.checked,
      source: applied.source || "",
    });
  const hiddenLabel = document.createElement("span");
  hiddenLabel.textContent = "видно только ДМ";
  hiddenRow.append(hidden, hiddenLabel);
  box.appendChild(hiddenRow);

  if (applied.source) {
    const src = document.createElement("p");
    src.textContent = "Источник: " + applied.source;
    box.appendChild(src);
  }
  return box;
}

// applySpellStatus — «накладывает» из карточки заклинания: тот же
// apply_status, но целей может быть несколько (все выделенные токены) и
// подпись источника подставляется автоматически (см. domain.SpellStatusRef).
export function applySpellStatus({ send, tokenIds, ref, spellName }) {
  for (const tokenId of tokenIds || []) {
    send({
      type: "apply_status",
      tokenId,
      statusSlug: ref.slug,
      rounds: ref.rounds || 0,
      source: spellName ? `Заклинание «${spellName}»` : "",
    });
  }
}

// Клик мимо палитры и Esc закрывают её — тот же контракт, что у
// контекстного меню токена (dm.js). Слушатели вешаются один раз на модуль,
// а не на каждое открытие: палитра в документе всегда максимум одна.
document.addEventListener(
  "pointerdown",
  (e) => {
    if (openPalette && !openPalette.el.contains(e.target)) closeStatusPalette();
  },
  true
);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeStatusPalette();
});
