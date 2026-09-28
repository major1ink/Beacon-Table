// schema-list.js — карточка в списках по разделу list схемы (задача «Схемы
// листа и карточек», блок 5): подпись по шаблону list.subtitle, группы
// list.group, сортировка list.sort, фильтры list.filters, поиск
// list.search. Без DOM: подпись читают шапка карточки (schema-card.js) и
// каталог (pages/catalog.js), настройки каталога — pages/catalog.js.
//
// Подпись — зеркало internal/schema/subtitle.go: сервер ставит её в призыв и
// в список готовых персонажей (общие случаи — internal/schema/testdata/
// eval-cases.json, раздел subtitles).
import { createEvaluator } from "./schema-formula.js";
import { formatNumber, formatSubtitle, getPath } from "./schema-layout.js";

// Общие ключи карточки, на которые может ссылаться list: не поля схемы, а
// поля страницы карточки.
const CARD_KEYS = new Set(["name", "tags", "source"]);

const evaluatorFor = (compiled, data) => createEvaluator(compiled, data, []);

const scalarText = (v) => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "");

// displayValue — поле id карточки data текстом ("" — пусто или ошибка).
export function displayValue(compiled, data, id, ev = evaluatorFor(compiled, data)) {
  const field = compiled && compiled.schema.fields[id];
  if (!field) {
    const v = getPath(data, id);
    return Array.isArray(v) ? v.map(scalarText).join(", ") : scalarText(v);
  }
  const raw = getPath(data, field.path);
  switch (field.type) {
    case "number":
    case "computed": {
      if (field.type === "number" && (raw === undefined || raw === null || raw === "")) return "";
      const r = ev.value(id);
      return r.error ? "" : formatNumber(r.value);
    }
    case "select": {
      const opt = (field.options || []).find((o) => o.value === scalarText(raw));
      return opt ? opt.label : scalarText(raw);
    }
    case "bool":
      return raw === true ? field.label : "";
    case "roll": {
      const r = ev.rollField(id);
      return r.error ? "" : r.formula;
    }
    default:
      return scalarText(raw);
  }
}

// cardSubtitle — подпись карточки (или листа) по шаблону list.subtitle.
export function cardSubtitle(compiled, data) {
  const template = compiled && compiled.schema.list && compiled.schema.list.subtitle;
  if (!template) return "";
  const ev = evaluatorFor(compiled, data);
  return formatSubtitle(template, (id) => displayValue(compiled, data, id, ev));
}

// sortValue — значение для сортировки и групп: число, строка или null
// (пусто — в конец). У выбора — номер варианта (порядок схемы).
function sortValue(compiled, data, id) {
  const field = compiled.schema.fields[id];
  if (!field) {
    const v = getPath(data, id);
    const s = (Array.isArray(v) ? v.map(scalarText).join(", ") : scalarText(v)).trim();
    return s ? s.toLowerCase() : null;
  }
  const raw = getPath(data, field.path);
  switch (field.type) {
    case "number":
    case "computed": {
      if (field.type === "number" && (raw === undefined || raw === null || raw === "")) return null;
      const r = evaluatorFor(compiled, data).value(id);
      return r.error ? null : r.value;
    }
    case "select": {
      const i = (field.options || []).findIndex((o) => o.value === scalarText(raw));
      return i >= 0 ? i : null;
    }
    case "bool":
      return raw === true ? 1 : 0;
    default: {
      const s = scalarText(raw).trim();
      return s ? s.toLowerCase() : null;
    }
  }
}

// compareValues — пустое в конец, числа — как числа, текст — по алфавиту.
function compareValues(a, b) {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "ru");
}

const byName = (a, b) => String(a.name || "").localeCompare(String(b.name || ""), "ru");

// catalogConfig — настройки каталога (см. pages/catalog.js: CONFIGS) из
// схемы вида карточек: подпись, поиск, фильтры, группы, сортировка.
// Плашки — только источник: ПО, круг, редкость — поля D&D.
export function catalogConfig(compiled) {
  const schema = compiled.schema;
  const list = schema.list || {};
  const fields = schema.fields;
  const out = {
    subText: (x) => cardSubtitle(compiled, x),
    badge: (x) => String(x.source || "").trim(),
    badgeTitle: null,
    badgeColor: null,
    flags: null,
    extraFilter: null,
    searchHay: (x) => {
      const hay = [x.name, ...(x.tags || [])];
      for (const id of list.search || []) if (!CARD_KEYS.has(id) || id === "source") hay.push(displayValue(compiled, x, id));
      return hay;
    },
    rowSort: (a, b) => {
      for (const id of list.sort || []) {
        const c = id === "name" ? byName(a, b) : compareValues(sortValue(compiled, a, id), sortValue(compiled, b, id));
        if (c) return c;
      }
      return byName(a, b);
    },
    sidebar: (list.filters || []).map((id) => filterSection(compiled, id)).filter(Boolean),
    groupKey: null,
    groupLabel: null,
    groupSort: null,
  };
  const group = list.group && fields[list.group];
  if (group) {
    const id = list.group;
    out.groupKey = (x) => {
      const v = sortValue(compiled, x, id);
      return v === null ? "" : v;
    };
    out.groupLabel = (k) => groupLabel(group, k);
    out.groupSort = (a, b) => compareValues(a === "" ? null : a, b === "" ? null : b);
  }
  return out;
}

// groupLabel — заголовок группы: у выбора — подпись варианта, у числа —
// «Круг 2», у флажка — подпись поля или «без …», у текста — сам текст.
function groupLabel(field, k) {
  if (k === "") return "Без значения: " + field.label.toLowerCase();
  switch (field.type) {
    case "select":
      return (field.options[k] && field.options[k].label) || String(k);
    case "number":
    case "computed":
      return `${field.label} ${formatNumber(k)}`;
    case "bool":
      return k ? field.label : "Без: " + field.label.toLowerCase();
    default:
      return String(k).charAt(0).toUpperCase() + String(k).slice(1);
  }
}

// filterSection — фильтр каталога по полю: выбор — кнопки вариантов по
// порядку схемы, флажок — переключатель, число и текст — значения, которые
// есть в списке; tags и source — метки и источники.
function filterSection(compiled, id) {
  const field = compiled.schema.fields[id];
  if (!field) {
    if (id === "tags") return { id, title: "Метки", kind: "list", of: (x) => x.tags || [] };
    if (id === "source") return { id, title: "Источник", kind: "list", of: (x) => (String(x.source || "").trim() ? [String(x.source).trim()] : []) };
    return null;
  }
  switch (field.type) {
    case "select":
      return {
        id,
        title: field.label,
        kind: "chips",
        values: (field.options || []).map((o) => o.value),
        label: (v) => ((field.options || []).find((o) => o.value === v) || {}).label || v,
        of: (x) => [scalarText(getPath(x, field.path))],
      };
    case "bool":
      return { id, title: field.label, kind: "toggles", items: [{ key: id, label: field.label, icon: "check", test: (x) => getPath(x, field.path) === true }] };
    case "number":
    case "computed":
      return {
        id,
        title: field.label,
        kind: "list",
        of: (x) => {
          const v = displayValue(compiled, x, id);
          return v ? [v] : [];
        },
        sort: (a, b) => Number(a) - Number(b),
      };
    default:
      return {
        id,
        title: field.label,
        kind: "list",
        of: (x) => {
          const v = displayValue(compiled, x, id).trim();
          return v ? [v] : [];
        },
      };
  }
}
