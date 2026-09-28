// schema-layout.js — раскладка схемы (раздел layout, см. internal/schema:
// Section) и запись значений по пути, без DOM: их читает рисовальщик
// schema-sheet.js, а проверяют тесты.
import { lookupPath } from "./schema-formula.js";

export const COLUMNS = 3;

// Вкладки листа в правке: "sheet" — «Лист» (по умолчанию), "inventory" —
// инвентарь страницы; любая другая — своя вкладка схемы.
export const TAB_SHEET = "sheet";
export const TAB_INVENTORY = "inventory";

// visibleIn — секция видна в режиме mode ("view" или "edit").
export const visibleIn = (sec, mode) => !sec.mode || sec.mode === mode;

const columnOf = (sec) => Math.min(COLUMNS, Math.max(1, sec.column || 1)) - 1;

function splitColumns(sections) {
  const cols = Array.from({ length: COLUMNS }, () => []);
  for (const sec of sections) cols[columnOf(sec)].push(sec);
  return cols;
}

// viewColumns — секции режима чтения по колонкам (без колонки — первая).
export function viewColumns(schema) {
  return splitColumns(((schema && schema.layout) || []).filter((s) => visibleIn(s, "view")));
}

// editTabs — вкладки режима правки в порядке первого появления:
// [{ id, title, columns }]. title — tabTitle первой секции вкладки, где он
// задан ("" — у вкладки подпись страницы или id).
export function editTabs(schema) {
  const tabs = new Map();
  for (const sec of (schema && schema.layout) || []) {
    if (!visibleIn(sec, "edit")) continue;
    const id = sec.tab || TAB_SHEET;
    if (!tabs.has(id)) tabs.set(id, { id, title: "", sections: [] });
    const tab = tabs.get(id);
    if (!tab.title && sec.tabTitle) tab.title = sec.tabTitle;
    tab.sections.push(sec);
  }
  return [...tabs.values()].map((t) => ({ id: t.id, title: t.title, columns: splitColumns(t.sections) }));
}

export { lookupPath as getPath };

const isIndex = (part) => /^\d+$/.test(part);

// setPath — записать value по пути «a.b.0», создавая недостающие объекты и
// списки (следующая часть — число → список).
export function setPath(obj, path, value) {
  const parts = String(path).split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const next = cur[part];
    if (next === null || typeof next !== "object") cur[part] = isIndex(parts[i + 1]) ? [] : {};
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
}

// deletePath — убрать ключ по пути (необязательное поле очищено).
export function deletePath(obj, path) {
  const parts = String(path).split(".");
  const last = parts.pop();
  const parent = parts.length ? lookupPath(obj, parts.join(".")) : obj;
  if (parent && typeof parent === "object" && !Array.isArray(parent)) delete parent[last];
}

// formatNumber — число для плитки: целое как есть, дробь — до сотых.
export function formatNumber(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}

export const formatSigned = (v) => (v >= 0 ? "+" : "") + formatNumber(v);
