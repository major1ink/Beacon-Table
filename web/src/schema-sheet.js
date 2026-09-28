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
import { icon } from "./icons.js";
import { explainModifiers, statTarget } from "./modifiers.js";
import { applyInput, createEvaluator } from "./schema-formula.js";
import { TAB_INVENTORY, deletePath, editTabs, formatNumber, formatSigned, getPath, setPath, viewColumns } from "./schema-layout.js";

const SCALARS = new Set(["number", "computed", "text", "bool", "select", "dice", "roll", "resource"]);

// evaluatorOf — свежий расчёт по текущему состоянию листа: значения и
// модификаторы меняются прямо во время просмотра (надел кольцо, повесили
// метку), поэтому не кэшируется.
const evaluatorOf = (ctx) => createEvaluator(ctx.compiled, ctx.sheet, ctx.activeModifiers());

// firstTextColumn — колонка-название строки таблицы (подпись броска).
const firstTextColumn = (f) => (f.columns || []).find((c) => c.type === "text");
const rollColumn = (f) => (f.columns || []).find((c) => c.type === "dice" || c.type === "roll");

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
    return list.map(([, f]) => ctx.vText(list.length === 1 && sec.title ? sec.title : f.label, getPath(ctx.sheet, f.path)));
  }
  // Секция из одной таблицы — сама таблица под заголовком секции, без
  // карточки в карточке.
  if (list.length === 1 && list[0][1].type === "table") return viewTable(ctx, list[0][0], list[0][1], sec.title);
  const tiles = list.filter(([, f]) => SCALARS.has(f.type)).map(([id, f]) => viewTile(ctx, id, f));
  const blocks = list
    .filter(([, f]) => !SCALARS.has(f.type))
    .map(([id, f]) => (f.type === "table" ? viewTable(ctx, id, f) : ctx.vText(f.label, getPath(ctx.sheet, f.path), { open: true })));
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
    default:
      return null;
  }
}

// liveTile — плитка, которая пересчитывается вместе с листом: read() →
// { text, error, hint }. Ошибка формулы красит плитку и уходит в подсказку.
function liveTile(ctx, label, read, onclick) {
  const { h } = ctx;
  const value = h("b", {});
  const node = h(onclick ? "button" : "div", { type: onclick ? "button" : undefined, class: "v-tile", onclick }, [value, h("span", { text: label })]);
  const update = () => {
    const r = read();
    value.textContent = r.text;
    node.classList.toggle("formula-error", !!r.error);
    const title = r.error ? r.error.message : r.hint || "";
    if (title) node.title = title;
    else node.removeAttribute("title");
  };
  update();
  ctx.onRefresh(update);
  return node;
}

function viewTile(ctx, id, f) {
  const raw = () => getPath(ctx.sheet, f.path);
  switch (f.type) {
    case "number":
    case "computed":
      return liveTile(ctx, f.label, () => {
        const r = evaluatorOf(ctx).value(id);
        if (r.error) return { text: "!", error: r.error };
        const hint = f.modifierTarget ? modifierHint(ctx, f.modifierTarget, f.type === "number" ? raw() : null) : "";
        return { text: formatNumber(r.value), hint };
      });
    case "text":
      return String(raw() ?? "").trim() ? liveTile(ctx, f.label, () => ({ text: String(raw() ?? "") })) : null;
    case "bool":
      return liveTile(ctx, f.label, () => ({ text: raw() ? "✓" : "—" }));
    case "select":
      return selectTile(ctx, f, raw());
    case "resource": {
      const cur = () => formatNumber(Number(getPath(ctx.sheet, f.path + ".current")) || 0);
      const max = () => formatNumber(Number(getPath(ctx.sheet, f.path + ".max")) || 0);
      return liveTile(ctx, f.label, () => ({ text: `${cur()} / ${max()}` }));
    }
    case "dice": {
      const text = String(raw() ?? "").trim();
      return liveTile(ctx, f.label, () => ({ text: text || "—" }), text ? () => ctx.sendResolvedRoll(evaluatorOf(ctx).rollField(id), f.label) : null);
    }
    case "roll":
      return liveTile(
        ctx,
        f.label,
        () => {
          const r = evaluatorOf(ctx).rollField(id);
          return r.error ? { text: "!", error: r.error } : { text: r.formula };
        },
        () => ctx.sendResolvedRoll(evaluatorOf(ctx).rollField(id), f.label)
      );
    default:
      return null;
  }
}

function modifierHint(ctx, target, base) {
  const parts = explainModifiers(target, ctx.activeModifiers());
  if (!parts.length) return "";
  return base === null || base === undefined ? parts.join("; ") : `база ${formatNumber(Number(base) || 0)}; ${parts.join("; ")}`;
}

function selectTile(ctx, f, value) {
  if (value === undefined || value === null || value === "") return null;
  const opt = (f.options || []).find((o) => o.value === String(value));
  const { h } = ctx;
  const text = opt ? opt.label : String(value);
  return h("div", { class: "v-tile" }, [h("b", { text, style: opt && opt.color ? `color:${opt.color}` : undefined }), h("span", { text: f.label })]);
}

function rowsOf(ctx, f) {
  const rows = getPath(ctx.sheet, f.path);
  return Array.isArray(rows) ? rows : [];
}

// viewTable — таблица в чтении отдельной карточкой с заголовком title
// (по умолчанию — подпись поля).
function viewTable(ctx, id, f, title) {
  const { h } = ctx;
  const heading = title || f.label;
  const rows = rowsOf(ctx, f);
  // Свободные характеристики: плитки «название — значение с модификаторами».
  if (f.statRows) {
    const nameCol = (f.columns || []).find((c) => c.id === f.statRows.name);
    const valueCol = (f.columns || []).find((c) => c.id === f.statRows.value);
    const extra = (f.columns || []).filter((c) => c !== nameCol && c !== valueCol && c.type === "number");
    const named = rows.filter((row) => String(getPath(row, nameCol.path) || "").trim());
    if (!named.length) return null;
    return ctx.vCard(
      heading,
      h(
        "div",
        { class: "v-tiles" },
        named.map((row) => {
          const name = String(getPath(row, nameCol.path));
          const notes = extra.map((c) => getPath(row, c.path)).filter((v) => v !== undefined && v !== null && v !== "");
          const label = notes.length ? `${name} (${notes.map((v) => formatSigned(Number(v) || 0)).join(", ")})` : name;
          return liveTile(ctx, label, () => ({
            text: formatNumber(evaluatorOf(ctx).stat(name)),
            hint: modifierHint(ctx, statTarget(name), getPath(row, valueCol.path)),
          }));
        })
      )
    );
  }
  // Таблица бросков: кнопка на строку с формулой.
  const dice = rollColumn(f);
  if (dice) {
    const title = firstTextColumn(f);
    const buttons = rows
      .map((row, i) => ({ row, i }))
      .filter(({ row }) => dice.type === "roll" || String(getPath(row, dice.path) || "").trim())
      .map(({ row, i }) => {
        const name = (title && String(getPath(row, title.path) || "").trim()) || f.label;
        // Бросок схемы (roll) — показываем уже посчитанную формулу строки.
        const resolved = dice.type === "roll" ? evaluatorOf(ctx).row(id, i).dice(dice.id) : null;
        const text = resolved ? (resolved.error ? "!" : resolved.formula) : String(getPath(row, dice.path)).trim();
        return h("button", { type: "button", class: "v-tile", title: "Бросить: " + text, onclick: () => ctx.sendResolvedRoll(evaluatorOf(ctx).row(id, i).dice(dice.id), name) }, [
          h("b", { text }),
          h("span", { text: name }),
        ]);
      });
    return buttons.length ? ctx.vCard(heading, h("div", { class: "v-tiles" }, buttons)) : null;
  }
  if (!rows.length) return null;
  const cols = (f.columns || []).filter((c) => c.type !== "roll");
  return ctx.vCard(
    heading,
    h("table", { class: "dyn-table" }, [
      h("thead", {}, [h("tr", {}, cols.map((c) => h("th", { text: c.label })))]),
      h(
        "tbody",
        {},
        rows.map((row, i) =>
          h(
            "tr",
            {},
            cols.map((c) => {
              if (c.type === "computed") {
                const r = evaluatorOf(ctx).row(id, i).value(c.id);
                return h("td", { class: r.error ? "formula-error" : undefined, title: r.error ? r.error.message : undefined, text: r.error ? "!" : formatNumber(r.value) });
              }
              if (c.type === "bool") return h("td", { text: getPath(row, c.path) ? "✓" : "" });
              return h("td", { text: String(getPath(row, c.path) ?? "") });
            })
          )
        )
      ),
    ])
  );
}

// ==================== правка ====================

// renderSchemaEdit — вкладки правки по схеме: «Лист», свои вкладки схемы
// (ctx.tabPanel создаёт их), «Портрет» — страницы. Вкладка «Инвентарь» —
// инвентарь страницы, секции схемы на ней не рисуются.
export function renderSchemaEdit(ctx) {
  const { h } = ctx;
  const refreshers = [];
  const refresh = () => refreshers.forEach((fn) => fn());
  const e = { ...ctx, refreshers, refresh };
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
  if (sec.widget) return sec.widget === "resources" ? resourcesTable(e, sec.title || "Ресурсы") : null;
  const fields = e.compiled.schema.fields;
  const list = (sec.fields || []).map((id) => [id, fields[id]]).filter(([, f]) => f && f.type !== "roll");
  if (!list.length) return null;
  const inline = list.filter(([, f]) => f.type !== "table" && f.type !== "longtext");
  const blocks = list.filter(([, f]) => f.type === "table" || f.type === "longtext");
  return h("div", { class: "section" }, [
    sec.title ? h("h3", { text: sec.title }) : null,
    inline.length ? h("div", { class: "row" }, inline.map(([id, f]) => e.field(f.label, editInput(e, id, f, e.sheet)))) : null,
    ...blocks.map(([id, f]) =>
      f.type === "table"
        ? editTable(e, id, f, blocks.length > 1 || list.length > 1 || !sec.title)
        : h("div", {}, [blocks.length > 1 || sec.title !== f.label ? h("h3", { text: f.label }) : null, e.textareaInput(() => getPath(e.sheet, f.path), (v) => setPath(e.sheet, f.path, v), { rows: 8 })])
    ),
  ]);
}

// changed — общее после любой правки: сохранить и пересчитать формулы.
function changed(e) {
  e.scheduleSave();
  e.refresh();
}

// editInput — поле ввода по типу. target — объект, от которого считается
// f.path (лист или строка таблицы); valueOf — вычисленное значение
// (у computed).
function editInput(e, id, f, target, valueOf) {
  const { h } = e;
  const get = () => getPath(target, f.path);
  const set = (v) => setPath(target, f.path, v);
  switch (f.type) {
    case "number":
      return exprInput(e, f, get, set);
    case "text":
    case "dice":
      return plainInput(e, h("input", { type: "text", placeholder: f.placeholder }), get, set);
    case "longtext":
      return plainInput(e, h("textarea", { rows: 4, placeholder: f.placeholder }), get, set);
    case "bool": {
      const c = h("input", { type: "checkbox" });
      c.checked = !!get();
      if (e.readOnly) c.disabled = true;
      else
        c.addEventListener("change", () => {
          set(c.checked);
          changed(e);
        });
      return c;
    }
    case "select": {
      const sel = h("select", {}, [h("option", { value: "", text: "—" }), ...(f.options || []).map((o) => h("option", { value: o.value, text: o.label }))]);
      sel.value = String(get() ?? "");
      if (e.readOnly) sel.disabled = true;
      else
        sel.addEventListener("change", () => {
          if (sel.value) set(sel.value);
          else deletePath(target, f.path);
          changed(e);
        });
      return sel;
    }
    case "resource":
      return h("span", { class: "schema-resource" }, [
        exprInput(e, f, () => getPath(target, f.path + ".current"), (v) => setPath(target, f.path + ".current", v)),
        h("span", { text: "/" }),
        exprInput(e, f, () => getPath(target, f.path + ".max"), (v) => setPath(target, f.path + ".max", v)),
      ]);
    case "computed":
      return computedOutput(e, valueOf || (() => evaluatorOf(e).value(id)));
    default:
      return null;
  }
}

function plainInput(e, inp, get, set) {
  inp.value = get() ?? "";
  if (e.readOnly) inp.disabled = true;
  else
    inp.addEventListener("input", () => {
      set(inp.value);
      changed(e);
    });
  return inp;
}

// exprInput — числовое поле, которое понимает выражение (schema-formula.js:
// applyInput): «-5» и «+3» — от текущего, «12» и «=12» — новое значение,
// «12-3» — посчитать. Применяется по Enter и при уходе из поля; ошибка
// красит поле и уходит в подсказку, значение не меняется. Пустое
// необязательное поле (optional) убирает ключ.
function exprInput(e, f, get, set) {
  const inp = e.h("input", { type: "text", inputmode: "decimal", class: "schema-num", placeholder: f.optional ? "—" : "0", title: "«-5»/«+3» — от текущего, «12» — новое значение, «12-3» — посчитать" });
  const show = () => {
    const v = get();
    inp.value = v === undefined || v === null || v === "" ? (f.optional ? "" : "0") : String(v);
  };
  show();
  if (e.readOnly) {
    inp.disabled = true;
    return inp;
  }
  const commit = () => {
    const text = inp.value.trim().replace(/[‒–—―−]/g, "-");
    if (text === "" && f.optional) {
      if (get() === undefined) return;
      set(undefined);
      changed(e);
      return;
    }
    const current = Number(get()) || 0;
    if (text === String(get() ?? "")) return;
    const r = applyInput(current, text);
    inp.classList.toggle("formula-error", !!r.error);
    if (r.error) {
      inp.title = r.error.message;
      return;
    }
    inp.removeAttribute("title");
    set(r.value);
    show();
    changed(e);
  };
  inp.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      commit();
    }
  });
  inp.addEventListener("blur", commit);
  return inp;
}

function computedOutput(e, read) {
  const span = e.h("span", { class: "computed" });
  const update = () => {
    const r = read();
    span.textContent = r.error ? "!" : formatNumber(r.value);
    span.classList.toggle("formula-error", !!r.error);
    if (r.error) span.title = r.error.message;
    else span.removeAttribute("title");
  };
  update();
  e.refreshers.push(update);
  return span;
}

// rowsTable — таблица строк с «+ строка» и удалением. cells(row, i) —
// ячейки строки; blank() — новая строка.
function rowsTable(e, { title, list, ensure, headers, cells, blank, bare }) {
  const { h } = e;
  const section = h("div", { class: bare ? "" : "section" }, [title ? h("h3", { text: title }) : null]);
  const wrap = h("div", {});
  section.appendChild(wrap);
  const render = () => {
    wrap.innerHTML = "";
    const rows = list() || [];
    const tbody = h("tbody", {});
    rows.forEach((row, i) => {
      tbody.appendChild(
        h("tr", {}, [
          ...cells(row, i).map((c) => h("td", {}, [c])),
          e.readOnly
            ? null
            : h("td", {}, [
                h("button", {
                  type: "button",
                  class: "row-del",
                  title: "Удалить строку",
                  html: icon("close", { size: 11 }),
                  onclick: () => {
                    rows.splice(i, 1);
                    changed(e);
                    render();
                  },
                }),
              ]),
        ])
      );
    });
    wrap.appendChild(h("table", { class: "dyn-table" }, [h("thead", {}, [h("tr", {}, [...headers.map((t) => h("th", { text: t })), e.readOnly ? null : h("th", {})])]), tbody]));
    if (!e.readOnly) {
      wrap.appendChild(
        h("button", {
          type: "button",
          class: "add-row-btn",
          text: "+ строка",
          onclick: () => {
            ensure().push(blank());
            changed(e);
            render();
          },
        })
      );
    }
  };
  render();
  return section;
}

function blankValue(c) {
  switch (c.type) {
    case "number":
      return c.optional ? undefined : 0;
    case "bool":
      return false;
    case "text":
    case "longtext":
    case "dice":
      return "";
    default:
      return undefined;
  }
}

function editTable(e, id, f, withTitle) {
  const cols = (f.columns || []).filter((c) => c.type !== "roll");
  return rowsTable(e, {
    title: withTitle ? f.label : "",
    bare: true,
    list: () => rowsOf(e, f),
    ensure: () => {
      if (!Array.isArray(getPath(e.sheet, f.path))) setPath(e.sheet, f.path, []);
      return getPath(e.sheet, f.path);
    },
    headers: cols.map((c) => c.label),
    blank: () => {
      const row = {};
      for (const c of cols) {
        const v = blankValue(c);
        if (v !== undefined) setPath(row, c.path, v);
      }
      return row;
    },
    cells: (row, i) => cols.map((c) => editInput(e, c.id, c, row, c.type === "computed" ? () => evaluatorOf(e).row(id, i).value(c.id) : null)),
  });
}

// resourcesTable — ресурсы листа (sheet.resources: название, сейчас,
// максимум, восстановление) — общий виджет страницы, в правке — таблица.
function resourcesTable(e, title) {
  const { sheet } = e;
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
