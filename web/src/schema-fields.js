// schema-fields.js — поля схемы по типам (задача «Схемы листа и карточек»):
// плитки и таблицы режима чтения, поля ввода режима правки, таблицы строк.
// Общие для листа персонажа (schema-sheet.js) и карточек библиотеки
// (schema-card.js) — каждый из них раскладывает поля по-своему.
//
// ctx — то, что даёт вызывающий:
//   h, compiled (schema-formula.js: compileSchema), data (лист или
//   карточка — объект, от которого считаются пути полей), readOnly,
//   activeModifiers() (у карточек — пусто), onRefresh(fn) — пересчитать
//   при изменении, refresh() — пересчитать сейчас, scheduleSave(),
//   sendResolvedRoll(результат броска, подпись), vCard(заголовок, дети).
import { icon } from "./icons.js";
import { enhanceRolls, rollFormula } from "./inline-rolls.js";
import { explainModifiers, statTarget } from "./modifiers.js";
import { applyInput, createEvaluator } from "./schema-formula.js";
import { cellPath, deletePath, formatNumber, formatPool, formatSigned, getPath, parsePool, setPath } from "./schema-layout.js";
import { fetchReferences } from "./api.js";
import { displayValue } from "./schema-list.js";
import { checkDie } from "./system-profile.js";

export const SCALARS = new Set(["number", "computed", "text", "bool", "select", "dice", "roll", "resource", "prof", "tally", "pool", "template"]);

// showNumber — число поля или колонки, со знаком при signed.
export const showNumber = (f, v) => (f.signed ? formatSigned(v) : formatNumber(v));

// profLevel — состояние владения: 0 нет, 1 владение, 2 экспертиза.
export const profLevel = (f, v) => (f.levels === 3 ? Number(v) || 0 : v ? 1 : 0);

const PROF_TITLES = ["Без владения", "Владение", "Экспертиза"];
const PROF_MARKS = ["—", "●", "◆"];
const profMark = (f, v) => (f.levels === 3 ? PROF_MARKS[profLevel(f, v)] : v ? "✓" : "");

// evaluatorOf — свежий расчёт по текущему состоянию листа или карточки:
// значения и модификаторы меняются прямо во время просмотра (надел кольцо,
// повесили метку), поэтому не кэшируется.
export const evaluatorOf = (ctx) => createEvaluator(ctx.compiled, ctx.data, ctx.activeModifiers());

// firstTextColumn — колонка-название строки таблицы (подпись броска).
export const firstTextColumn = (f) => (f.columns || []).find((c) => c.type === "text");
export const rollColumn = (f) => (f.columns || []).find((c) => c.type === "dice" || c.type === "roll");

// liveTile — плитка, которая пересчитывается вместе с листом: read() →
// { text, error, hint }. Ошибка формулы красит плитку и уходит в подсказку.
export function liveTile(ctx, label, read, onclick) {
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

export function viewTile(ctx, id, f) {
  const raw = () => getPath(ctx.data, f.path);
  switch (f.type) {
    case "number":
    case "computed":
      return liveTile(
        ctx,
        f.label,
        () => {
          const r = evaluatorOf(ctx).value(id);
          if (r.error) return { text: "!", error: r.error };
          const hint = f.modifierTarget ? modifierHint(ctx, f.modifierTarget, f.type === "number" ? raw() : null) : "";
          return { text: showNumber(f, r.value), hint };
        },
        f.roll ? () => ctx.sendResolvedRoll(evaluatorOf(ctx).rollField(id), f.label) : null
      );
    case "template":
      return liveTile(ctx, f.label, () => ({ text: displayValue(ctx.compiled, ctx.data, id) }));
    case "prof":
      return liveTile(ctx, f.label, () => ({ text: f.levels === 3 ? PROF_MARKS[profLevel(f, raw())] : raw() ? "✓" : "—" }));
    case "tally":
      return ctx.h("div", { class: "v-tile" }, [tallyPips(ctx, f, raw, (v) => setPath(ctx.data, f.path, v)), ctx.h("span", { text: f.label })]);
    case "pool":
      return ctx.h("div", { class: "v-tile" }, [ctx.h("div", { class: "v-track" }, poolNodes(ctx, raw, (v) => setPath(ctx.data, f.path, v))), ctx.h("span", { text: f.label })]);
    case "text":
      return String(raw() ?? "").trim() ? liveTile(ctx, f.label, () => ({ text: String(raw() ?? "") })) : null;
    case "bool":
      return liveTile(ctx, f.label, () => ({ text: raw() ? "✓" : "—" }), ctx.readOnly ? null : () => {
        setPath(ctx.data, f.path, !raw());
        changed(ctx);
      });
    case "select":
      return selectTile(ctx, f, raw());
    case "resource": {
      const cur = () => formatNumber(Number(getPath(ctx.data, f.path + ".current")) || 0);
      const max = () => formatNumber(Number(getPath(ctx.data, f.path + ".max")) || 0);
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

export function modifierHint(ctx, target, base) {
  const parts = explainModifiers(target, ctx.activeModifiers());
  if (!parts.length) return "";
  return base === null || base === undefined ? parts.join("; ") : `база ${formatNumber(Number(base) || 0)}; ${parts.join("; ")}`;
}

export function selectTile(ctx, f, value) {
  if (value === undefined || value === null || value === "") return null;
  const opt = (f.options || []).find((o) => o.value === String(value));
  const { h } = ctx;
  const text = opt ? opt.label : String(value);
  return h("div", { class: "v-tile" }, [h("b", { text, style: opt && opt.color ? `color:${opt.color}` : undefined }), h("span", { text: f.label })]);
}

export function rowsOf(ctx, f) {
  const rows = getPath(ctx.data, f.path);
  return Array.isArray(rows) ? rows : [];
}

// viewTable — таблица в чтении отдельной карточкой с заголовком title
// (по умолчанию — подпись поля).
export function viewTable(ctx, id, f, title) {
  if (f.rows) return viewKeyedTable(ctx, id, f, title);
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
                return h("td", { class: r.error ? "formula-error" : undefined, title: r.error ? r.error.message : undefined, text: r.error ? "!" : showNumber(c, r.value) });
              }
              if (c.type === "bool") return h("td", { text: getPath(row, c.path) ? "✓" : "" });
              if (c.type === "prof") return h("td", { text: profMark(c, getPath(row, c.path)) });
              if (c.type === "text" && c.rollable) return rollableCell(ctx, c, String(getPath(row, c.path) ?? ""), rowName(f, row) || c.label);
              return h("td", { text: String(getPath(row, c.path) ?? "") });
            })
          )
        )
      ),
    ])
  );
}

const rowName = (f, row) => {
  const col = firstTextColumn(f);
  return col ? String(getPath(row, col.path) || "").trim() : "";
};

// cellTiles — плитки секции (cells): у каждой подпись первого поля и
// значения всех; значение с броском (roll) кликабельно. style: "sheet" —
// плитки листа, "card" — плитки статблока.
export function cellTiles(ctx, sec, style) {
  const { h } = ctx;
  const fields = ctx.compiled.schema.fields;
  const card = style === "card";
  const value = (id, first) => {
    const f = fields[id];
    const read = () => {
      const r = f.type === "template" ? { value: displayValue(ctx.compiled, ctx.data, id) } : evaluatorOf(ctx).value(id);
      return r.error ? { text: "!", error: r.error } : { text: typeof r.value === "string" ? r.value : showNumber(f, r.value) };
    };
    const clickable = f.roll && !first;
    const node = card
      ? h(clickable ? "button" : "span", { type: clickable ? "button" : undefined, class: first ? "mb-score" : "mb-mod", title: clickable ? "Бросить " + f.label : undefined })
      : h(clickable ? "button" : "b", { type: clickable ? "button" : undefined, class: clickable ? "cell-roll" : undefined });
    if (clickable) node.addEventListener("click", () => ctx.sendResolvedRoll(evaluatorOf(ctx).rollField(id), f.label));
    const update = () => {
      const r = read();
      node.textContent = r.text;
      node.classList.toggle("formula-error", !!r.error);
    };
    update();
    ctx.onRefresh(update);
    return node;
  };
  const tiles = sec.cells.map((ids) => {
    const label = fields[ids[0]].short || fields[ids[0]].label;
    if (card) return h("div", { class: "mb-tile" }, [h("span", { class: "card-lbl", text: label }), ...ids.map((id, i) => value(id, i === 0))]);
    return h("div", { class: "v-tile" }, [...ids.map((id, i) => value(id, i === 0)), h("span", { text: label })]);
  });
  return h("div", { class: card ? "mb-ab" : "v-tiles" }, tiles);
}

// rollableCell — ячейка текста, которую можно бросить: бонус «+5» кубом
// проверки (check) или формулы внутри текста (inline).
function rollableCell(ctx, c, text, label) {
  const td = ctx.h("td", {});
  if (c.rollable === "inline") {
    td.textContent = text;
    enhanceRolls(td, ctx.sendRoll);
    return td;
  }
  const formula = /^[+-]\d+$/.test(text.trim()) ? rollFormula(text.trim(), checkDie()) : null;
  if (!formula) {
    td.textContent = text;
    return td;
  }
  td.appendChild(ctx.h("button", { type: "button", class: "v-atk-hit", text: text.trim(), title: "Бросить: " + formula, onclick: () => ctx.sendRoll(formula, label) }));
  return td;
}

// ---------- таблицы со строками (rows) ----------

// viewKeyedTable — таблица со строками в чтении: с колонкой броска — сетка
// кнопок, со счётчиком-строкой — строки с делениями, иначе обычная.
export function viewKeyedTable(ctx, id, f, title) {
  const { h } = ctx;
  const cols = f.columns || [];
  const heading = title || f.label;
  const roll = cols.find((c) => c.type === "roll");
  const pool = cols.find((c) => c.type === "pool");
  const prof = cols.find((c) => c.type === "prof");
  // итог строки — последняя вычисляемая или числовая колонка
  const shown = cols.filter((c) => c.type === "computed" || c.type === "number").pop();
  const rawOf = (c, row) => getPath(ctx.data, cellPath(f, c, row));
  const paint = (node, c, i) => {
    const r = evaluatorOf(ctx).row(id, i).value(c.id);
    node.textContent = r.error ? "!" : showNumber(c, r.value);
    node.classList.toggle("formula-error", !!r.error);
    if (r.error) node.title = r.error.message;
    else node.removeAttribute("title");
  };
  const live = (node, c, i) => {
    paint(node, c, i);
    ctx.onRefresh(() => paint(node, c, i));
    return node;
  };
  if (roll) {
    const buttons = f.rows.map((row, i) => {
      const level = prof ? profLevel(prof, rawOf(prof, row)) : 0;
      return h(
        "button",
        {
          type: "button",
          class: "v-skill" + (level ? " prof" : ""),
          title: (prof ? PROF_TITLES[level] + " · " : "") + "бросок",
          onclick: () => ctx.sendResolvedRoll(evaluatorOf(ctx).row(id, i).dice(roll.id), row.label),
        },
        [h("span", { class: "v-dot" + (level ? " p" + level : "") }), h("span", { class: "v-skill-name", text: row.label }), shown ? live(h("span", { class: "v-skill-val" }), shown, i) : null]
      );
    });
    return ctx.vCard(heading, h("div", { class: "v-skills" }, buttons), "клик — бросок");
  }
  if (pool) {
    const tracks = f.rows
      .filter((row) => String(rawOf(pool, row) ?? "").trim())
      .map((row) =>
        h("div", { class: "v-track" }, [
          h("span", { class: "v-track-name", text: row.label }),
          ...poolNodes(ctx, () => rawOf(pool, row), (v) => setPath(ctx.data, cellPath(f, pool, row), v)),
        ])
      );
    return ctx.vCard(heading, tracks, tracks.length ? "клик — потратить/вернуть" : null);
  }
  const plain = cols.filter((c) => c.type !== "roll");
  const cell = (c, row, i) => {
    if (c.type === "computed") return live(h("td", {}), c, i);
    return h("td", { text: c.type === "prof" ? profMark(c, rawOf(c, row)) : String(rawOf(c, row) ?? "") });
  };
  return ctx.vCard(
    heading,
    h("table", { class: "dyn-table" }, [
      h("thead", {}, [h("tr", {}, [h("th", {}), ...plain.map((c) => h("th", { text: c.label }))])]),
      h("tbody", {}, f.rows.map((row, i) => h("tr", {}, [h("td", { text: row.label }), ...plain.map((c) => cell(c, row, i))]))),
    ])
  );
}

// editKeyedTable — таблица со строками в правке.
export function editKeyedTable(e, id, f, withTitle) {
  const { h } = e;
  const cols = (f.columns || []).filter((c) => c.type !== "roll");
  const cell = (c, row, i) => {
    const own = c.path ? { ...c, path: cellPath(f, c, row) } : c;
    return h("td", {}, [editInput(e, c.id, own, e.data, c.type === "computed" ? () => evaluatorOf(e).row(id, i).value(c.id) : null)]);
  };
  return h("div", {}, [
    withTitle ? h("h3", { text: f.label }) : null,
    h("table", { class: "dyn-table" }, [
      h("thead", {}, [h("tr", {}, [h("th", {}), ...cols.map((c) => h("th", { text: c.label }))])]),
      h("tbody", {}, f.rows.map((row, i) => h("tr", {}, [h("td", { text: row.label }), ...cols.map((c) => cell(c, row, i))]))),
    ]),
  ]);
}

// ---------- владение, шкалы, счётчики ----------

// profToggle — переключатель владения, пишет bool или число 0..2.
export function profToggle(e, f, get, set) {
  const tri = f.levels === 3;
  const btn = e.h("button", { type: "button", class: "prof-toggle" });
  const show = () => {
    const level = profLevel(f, get());
    btn.setAttribute("data-state", String(level));
    btn.textContent = level === 2 ? "◆" : "";
    btn.title = tri ? PROF_TITLES[level] : level ? "Есть" : "Нет";
  };
  show();
  if (e.readOnly) btn.disabled = true;
  else
    btn.addEventListener("click", () => {
      const next = (profLevel(f, get()) + 1) % (tri ? 3 : 2);
      set(tri ? next : next === 1);
      show();
      changed(e);
    });
  return btn;
}

// tallyPips — шкала из max делений: клик по крайнему заполненному гасит его,
// иначе заполняет по это включительно.
export function tallyPips(e, f, get, set) {
  const wrap = e.h("div", { class: "bulb-row" });
  const render = () => {
    wrap.innerHTML = "";
    const value = Number(get()) || 0;
    for (let i = 0; i < f.max; i++) {
      wrap.appendChild(
        e.h("button", {
          type: "button",
          class: "bulb" + (i < value ? " filled" + (f.tone === "bad" ? " fail" : "") : ""),
          title: String(i + 1),
          onclick: e.readOnly
            ? undefined
            : () => {
                set(value > i ? i : i + 1);
                render();
                changed(e);
              },
        })
      );
    }
  };
  render();
  return wrap;
}

// poolNodes — счётчик «осталось / всего» и деления; строка, которую не
// разобрать, остаётся текстом.
export function poolNodes(e, get, set) {
  const count = e.h("span", { class: "v-track-count" });
  const pips = e.h("div", { class: "v-pips" });
  const render = () => {
    const p = parsePool(get());
    pips.innerHTML = "";
    if (!p) {
      count.textContent = String(get() ?? "");
      return;
    }
    const left = p.total - p.used;
    count.textContent = `${left} / ${p.total}`;
    for (let i = 0; i < p.total; i++) {
      pips.appendChild(
        e.h("button", {
          type: "button",
          class: "v-pip" + (i < left ? "" : " spent"),
          title: String(i + 1),
          onclick: e.readOnly
            ? undefined
            : () => {
                set(formatPool(p.total, p.total - (left > i ? i : i + 1)));
                render();
                changed(e);
              },
        })
      );
    }
  };
  render();
  e.onRefresh(render);
  return [count, pips];
}

// changed — общее после любой правки: сохранить и пересчитать формулы.
export function changed(e) {
  e.scheduleSave();
  if (e.refresh) e.refresh();
}

// editInput — поле ввода по типу. target — объект, от которого считается
// f.path (лист или строка таблицы); valueOf — вычисленное значение
// (у computed).
export function editInput(e, id, f, target, valueOf) {
  const { h } = e;
  const get = () => getPath(target, f.path);
  const set = (v) => setPath(target, f.path, v);
  switch (f.type) {
    case "number":
      return exprInput(e, f, get, set);
    case "text":
      return f.suggest ? suggestInput(e, f, target, get, set) : plainInput(e, h("input", { type: "text", placeholder: f.placeholder }), get, set);
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
    case "prof":
      return profToggle(e, f, get, set);
    case "tally":
      return tallyPips(e, f, get, set);
    case "pool":
      return plainInput(e, h("input", { type: "text", placeholder: "4 или 4/2 — всего/потрачено" }), get, set);
    case "select": {
      const current = String(get() ?? "");
      const known = (f.options || []).some((o) => o.value === current);
      const sel = h("select", {}, [
        h("option", { value: "", text: "—" }),
        ...(f.options || []).map((o) => h("option", { value: o.value, text: o.label })),
        current && !known ? h("option", { value: current, text: current }) : null,
      ]);
      sel.value = current;
      if (e.readOnly) sel.disabled = true;
      else
        sel.addEventListener("change", () => {
          if (sel.value) set(f.numeric ? Number(sel.value) : sel.value);
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
      return computedOutput(e, valueOf || (() => evaluatorOf(e).value(id)), f);
    default:
      return null;
  }
}

// suggestInput — текстовое поле с подсказками из справочника: названия
// записей вида f.suggest.reference; у записей с родителем — только с
// родителем из поля f.suggest.parentField (архетипы выбранного класса).
let referencesLoad = null;
let suggestSeq = 0;

function suggestInput(e, f, target, get, set) {
  const list = e.h("datalist", { id: "schema-suggest-" + suggestSeq++ });
  const inp = e.h("input", { type: "text", placeholder: f.placeholder, list: list.id });
  const parent = f.suggest.parentField && e.compiled.schema.fields[f.suggest.parentField];
  const kind = String(f.suggest.reference).trim().toLowerCase();
  let references = [];
  const fill = () => {
    const owner = parent ? String(getPath(target, parent.path) ?? "").trim() : "";
    list.innerHTML = "";
    for (const r of references) {
      if (String(r.kind || "").trim().toLowerCase() !== kind) continue;
      if (owner && r.parentName && r.parentName !== owner) continue;
      list.appendChild(e.h("option", { value: r.name }));
    }
  };
  if (!referencesLoad) referencesLoad = fetchReferences().catch(() => []);
  referencesLoad.then((all) => {
    references = all;
    fill();
  });
  e.onRefresh(fill);
  return e.h("span", { class: "suggest-wrap" }, [plainInput(e, inp, get, set), list]);
}

export function plainInput(e, inp, get, set) {
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
export function exprInput(e, f, get, set) {
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

export function computedOutput(e, read, f) {
  const span = e.h("span", { class: "computed" });
  const update = () => {
    const r = read();
    span.textContent = r.error ? "!" : typeof r.value === "string" ? r.value : f ? showNumber(f, r.value) : formatNumber(r.value);
    span.classList.toggle("formula-error", !!r.error);
    if (r.error) span.title = r.error.message;
    else span.removeAttribute("title");
  };
  update();
  e.onRefresh(update);
  return span;
}

// rowsTable — таблица строк с «+ строка» и удалением. cells(row, i) —
// ячейки строки; blank() — новая строка.
export function rowsTable(e, { title, list, ensure, headers, cells, blank, bare }) {
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

export function blankValue(c) {
  switch (c.type) {
    case "number":
      return c.optional ? undefined : 0;
    case "bool":
      return false;
    case "prof":
      return c.levels === 3 ? 0 : false;
    case "tally":
      return 0;
    case "pool":
      return "";
    case "text":
    case "longtext":
    case "dice":
      return "";
    default:
      return undefined;
  }
}

export function editTable(e, id, f, withTitle) {
  if (f.rows) return editKeyedTable(e, id, f, withTitle);
  const cols = (f.columns || []).filter((c) => c.type !== "roll");
  return rowsTable(e, {
    title: withTitle ? f.label : "",
    bare: true,
    list: () => rowsOf(e, f),
    ensure: () => {
      if (!Array.isArray(getPath(e.data, f.path))) setPath(e.data, f.path, []);
      return getPath(e.data, f.path);
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
