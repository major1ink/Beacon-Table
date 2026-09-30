// schema-card.js — середина карточки библиотеки (существо, заклинание,
// предмет, справочник) по схеме системы (задача «Схемы листа и карточек»,
// блок 4). Шапку (имя, арт, плашки), «Описание», «Совместимость и
// источник», сохранение и броски держит страница карточки; здесь — только
// то, что задаёт схема: простые поля — строками «показатель · значение»,
// длинные тексты — сворачиваемыми блоками, таблицы, формулы, виджеты
// страницы (добыча, заклинания, «Накладывает», «Пока надет»).
//
// Карточка без схемы (D&D) рисуется старым кодом страницы.
import { el as h, fold, pill } from "./card-shell.js";
import { glyphNode } from "./condition-glyphs.js";
import { enhanceRolls } from "./inline-rolls.js";
import { wireCatalogLinks } from "./catalog-links.js";
import { renderNoteHtml } from "./notes/markdown.js";
import { showAlert } from "./modal.js";
import { SCALARS, cellTiles, computedOutput, editInput, editTable, evaluatorOf, viewTable } from "./schema-fields.js";
import { displayValue, medallionOf, pillsOf } from "./schema-list.js";
import { formatNumber, getPath, sectionFields, setPath, visibleIn } from "./schema-layout.js";

// renderSchemaCard — узлы основной колонки карточки. ctx:
//   compiled — schema-formula.js: compileSchema(схема вида карточки);
//   data — карточка; readOnly — режим чтения;
//   scheduleSave() — сохранить; onChange() — после правки (подзаголовок);
//   sendRoll(формула, подпись) — бросок в чат (null — у страницы бросков нет);
//   widgets — { inventory, spells, applies, modifiers }: (секция) → узел.
export function renderSchemaCard(ctx) {
  const refreshers = [];
  const refresh = () => refreshers.forEach((fn) => fn());
  const f = {
    h,
    compiled: ctx.compiled,
    data: ctx.data,
    readOnly: ctx.readOnly,
    activeModifiers: () => [],
    onRefresh: (fn) => refreshers.push(fn),
    refresh,
    scheduleSave: () => {
      ctx.scheduleSave();
      if (ctx.onChange) ctx.onChange();
    },
    sendResolvedRoll: (r, label) => sendResolvedRoll(ctx, r, label),
    sendRoll: ctx.sendRoll,
    vCard: (title, children) => {
      const kids = [].concat(children).filter(Boolean);
      return kids.length ? fold({ title, body: kids, open: true }) : null;
    },
  };
  const mode = ctx.readOnly ? "view" : "edit";
  const out = [];
  for (const sec of ctx.compiled.schema.layout || []) {
    if (!visibleIn(sec, mode)) continue;
    if (sec.widget) {
      const w = ctx.widgets && ctx.widgets[sec.widget];
      out.push(w ? w(sec) : null);
      continue;
    }
    out.push(...section(f, sec));
  }
  return out.filter(Boolean);
}

// cardHead — глиф, цвет медальона и плашки шапки карточки по list.medallion
// и list.pills схемы; плашки источника и тегов — страницы.
export function cardHead(compiled, data, fallbackGlyph) {
  const m = medallionOf(compiled, data);
  return {
    glyph: glyphNode((m && m.glyph) || fallbackGlyph, ""),
    color: (m && m.color) || "",
    pills: [...pillsOf(compiled, data).map((p) => pill(p.text, p.kind)), data.source ? pill(data.source, "gold") : null, ...(data.tags || []).map((t) => pill(t))],
  };
}

// cardSubtitle — подзаголовок карточки по шаблону list.subtitle (см.
// schema-list.js; страницы берут его отсюда вместе с renderSchemaCard).
export { cardSubtitle } from "./schema-list.js";

function sendResolvedRoll(ctx, r, label) {
  if (!ctx.sendRoll) return;
  if (r.error) {
    showAlert(`«${label}»: ${r.error.message}`);
    return;
  }
  if (r.dice === 0) {
    showAlert(`«${label}»: кубов в формуле нет, значение — ${r.const}`);
    return;
  }
  ctx.sendRoll(r.formula, label);
}

// section — секция схемы: простые поля одной таблицей «показатель ·
// значение» под заголовком секции, тексты и таблицы — отдельными блоками.
function section(f, sec) {
  const fields = f.compiled.schema.fields;
  if (sec.cells && f.readOnly) return [h("div", {}, [sec.title ? h("div", { class: "card-worn-h" }, [h("span", { class: "card-lbl", text: sec.title })]) : null, cellTiles(f, sec, "card")])];
  const list = sectionFields(sec).map((id) => [id, fields[id]]).filter(([, field]) => field);
  const scalars = list.filter(([, field]) => SCALARS.has(field.type));
  const out = [];
  const rows = scalars.map(([id, field]) => (f.readOnly ? readRow(f, id, field) : editRow(f, id, field))).filter(Boolean);
  if (rows.length) {
    out.push(
      h("div", {}, [
        sec.title ? h("div", { class: "card-worn-h" }, [h("span", { class: "card-lbl", text: sec.title })]) : null,
        h("div", { class: "kvt" + (f.readOnly ? " readonly" : "") }, [h("table", {}, [h("tbody", {}, rows)])]),
      ])
    );
  }
  for (const [id, field] of list) {
    if (field.type === "longtext") out.push(textBlock(f, field, list.length === 1 && sec.title ? sec.title : field.label));
    else if (field.type === "table") out.push(f.readOnly ? viewTable(f, id, field, list.length === 1 ? sec.title : "") : fold({ title: list.length === 1 && sec.title ? sec.title : field.label, body: [editTable(f, id, field, false)], open: true }));
  }
  return out;
}

const kvRow = (label, cell) => h("tr", {}, [h("th", { scope: "row", text: label }), h("td", {}, [cell])]);

// liveCell — значение, которое пересчитывается вместе с карточкой;
// read() → { text, error }. onclick — строка-бросок.
function liveCell(f, read, onclick, mono) {
  const node = h(onclick ? "button" : "span", { type: onclick ? "button" : undefined, class: (onclick ? "kvt-roll" : "kvt-val") + (mono ? " mono" : ""), onclick });
  const update = () => {
    const r = read();
    node.textContent = r.text;
    node.classList.toggle("formula-error", !!r.error);
    if (r.error) node.title = r.error.message;
    else if (onclick) node.title = "Бросить";
    else node.removeAttribute("title");
  };
  update();
  f.onRefresh(update);
  return node;
}

function readRow(f, id, field) {
  const raw = getPath(f.data, field.path);
  const empty = raw === undefined || raw === null || raw === "" || raw === false;
  const roll = (r) => f.sendResolvedRoll(r, field.label);
  switch (field.type) {
    case "number":
      if (empty) return null;
      return kvRow(field.label, liveCell(f, () => valueText(f, id), null, true));
    case "computed":
      return kvRow(field.label, liveCell(f, () => valueText(f, id), null, true));
    case "text": {
      if (empty) return null;
      const cell = h("span", { class: "kvt-val", text: String(raw) });
      if (f.sendRoll) enhanceRolls(cell, f.sendRoll);
      return kvRow(field.label, cell);
    }
    case "bool":
      return empty ? null : kvRow(field.label, h("span", { class: "kvt-val", text: "✓" }));
    case "template": {
      const text = displayValue(f.compiled, f.data, id);
      return text ? kvRow(field.label, h("span", { class: "kvt-val", text })) : null;
    }
    case "select": {
      if (empty) return null;
      const opt = (field.options || []).find((o) => o.value === String(raw));
      return kvRow(field.label, h("span", { class: "kvt-val", text: opt ? opt.label : String(raw), style: opt && opt.color ? `color:${opt.color}` : undefined }));
    }
    case "dice":
      if (empty) return null;
      return kvRow(field.label, liveCell(f, () => ({ text: String(raw) }), () => roll(evaluatorOf(f).rollField(id)), true));
    case "roll":
      return kvRow(
        field.label,
        liveCell(
          f,
          () => {
            const r = evaluatorOf(f).rollField(id);
            return r.error ? { text: "!", error: r.error } : { text: r.formula };
          },
          () => roll(evaluatorOf(f).rollField(id)),
          true
        )
      );
    case "resource": {
      const cur = getPath(f.data, field.path + ".current");
      const max = getPath(f.data, field.path + ".max");
      if (!cur && !max) return null;
      return kvRow(field.label, h("span", { class: "kvt-val mono", text: `${formatNumber(Number(cur) || 0)} / ${formatNumber(Number(max) || 0)}` }));
    }
    default:
      return null;
  }
}

function valueText(f, id) {
  const r = evaluatorOf(f).value(id);
  return r.error ? { text: "!", error: r.error } : { text: formatNumber(r.value) };
}

function editRow(f, id, field) {
  if (field.type === "roll") {
    // Бросок схемы не правится — видна его посчитанная формула.
    return kvRow(
      field.label,
      computedOutput(f, () => {
        const r = evaluatorOf(f).rollField(id);
        return r.error ? { error: r.error } : { value: r.formula };
      })
    );
  }
  if (field.type === "template") return null;
  const input = editInput(f, id, field, f.data);
  return input ? kvRow(field.label, input) : null;
}

// textBlock — длинный текст: в чтении — markdown с кликабельными формулами
// и ссылками на каталог (пустой не показывается), в правке — поле.
function textBlock(f, field, title) {
  const get = () => String(getPath(f.data, field.path) ?? "");
  if (f.readOnly) {
    if (!get().trim()) return null;
    const body = h("div", { class: "card-prose" });
    body.innerHTML = renderNoteHtml(get());
    if (f.sendRoll) enhanceRolls(body, f.sendRoll);
    wireCatalogLinks(body);
    return fold({ title, body: [body], open: true });
  }
  const t = h("textarea", { "aria-label": title, placeholder: field.placeholder, style: "min-height:110px;width:100%" });
  t.value = get();
  t.addEventListener("input", () => {
    setPath(f.data, field.path, t.value);
    f.scheduleSave();
  });
  return fold({ title, body: [t], open: true });
}

// cardBody — узлы основной колонки в оформлении страниц карточек: таблицы
// «показатель · значение» — как есть, подряд идущие сворачиваемые блоки
// (тексты, таблицы, виджеты страницы) — общей обёрткой .card-folds.
export function cardBody(nodes) {
  const out = [];
  let group = null;
  for (const node of nodes.filter(Boolean)) {
    if (node.classList && node.classList.contains("card-fold")) {
      if (!group) {
        group = h("div", { class: "card-folds" });
        out.push(group);
      }
      group.appendChild(node);
    } else {
      group = null;
      out.push(node);
    }
  }
  return out;
}
