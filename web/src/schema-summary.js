// schema-summary.js — существо или персонаж «в двух строках» по схеме
// (задача «Схемы листа и карточек», блок 6): общие поля ядра (хиты, защита,
// скорость, инициатива), короткие плитки характеристик и боевая часть
// карточки. Без DOM: читают попап «чем ходит монстр»
// (combat-actions-peek.js), карточки на досках (pages/board.js) и превью
// существа «На карте и в трекере» (monster-preview.js).
import { statTarget } from "./modifiers.js";
import { createEvaluator } from "./schema-formula.js";
import { displayValue } from "./schema-list.js";
import { formatNumber, formatSigned, getPath, sectionFields, visibleIn } from "./schema-layout.js";

// Общие поля ядра, которые уже показывает трекер боя у бойца: в попапе их
// не повторяем.
const TRACKER_CORE = ["hp.current", "hp.max", "ac", "initiative"];

const coreField = (compiled, target) => {
  const id = compiled && compiled.schema.core && compiled.schema.core[target];
  return id && compiled.schema.fields[id] ? id : "";
};

// coreSummary — общие поля ядра текстом ("" — нет в схеме или пусто):
// { hp, hpMax, ac, speed, initiative }. initiative — формула броска
// («1d20+2»). У существа хиты — только hp.max (текущие живут в трекере):
// hp тогда совпадает с hpMax.
export function coreSummary(compiled, data, mods) {
  const ev = createEvaluator(compiled, data, mods || []);
  const text = (target) => {
    const id = coreField(compiled, target);
    return id ? displayValue(compiled, data, id, ev) : "";
  };
  const hpMax = text("hp.max");
  const hp = coreField(compiled, "hp.current") ? text("hp.current") : hpMax;
  let initiative = "";
  const ini = coreField(compiled, "initiative");
  if (ini) {
    const f = compiled.schema.fields[ini];
    if (f.type === "dice" || f.type === "roll") {
      const r = ev.rollField(ini);
      initiative = r.error ? "" : r.formula;
    } else {
      const v = displayValue(compiled, data, ini, ev);
      initiative = v === "" ? "" : formatSigned(Number(v) || 0);
    }
  }
  return { hp, hpMax, ac: text("ac"), speed: text("speed"), initiative };
}

// layoutFields — id полей в порядке раскладки режима чтения, без повторов.
function layoutFields(schema) {
  const seen = new Set();
  const out = [];
  for (const sec of schema.layout || []) {
    if (!visibleIn(sec, "view")) continue;
    for (const id of sectionFields(sec)) {
      if (seen.has(id) || !schema.fields[id]) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

const COMPACT_TYPES = new Set(["number", "computed"]);

// tileMod — вычисляемое поле в паре с полем id в плитке секции (cells):
// «Лов 15» и его модификатор.
function tileMod(schema, id) {
  for (const sec of schema.layout || []) {
    for (const tile of sec.cells || []) {
      const i = tile.indexOf(id);
      const next = i >= 0 && schema.fields[tile[i + 1]];
      if (next && next.type === "computed") return tile[i + 1];
    }
  }
  return "";
}

// compactStats — короткие плитки: [{ label, value, note }]. Из строк таблиц
// свободных характеристик (statRows: название — значение с модификаторами,
// note — прочие числовые колонки, «+2») и из числовых полей с коротким
// названием short («Лов 16»). Порядок — раскладка схемы.
export function compactStats(compiled, data, mods) {
  if (!compiled) return [];
  const { schema } = compiled;
  const ev = createEvaluator(compiled, data, mods || []);
  const out = [];
  for (const id of layoutFields(schema)) {
    const f = schema.fields[id];
    if (f.type === "table" && f.statRows) {
      const cols = f.columns || [];
      const nameCol = cols.find((c) => c.id === f.statRows.name);
      const valueCol = cols.find((c) => c.id === f.statRows.value);
      if (!nameCol || !valueCol) continue;
      const extra = cols.filter((c) => c !== nameCol && c !== valueCol && c.type === "number");
      const rows = getPath(data, f.path);
      for (const row of Array.isArray(rows) ? rows : []) {
        const name = String(getPath(row, nameCol.path) || "").trim();
        if (!name) continue;
        const notes = extra.map((c) => getPath(row, c.path)).filter((v) => v !== undefined && v !== null && v !== "");
        out.push({ label: name, value: formatNumber(ev.stat(name)), note: notes.map((v) => formatSigned(Number(v) || 0)).join(", "), target: statTarget(name) });
      }
      continue;
    }
    if (!f.short || !COMPACT_TYPES.has(f.type)) continue;
    const value = displayValue(compiled, data, id, ev);
    if (value === "") continue;
    const mod = tileMod(schema, id);
    const note = mod ? displayValue(compiled, data, mod, ev) : "";
    out.push({ label: f.short, value, note: note && Number(note) >= 0 ? "+" + note : note, target: f.modifierTarget || "" });
  }
  return out;
}

// peekSections — боевая часть карточки для попапа «чем ходит монстр»:
// секции режима чтения без виджетов (добыча, заклинания — за ними в
// карточку) и без полей, которые уже показывает трекер (хиты, защита,
// инициатива) или плитки compactStats (характеристики, поля с short).
// [{ title, fields: [id] }], пустые секции выпадают.
export function peekSections(compiled) {
  if (!compiled) return [];
  const { schema } = compiled;
  const skip = new Set(TRACKER_CORE.map((t) => coreField(compiled, t)).filter(Boolean));
  const out = [];
  for (const sec of schema.layout || []) {
    if (!visibleIn(sec, "view") || sec.widget) continue;
    const fields = (sec.fields || []).filter((id) => {
      const f = schema.fields[id];
      if (!f || skip.has(id)) return false;
      if (f.type === "table" && f.statRows) return false;
      return !(f.short && COMPACT_TYPES.has(f.type));
    });
    if (fields.length) out.push({ title: sec.title || "", fields });
  }
  return out;
}
