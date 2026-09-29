// schema-sheet.js — лист персонажа по схеме системы (задача «Схемы листа и
// карточек», блок 3): раздел layout схемы раскладывает секции по колонкам
// (чтение) и вкладкам (правка), поля рисуются по типу, формулы считаются
// на лету (schema-formula.js), ошибка формулы подсвечивает поле, а не
// роняет лист.
//
// Страница листа одна (pages/character-sheet.js): портрет, хиты, инвентарь,
// деньги, ресурсы, живые состояния, сохранение и броски в чат — её, сюда
// они приходят через ctx (см. schemaCtx там). Здесь — только то, что задаёт
// схема. Лист без схемы (бланк D&D) рисуется старым кодом страницы.
import { SCALARS, editInput, editTable, rowsTable, viewTable, viewTile } from "./schema-fields.js";
import { TAB_INVENTORY, editTabs, getPath, setPath, viewColumns } from "./schema-layout.js";
import { renderSpellbook } from "./schema-spellbook.js";


// ==================== чтение ====================

// renderSchemaView — режим чтения: шапка и секции по трём колонкам.
export function renderSchemaView(ctx) {
  const { h } = ctx;
  const cols = viewColumns(ctx.compiled.schema).map((sections) =>
    h("div", { class: "v-stack" }, sections.flatMap((sec) => [].concat(viewSection(ctx, sec))).filter(Boolean))
  );
  return h("div", { class: "v-stack" }, [ctx.vHero(), h("div", { class: "v-cols" }, cols)]);
}

function viewSection(ctx, sec) {
  if (sec.widget) return viewWidget(ctx, sec);
  const fields = ctx.compiled.schema.fields;
  const list = (sec.fields || []).map((id) => [id, fields[id]]).filter(([, f]) => f);
  // Секция из одних текстов — сворачиваемые блоки текста, как в бланке.
  if (list.length && list.every(([, f]) => f.type === "longtext")) {
    return list.map(([, f]) => ctx.vText(list.length === 1 && sec.title ? sec.title : f.label, getPath(ctx.data, f.path), { open: sec.open !== false }));
  }
  // Секция из одной таблицы — сама таблица под заголовком секции, без
  // карточки в карточке.
  if (list.length === 1 && list[0][1].type === "table") return viewTable(ctx, list[0][0], list[0][1], sec.title);
  const tiles = list.filter(([, f]) => SCALARS.has(f.type)).map(([id, f]) => viewTile(ctx, id, f));
  const blocks = list
    .filter(([, f]) => !SCALARS.has(f.type))
    .map(([id, f]) => (f.type === "table" ? viewTable(ctx, id, f) : ctx.vText(f.label, getPath(ctx.data, f.path), { open: true })));
  return ctx.vCard(sec.title || "", [tiles.filter(Boolean).length ? ctx.h("div", { class: "v-tiles" }, tiles.filter(Boolean)) : null, ...blocks]);
}

function viewWidget(ctx, sec) {
  switch (sec.widget) {
    case "hp":
      return ctx.vHpCard();
    case "statuses":
      return ctx.vCard(sec.title || "Состояния", ctx.liveStatusesHost());
    case "resources":
      return ctx.vResourcesCard();
    case "inventory":
      return ctx.vInventoryCard();
    case "money":
      return ctx.vMoneyCard();
    case "spellbook":
      return renderSpellbook(ctx, sec);
    case "xp":
      return ctx.vXpCard(ctx.compiled.schema.fields[sec.bind.xp]);
    default:
      return null;
  }
}


// ==================== правка ====================

// renderSchemaEdit — вкладки правки по схеме: «Лист», свои вкладки схемы
// (ctx.tabPanel создаёт их), «Портрет» — страницы. Вкладка «Инвентарь» —
// инвентарь страницы, секции схемы на ней не рисуются.
export function renderSchemaEdit(ctx) {
  const { h } = ctx;
  const refreshers = [];
  const refresh = () => refreshers.forEach((fn) => fn());
  const e = { ...ctx, onRefresh: (fn) => refreshers.push(fn), refresh };
  for (const tab of editTabs(ctx.compiled.schema)) {
    if (tab.id === TAB_INVENTORY) continue;
    const panel = ctx.tabPanel(tab.id, tab.title);
    panel.innerHTML = "";
    panel.appendChild(
      h(
        "div",
        { class: "grid-cols" },
        tab.columns.filter((c) => c.length).map((sections) => h("div", { class: "col" }, sections.map((sec) => editSection(e, sec)).filter(Boolean)))
      )
    );
  }
  const portrait = ctx.tabPanel("portrait", "");
  portrait.innerHTML = "";
  portrait.appendChild(h("div", { class: "grid-cols" }, [h("div", { class: "col" }, [ctx.identitySection()])]));
}

function editSection(e, sec) {
  const { h } = e;
  if (sec.widget === "resources") return resourcesTable(e, sec.title || "Ресурсы");
  if (sec.widget === "spellbook") return spellbookEdit(e, sec);
  if (sec.widget) return null;
  const fields = e.compiled.schema.fields;
  const list = (sec.fields || []).map((id) => [id, fields[id]]).filter(([, f]) => f && f.type !== "roll");
  if (!list.length) return null;
  const inline = list.filter(([, f]) => f.type !== "table" && f.type !== "longtext");
  const blocks = list.filter(([, f]) => f.type === "table" || f.type === "longtext");
  return h("div", { class: "section" }, [
    sec.title ? h("h3", { text: sec.title }) : null,
    inline.length ? h("div", { class: "row" }, inline.map(([id, f]) => e.field(f.label, editInput(e, id, f, e.data)))) : null,
    ...blocks.map(([id, f]) =>
      f.type === "table"
        ? editTable(e, id, f, blocks.length > 1 || list.length > 1 || !sec.title)
        : h("div", {}, [blocks.length > 1 || sec.title !== f.label ? h("h3", { text: f.label }) : null, e.textareaInput(() => getPath(e.data, f.path), (v) => setPath(e.data, f.path, v), { rows: 8 })])
    ),
  ]);
}


// spellbookEdit — виджет заклинаний в правке: таблицы заклинаний и ячеек.
function spellbookEdit(e, sec) {
  const fields = e.compiled.schema.fields;
  const tables = [sec.bind.spells, sec.bind.slots].filter(Boolean);
  return e.h("div", { class: "section" }, [
    sec.title ? e.h("h3", { text: sec.title }) : null,
    ...tables.map((id) => editTable(e, id, fields[id], true)),
  ]);
}

// resourcesTable — ресурсы листа (sheet.resources: название, сейчас,
// максимум, восстановление) — общий виджет страницы, в правке — таблица.
function resourcesTable(e, title) {
  const sheet = e.data;
  const col = (id, type, label, extra) => Object.assign({ id, type, path: id, label }, extra || {});
  const cols = [col("name", "text", "Название"), col("current", "number", "Сейчас"), col("max", "number", "Максимум"), col("recovery", "text", "Восстановление", { placeholder: "после отдыха" })];
  return rowsTable(e, {
    title,
    list: () => sheet.resources,
    ensure: () => (sheet.resources = sheet.resources || []),
    headers: cols.map((c) => c.label),
    blank: () => ({ name: "", current: 0, max: 0, recovery: "" }),
    cells: (row) => cols.map((c) => editInput(e, c.id, c, row)),
  });
}
