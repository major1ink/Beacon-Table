// modifier-editor.js — таблица «Изменения» в конструкторе состояния
// (pages/conditions.js) и в карточке предмета (pages/itembook.js). Один
// модуль на оба, потому что список модификаторов у них буквально один и тот
// же тип (см. internal/domain/modifier.go) — тот же приём, что и у
// combat-panel.js, общего для встроенной панели и вынесенного окна.
//
// Справочник целей (что вообще можно менять и как это называется по-русски)
// НЕ зашит здесь, а приходит с сервера — GET /api/modifier-targets отдаёт
// domain.ModifierTargetLabels. Иначе закрытый список жил бы в двух местах и
// разъезжался при добавлении новой цели.
import { icon } from "./icons.js";
import { fetchModifierTargets } from "./api.js";
import { MODE_ADD, MODE_SET, MODE_MIN, MODE_MAX, PERIOD_NONE, PERIOD_TURN_START, PERIOD_TURN_END, formatModifier } from "./modifiers.js";

const MODE_OPTIONS = [
  { value: MODE_ADD, label: "прибавить" },
  { value: MODE_SET, label: "заменить на" },
  { value: MODE_MIN, label: "не ниже" },
  { value: MODE_MAX, label: "не выше" },
];

const PERIOD_OPTIONS = [
  { value: PERIOD_NONE, label: "постоянно" },
  { value: PERIOD_TURN_START, label: "в начале хода" },
  { value: PERIOD_TURN_END, label: "в конце хода" },
];

// Справочник целей кэшируется на страницу: карточек за сессию открывают
// много, а список меняется только с версией приложения.
let targetsCache = null;
export async function loadModifierTargets() {
  if (targetsCache) return targetsCache;
  try {
    targetsCache = await fetchModifierTargets();
  } catch {
    targetsCache = [];
  }
  return targetsCache;
}

export function modifierTargets() {
  return targetsCache || [];
}

export function targetLabel(target) {
  const t = modifierTargets().find((x) => x.target === target);
  return t ? t.label : target;
}

export function describeModifier(m) {
  return formatModifier(m, targetLabel(m.target));
}

function el(tag, attrs, children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(children || [])) {
    if (c === undefined || c === null || c === false) continue;
    e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
}

function select(options, value, onChange) {
  const s = el(
    "select",
    {},
    options.map((o) => el("option", { value: o.value, text: o.label }))
  );
  s.value = value ?? "";
  s.addEventListener("change", () => onChange(s.value));
  return s;
}

// renderModifierEditor — редактируемая таблица. list — сам массив из
// карточки (правится на месте), onChange — обычно scheduleSave владельца.
//
// hint — короткое пояснение под таблицей: у состояния и у предмета оно
// разное («пока висит метка» против «пока предмет надет»), а всё остальное
// одинаковое.
export function renderModifierEditor(list, onChange, { hint } = {}) {
  const wrap = el("div", { class: "mod-editor" });
  const rows = el("div", { class: "mod-rows" });

  function render() {
    rows.innerHTML = "";
    if (list.length === 0) {
      rows.appendChild(el("p", { class: "mod-empty", text: "Пока ничего не меняет." }));
    }
    list.forEach((m, i) => {
      const targets = modifierTargets();
      const periodic = (targets.find((t) => t.target === m.target) || {}).periodic;

      const targetSel = select(
        targets.map((t) => ({ value: t.target, label: t.label })),
        m.target,
        (v) => {
          m.target = v;
          // Период осмыслен не у всех целей (см. domain.TargetSupportsPeriod)
          // — сервер всё равно обнулит его, сделаем это сразу, чтобы в UI не
          // осталось выбранного, но не работающего значения.
          const t = modifierTargets().find((x) => x.target === v);
          if (!t || !t.periodic) m.period = PERIOD_NONE;
          onChange();
          render();
        }
      );

      const modeSel = select(MODE_OPTIONS, m.mode || MODE_ADD, (v) => {
        m.mode = v;
        onChange();
      });

      const valueInp = el("input", {
        type: "text",
        value: m.value ?? "",
        placeholder: periodic ? "-1к6" : "2",
        title: periodic
          ? "Число или формула кубов. Знак задаёт смысл: «-1к6» — урон, «5» — лечение."
          : "Целое число, можно со знаком: «2», «-2».",
      });
      valueInp.addEventListener("input", () => {
        m.value = valueInp.value;
        onChange();
      });

      const periodSel = select(PERIOD_OPTIONS, m.period || PERIOD_NONE, (v) => {
        m.period = v;
        onChange();
        render();
      });
      periodSel.disabled = !periodic;
      periodSel.title = periodic
        ? "Постоянно — пока действует. В начале/конце хода — разово, с броском в общий лог."
        : "Период есть только у текущих хитов — остальное действует постоянно.";

      const noteInp = el("input", { type: "text", value: m.note ?? "", placeholder: "подпись (огонь, от щита)" });
      noteInp.addEventListener("input", () => {
        m.note = noteInp.value;
        onChange();
      });

      const del = el("button", {
        type: "button",
        class: "mod-del",
        html: icon("close", { size: 12 }),
        title: "Убрать изменение",
        onclick: () => {
          list.splice(i, 1);
          onChange();
          render();
        },
      });

      rows.appendChild(el("div", { class: "mod-row" }, [targetSel, modeSel, valueInp, periodSel, noteInp, del]));
    });
  }

  const addBtn = el("button", {
    type: "button",
    class: "mod-add",
    text: "+ изменение",
    onclick: () => {
      const first = modifierTargets()[0];
      list.push({ target: first ? first.target : "ac", mode: MODE_ADD, value: "", period: PERIOD_NONE, note: "" });
      onChange();
      render();
    },
  });

  render();
  wrap.append(rows, addBtn);
  if (hint) wrap.appendChild(el("p", { class: "mod-hint", text: hint }));
  return wrap;
}

// MODIFIER_EDITOR_CSS — стили таблицы. Инжектятся из JS по той же причине,
// что и у палитры состояний (см. status-palette.js): один и тот же блок
// нужен на двух страницах, копировать его в оба html — ровно та беда, ради
// которой модуль и общий.
const CSS = `
.mod-editor { display: flex; flex-direction: column; gap: 6px; }
.mod-rows { display: flex; flex-direction: column; gap: 4px; }
.mod-row { display: grid; grid-template-columns: 1.3fr 1fr 70px 1.1fr 1.2fr 24px; gap: 4px; align-items: center; }
.mod-row select, .mod-row input { font-size: 11.5px; padding: 3px 5px; }
.mod-row select:disabled { opacity: 0.45; }
.mod-del { width: 24px; height: 24px; padding: 0; display: flex; align-items: center; justify-content: center; }
.mod-del:hover { background: var(--danger); }
.mod-add { align-self: flex-start; padding: 3px 10px; font-size: 11px; }
.mod-empty, .mod-hint { font-size: 11px; opacity: 0.65; margin: 0; line-height: 1.5; }
@media (max-width: 620px) { .mod-row { grid-template-columns: 1fr 1fr; } }
`;

let cssInjected = false;
export function ensureModifierEditorCSS() {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
}
