// sheet-universal.js — универсальный лист персонажа: вид листа "universal"
// (см. domain.SheetUniversal) — «Своя система» и системы без своего бланка.
// Только общие механики ядра: хиты, защита, скорость, инициатива-формула,
// свободные характеристики (с модификаторами stat.<ключ>), броски из листа,
// ресурсы, инвентарь, деньги, способности и заметки.
//
// Страница листа одна (pages/character-sheet.js): сохранение, портрет, хиты,
// инвентарь, деньги, ресурсы, живые состояния и броски в чат — её, сюда они
// приходят через ctx, а не копируются. Здесь — только то, чем универсальный
// лист отличается от бланка D&D.
import { icon } from "./icons.js";
import { explainModifiers } from "./modifiers.js";
import { initiativeFormula, statTargetOf, statValue } from "./universal-stats.js";

const fmtMod = (n) => (n >= 0 ? "+" + n : String(n));

// ==================== чтение ====================

// renderUniversalView — карточки режима чтения. Порядок — под узкую
// колонку дока, как у бланка D&D: то, к чему тянутся за ход, — первым.
export function renderUniversalView(ctx) {
  const { h, sheet } = ctx;
  const mods = () => ctx.activeModifiers();

  const initiative = initiativeFormula(sheet);
  const combat = ctx.vCard(
    "Бой",
    h("div", { class: "v-tiles" }, [
      ctx.vTile("Защита", () => String(ctx.effectiveAC(sheet)), null, null, () => ctx.modifierHint("ac", sheet.combat.ac || 0)),
      ctx.vTile("Скорость", () => String(ctx.effectiveSpeed(sheet)), null, null, () => ctx.modifierHint("speed", sheet.combat.speed || 0)),
      ctx.vTile("Инициатива", () => initiative || "—", initiative ? () => initiative : null, "Инициатива"),
    ])
  );

  const statsCard = ctx.vCard(
    "Характеристики",
    (sheet.stats || []).some((s) => String(s.name || "").trim())
      ? h(
          "div",
          { class: "v-tiles" },
          (sheet.stats || [])
            .filter((s) => String(s.name || "").trim())
            .map((s) => {
              const label = s.mod === undefined || s.mod === null || s.mod === "" ? s.name : `${s.name} (${fmtMod(parseInt(s.mod, 10) || 0)})`;
              const hint = () => {
                const parts = explainModifiers(statTargetOf(s), mods());
                return parts.length ? `база ${parseInt(s.value, 10) || 0}; ${parts.join("; ")}` : "";
              };
              return ctx.vTile(label, () => String(statValue(s, mods())), null, null, hint);
            })
        )
      : null
  );

  const rolls = (sheet.rolls || []).filter((r) => String(r.formula || "").trim());
  const rollsCard = ctx.vCard(
    "Броски",
    rolls.length
      ? h(
          "div",
          { class: "v-tiles" },
          rolls.map((r) => {
            const name = String(r.name || "").trim() || "Бросок";
            const formula = String(r.formula).trim();
            return h("button", { type: "button", class: "v-tile", title: "Бросить: " + formula, onclick: () => ctx.sendRoll(formula.replace(/[кК]/g, "d"), name) }, [
              h("b", { text: formula }),
              h("span", { text: name }),
            ]);
          })
        )
      : null
  );

  const statuses = ctx.vCard("Состояния", ctx.liveStatusesHost());

  const col1 = h("div", { class: "v-stack" }, [ctx.vHpCard(), combat, statuses, ctx.vResourcesCard()]);
  const col2 = h("div", { class: "v-stack" }, [statsCard, rollsCard]);
  const col3 = h("div", { class: "v-stack" }, [
    ctx.vInventoryCard(),
    ctx.vMoneyCard(),
    ctx.vText("Способности", sheet.features),
    ctx.vText("Заметки", (sheet.notes || [])[0]),
  ]);
  return h("div", { class: "v-stack" }, [ctx.vHero(), h("div", { class: "v-cols" }, [col1, col2, col3])]);
}

// ==================== правка ====================

// rowsTable — таблица строк с «+ строка» и удалением (характеристики,
// броски, ресурсы). list() — массив листа (создаётся при первом «+»).
function rowsTable(ctx, { title, list, ensure, columns, blank }) {
  const { h } = ctx;
  const section = h("div", { class: "section" }, [h("h3", { text: title })]);
  const wrap = h("div", {});
  section.appendChild(wrap);
  const render = () => {
    wrap.innerHTML = "";
    const rows = list() || [];
    const table = h("table", { class: "dyn-table" }, [h("thead", {}, [h("tr", {}, [...columns.map((c) => h("th", { text: c.title })), ctx.readOnly ? null : h("th", {})])])]);
    const tbody = h("tbody", {});
    rows.forEach((row, i) => {
      tbody.appendChild(
        h("tr", {}, [
          ...columns.map((c) => h("td", {}, [c.cell(row)])),
          ctx.readOnly
            ? null
            : h("td", {}, [
                h("button", {
                  type: "button",
                  class: "row-del",
                  title: "Удалить строку",
                  html: icon("close", { size: 11 }),
                  onclick: () => {
                    rows.splice(i, 1);
                    ctx.scheduleSave();
                    render();
                  },
                }),
              ]),
        ])
      );
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    if (!ctx.readOnly) {
      wrap.appendChild(
        h("button", {
          type: "button",
          class: "add-row-btn",
          text: "+ строка",
          onclick: () => {
            ensure().push(blank());
            ctx.scheduleSave();
            render();
          },
        })
      );
    }
  };
  render();
  return section;
}

// modInput — необязательный модификатор характеристики: пустое поле — нет
// модификатора (ключ mod убирается), иначе целое число.
function modInput(ctx, row) {
  const inp = ctx.h("input", { type: "text", inputmode: "numeric", placeholder: "—", style: "width:64px" });
  inp.value = row.mod === undefined || row.mod === null ? "" : String(row.mod);
  if (ctx.readOnly) inp.disabled = true;
  else
    inp.addEventListener("input", () => {
      const s = inp.value.trim().replace(/−/g, "-");
      if (s === "") delete row.mod;
      else if (/^[+-]?\d+$/.test(s)) row.mod = parseInt(s, 10);
      else return;
      ctx.scheduleSave();
    });
  return inp;
}

// renderUniversalEdit — вкладки правки: «Лист» (tab1) и «Портрет» (tab2);
// «Инвентарь» (tab5) общий с бланком D&D.
export function renderUniversalEdit(ctx) {
  const { h, sheet } = ctx;
  sheet.notes = Array.isArray(sheet.notes) ? sheet.notes : [];

  const combat = h("div", { class: "section" }, [
    h("h3", { text: "Бой" }),
    h("div", { class: "row" }, [
      ctx.field("Хиты сейчас", ctx.numberInput(() => sheet.combat.hpCurrent, (v) => (sheet.combat.hpCurrent = v))),
      ctx.field("Хиты макс.", ctx.numberInput(() => sheet.combat.hpMax, (v) => (sheet.combat.hpMax = v), { min: 0 })),
      ctx.field("Врем. хиты", ctx.numberInput(() => sheet.combat.hpTemp, (v) => (sheet.combat.hpTemp = v), { min: 0 })),
    ]),
    h("div", { class: "row" }, [
      ctx.field("Защита", ctx.numberInput(() => sheet.combat.ac, (v) => (sheet.combat.ac = v), { min: 0 })),
      ctx.field("Скорость", ctx.numberInput(() => sheet.combat.speed, (v) => (sheet.combat.speed = v), { min: 0 })),
      ctx.field("Инициатива", ctx.textInput(() => sheet.initiative, (v) => (sheet.initiative = v), { placeholder: "1d20+2, 2d6 или 3" })),
    ]),
  ]);

  const stats = rowsTable(ctx, {
    title: "Характеристики",
    list: () => sheet.stats,
    ensure: () => (sheet.stats = sheet.stats || []),
    blank: () => ({ name: "", value: 0 }),
    columns: [
      { title: "Название", cell: (row) => ctx.textInput(() => row.name, (v) => (row.name = v), { placeholder: "Сила, Удача…" }) },
      { title: "Значение", cell: (row) => ctx.numberInput(() => row.value, (v) => (row.value = v), { style: "width:72px" }) },
      { title: "Модификатор", cell: (row) => modInput(ctx, row) },
    ],
  });

  const rolls = rowsTable(ctx, {
    title: "Броски",
    list: () => sheet.rolls,
    ensure: () => (sheet.rolls = sheet.rolls || []),
    blank: () => ({ name: "", formula: "" }),
    columns: [
      { title: "Название", cell: (row) => ctx.textInput(() => row.name, (v) => (row.name = v), { placeholder: "Меч, Проверка удачи…" }) },
      { title: "Формула", cell: (row) => ctx.textInput(() => row.formula, (v) => (row.formula = v), { placeholder: "1d8+3" }) },
    ],
  });

  const resources = rowsTable(ctx, {
    title: "Ресурсы",
    list: () => sheet.resources,
    ensure: () => (sheet.resources = sheet.resources || []),
    blank: () => ({ name: "", current: 0, max: 0, recovery: "" }),
    columns: [
      { title: "Название", cell: (row) => ctx.textInput(() => row.name, (v) => (row.name = v)) },
      { title: "Сейчас", cell: (row) => ctx.numberInput(() => row.current, (v) => (row.current = v), { min: 0, style: "width:64px" }) },
      { title: "Максимум", cell: (row) => ctx.numberInput(() => row.max, (v) => (row.max = v), { min: 0, style: "width:64px" }) },
      { title: "Восстановление", cell: (row) => ctx.textInput(() => row.recovery, (v) => (row.recovery = v), { placeholder: "после отдыха" }) },
    ],
  });

  const texts = h("div", { class: "section" }, [
    h("h3", { text: "Способности" }),
    ctx.textareaInput(() => sheet.features, (v) => (sheet.features = v), { rows: 8 }),
    h("h3", { text: "Заметки" }),
    ctx.textareaInput(() => sheet.notes[0], (v) => (sheet.notes[0] = v), { rows: 8 }),
  ]);

  const tab1 = document.getElementById("tab1");
  tab1.innerHTML = "";
  tab1.appendChild(
    h("div", { class: "grid-cols" }, [h("div", { class: "col" }, [combat, stats]), h("div", { class: "col" }, [rolls, resources]), h("div", { class: "col" }, [texts])])
  );

  const tab2 = document.getElementById("tab2");
  tab2.innerHTML = "";
  tab2.appendChild(h("div", { class: "grid-cols" }, [h("div", { class: "col" }, [ctx.identitySection()])]));
}
