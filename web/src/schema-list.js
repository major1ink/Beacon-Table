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
    case "template":
      return formatSubtitle(field.template, (ref) => displayValue(compiled, data, ref, ev));
    default:
      return scalarText(raw);
  }
}

// ruleMatches — правило по тексту (list.medallion, list.categories):
// подстрока или точное значение, без учёта регистра.
export function ruleMatches(rule, text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return false;
  return (rule.contains || []).some((s) => t.includes(String(s).toLowerCase())) || (rule.equals || []).some((s) => t === String(s).toLowerCase());
}

// medallionOf — глиф и цвет карточки по list.medallion: у выбора — из
// варианта, у текста — из первого подошедшего правила, иначе запасные.
// null — схема медальон не задаёт.
export function medallionOf(compiled, data) {
  const m = compiled && compiled.schema.list && compiled.schema.list.medallion;
  const field = m && compiled.schema.fields[m.field];
  if (!field) return null;
  const raw = scalarText(getPath(data, field.path)).trim();
  const found =
    field.type === "select"
      ? (field.options || []).find((o) => o.value === raw)
      : (m.rules || []).find((r) => ruleMatches(r, raw));
  let color = (found && found.color) || m.color || "";
  const colorField = m.colorField && compiled.schema.fields[m.colorField];
  if (colorField) {
    const opt = (colorField.options || []).find((o) => o.value === scalarText(getPath(data, colorField.path)));
    color = (opt && opt.color) || m.color || "";
  }
  return { glyph: (found && found.glyph) || m.glyph || "", color };
}

// pillsOf — плашки шапки карточки по list.pills: [{ text, kind }]; kind —
// "rar" у выбора, "att" у остальных (флажок, шаблон).
export function pillsOf(compiled, data) {
  const ev = evaluatorFor(compiled, data);
  const out = [];
  for (const id of (compiled.schema.list && compiled.schema.list.pills) || []) {
    const text = displayValue(compiled, data, id, ev).trim();
    if (text) out.push({ text, kind: compiled.schema.fields[id].type === "select" ? "rar" : "att" });
  }
  return out;
}

// categoriesOf — категории каталога по list.categories: [{ label, test(x) }]
// в порядке правил, последняя — «остальное» (other), если оно задано.
export function categoriesOf(compiled) {
  const c = compiled && compiled.schema.list && compiled.schema.list.categories;
  const field = c && compiled.schema.fields[c.field];
  if (!field) return [];
  const text = (x) => scalarText(getPath(x, field.path));
  const out = c.rules.map((rule, i) => ({
    label: rule.label,
    test: (x) => {
      if (!ruleMatches(rule, text(x))) return false;
      return !c.rules.slice(0, i).some((prev) => ruleMatches(prev, text(x)));
    },
  }));
  if (c.other) out.push({ label: c.other, test: (x) => !c.rules.some((rule) => ruleMatches(rule, text(x))) });
  return out;
}

// badgesOf — плашки строки каталога по list.badges: [{ text, color }]; цвет —
// у варианта выбора.
export function badgesOf(compiled, data) {
  const ev = evaluatorFor(compiled, data);
  const out = [];
  for (const id of (compiled.schema.list && compiled.schema.list.badges) || []) {
    const text = displayValue(compiled, data, id, ev).trim();
    if (!text) continue;
    const field = compiled.schema.fields[id];
    const opt = field && field.type === "select" ? (field.options || []).find((o) => o.value === scalarText(getPath(data, field.path))) : null;
    out.push({ text, color: (opt && opt.color) || "" });
  }
  return out;
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
export function catalogConfig(compiled) {
  const schema = compiled.schema;
  const list = schema.list || {};
  const fields = schema.fields;
  const out = {
    subText: (x) => cardSubtitle(compiled, x),
    badge: (list.badges || []).length
      ? (x) => [...badgesOf(compiled, x).map((b) => b.text), String(x.source || "").trim()].filter(Boolean)
      : (x) => String(x.source || "").trim(),
    badgeTitle: null,
    badgeColor: (x, text) => (badgesOf(compiled, x).find((b) => b.text === text) || {}).color || "",
    flags: (list.flags || []).length
      ? (x) => list.flags.filter((fl) => fields[fl.field] && getPath(x, fields[fl.field].path) === true).map((fl) => [fl.mark, fl.title || fields[fl.field].label])
      : null,
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
          let v = displayValue(compiled, x, id).trim();
          if (field.facet === "list") return v.split(/[,;/]/).map((c) => c.trim()).filter(Boolean);
          if (field.facet === "beforeParen") v = v.replace(/\s*\(.*$/, "").replace(/^./, (c) => c.toUpperCase());
          return v ? [v] : [];
        },
      };
  }
}
