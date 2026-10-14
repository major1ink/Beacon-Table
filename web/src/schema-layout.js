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

// sectionFields — id полей секции: fields или поля её плиток (cells).
export const sectionFields = (sec) => sec.fields || (sec.cells || []).flat();

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

// parsePool — «4» или «4/2» (всего/потрачено) как { total, used }; null — не разбирается.
export function parsePool(raw) {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  const both = /^(\d+)\s*\/\s*(\d+)$/.exec(t);
  if (both) {
    const total = parseInt(both[1], 10);
    return { total, used: Math.min(parseInt(both[2], 10), total) };
  }
  const one = /^(\d+)$/.exec(t);
  return one ? { total: parseInt(one[1], 10), used: 0 } : null;
}

export const formatPool = (total, used) => (used > 0 ? `${total}/${used}` : String(total));

// cellPath — путь ячейки таблицы со строками от листа или карточки.
export const cellPath = (table, column, row) => `${table.path}.${String(column.path).replaceAll("{key}", row.key)}`;

// formatNumber — число для плитки: целое как есть, дробь — до сотых
// (floor(x·100 + 0.5) — как на сервере, internal/schema: FormatNumber).
export function formatNumber(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  return Number.isInteger(v) ? String(v) : String(Math.floor(v * 100 + 0.5) / 100);
}

export const formatSigned = (v) => (v >= 0 ? "+" : "") + formatNumber(v);

// formatSubtitle — подпись карточки по шаблону схемы (list.subtitle, «Хиты
// {hp} · Защита {ac}»): value(id) — текст поля ("" — пусто). Части между
// «·», в которых все подстановки пустые, выпадают целиком — «Хиты  ·
// Защита 13» не остаётся висеть; то же для необязательных частей
// «[ ({note})]». Зеркало internal/schema/subtitle.go: FormatSubtitle.
export function formatSubtitle(template, value) {
  const fill = (s) => {
    let placeholders = 0;
    let filled = 0;
    const text = s.replace(/\{([^{}]*)\}/g, (_, id) => {
      placeholders++;
      const v = String(value(id) ?? "").trim();
      if (v) filled++;
      return v;
    });
    return { text, placeholders, filled };
  };
  return String(template || "")
    .split("·")
    .map((part) => {
      let placeholders = 0;
      let filled = 0;
      const text = part.replace(/\[([^[\]]*)\]|\{([^{}]*)\}/g, (m) => {
        const optional = m.startsWith("[");
        const r = fill(optional ? m.slice(1, -1) : m);
        if (optional && r.placeholders && !r.filled) return "";
        placeholders += r.placeholders;
        filled += r.filled;
        return r.text;
      });
      return placeholders && !filled ? "" : text.trim();
    })
    .filter(Boolean)
    .join(" · ");
}

// schemaHasPath — есть ли у схемы поле с таким путём в данных.
export function schemaHasPath(schema, path) {
  return !!schema && Object.values(schema.fields || {}).some((f) => f.path === path);
}

// schemaHasWidget — есть ли в раскладке схемы секция с виджетом.
export function schemaHasWidget(schema, widget) {
  return !!schema && (schema.layout || []).some((sec) => sec.widget === widget);
}
