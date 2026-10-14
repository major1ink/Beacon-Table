// Своя вкладка-сетка: ячейки, их правка, перетаскивание и растягивание.
import { icon } from "../icons.js";
import { showPrompt } from "../modal.js";
import { ctx, data, el, isRule, newCellId, shortName } from "./shared.js";
import { hasRollTable } from "../random-table.js";
import { conditionsList, journalBody, openJournalButton, openReferenceButton, referenceBody, rollWidget, timerWidget } from "./cells.js";
import { counterWidget } from "./counter.js";
import { feedWidget, graphWidget, openFeedButton, openGraphButton } from "./session-cells.js";

const ROW_H = 150;
const GAP = 12;

const WIDGETS = [
  { kind: "conditions", title: "Состояния", glyph: "list", w: 1, h: 3 },
  { kind: "roll", title: "Бросок", glyph: "dice", w: 1, h: 3 },
  { kind: "timer", title: "Таймер", glyph: "clock", w: 1, h: 1, seconds: 300 },
  { kind: "counter", title: "Счётчик", glyph: "plus", w: 1, h: 1 },
  { kind: "feed", title: "Лента сессии", glyph: "clock", w: 2, h: 3 },
  { kind: "graph", title: "Граф связей", glyph: "graph", w: 2, h: 3 },
];

const defaultTitle = (cell) => (WIDGETS.find((w) => w.kind === cell.kind) || {}).title || "";

export function renderGrid(tab, bodyEl) {
  const wrap = el("div", { class: "grid-wrap" + (ctx.editing ? " editing" : "") });
  const grid = el("div", { class: "grid-tab", style: `--cols:${tab.columns || 3}` });
  wrap.append(grid);
  bodyEl.append(wrap);

  const cells = tab.cells || [];
  if (!cells.length) {
    grid.append(
      el("p", {
        class: "empty-state",
        style: "grid-column:1/-1",
        text: ctx.gm ? (ctx.editing ? "Перетащите сюда что-нибудь из панели справа или нажмите на пункт." : "Пустая вкладка. Нажмите «Правка», чтобы добавить ячейки.") : "Здесь пусто.",
      })
    );
  }
  for (const cell of cells) grid.append(cellEl(tab, cell, grid));

  if (ctx.editing) {
    grid.ondragover = (e) => e.preventDefault();
    grid.ondrop = (e) => {
      e.preventDefault();
      dropInto(tab, e, cells.length);
    };
    wrap.append(addPanel(tab));
  }
}

function cellEl(tab, cell, grid) {
  const art = el("article", { class: "cell gcell", style: `--w:${cell.w || 1};--h:${cell.h || 1}` });
  const title = el("h3", { text: defaultTitle(cell) || "…" });
  const head = el("div", { class: "cell-head" }, [title]);
  const body = el("div", { class: "gcell-body" });
  art.append(head, body);
  fillCell(cell, title, head, body);

  if (ctx.editing) {
    art.draggable = true;
    art.classList.add("edit");
    head.prepend(el("span", { class: "grip", "aria-hidden": "true", html: icon("grip-vertical", { size: 14 }) }));
    if (["roll", "timer", "counter"].includes(cell.kind)) {
      title.classList.add("rename");
      title.title = "Переименовать";
      title.onclick = async () => {
        const name = await showPrompt("Название ячейки", { title: "Ячейка", value: cell.title || defaultTitle(cell), okLabel: "Сохранить" });
        if (name === null || name === undefined) return;
        cell.title = name.trim();
        ctx.persist();
      };
    }
    const remove = el("button", { class: "icon-btn", type: "button", title: "Убрать ячейку", html: icon("close", { size: 14 }) });
    remove.onclick = () => {
      tab.cells = tab.cells.filter((c) => c !== cell);
      ctx.persist();
    };
    head.append(remove);
    const handle = el("span", { class: "resize", title: "Потяните, чтобы изменить размер", html: icon("expand", { size: 12 }) });
    handle.onpointerdown = (e) => startResize(e, tab, cell, art, grid);
    art.append(handle);

    art.ondragstart = (e) => {
      e.dataTransfer.setData("text/x-screen-cell", cell.id);
      e.dataTransfer.effectAllowed = "move";
      art.classList.add("dragging");
    };
    art.ondragend = () => art.classList.remove("dragging");
    art.ondragover = (e) => {
      e.preventDefault();
      e.stopPropagation();
      art.classList.add("drop-before");
    };
    art.ondragleave = () => art.classList.remove("drop-before");
    art.ondrop = (e) => {
      e.preventDefault();
      e.stopPropagation();
      art.classList.remove("drop-before");
      dropInto(tab, e, tab.cells.indexOf(cell));
    };
  }
  return art;
}

async function fillCell(cell, title, head, body) {
  const label = cell.title || defaultTitle(cell);
  if (label) title.textContent = label;
  switch (cell.kind) {
    case "conditions":
      body.append(conditionsList(await data.conditions()));
      break;
    case "roll":
      body.append(rollWidget());
      break;
    case "timer":
      body.append(timerWidget(cell));
      break;
    case "counter":
      body.append(counterWidget(cell));
      break;
    case "feed":
      if (!ctx.editing) head.append(openFeedButton());
      body.append(feedWidget());
      break;
    case "graph":
      if (!ctx.editing) head.append(openGraphButton());
      body.append(graphWidget());
      break;
    case "reference": {
      const card = (await data.references()).find((r) => r.id === cell.ref);
      if (!card) {
        title.textContent = "Карточка удалена";
        break;
      }
      title.textContent = shortName(card.name);
      if (!ctx.editing) head.append(openReferenceButton(card));
      body.append(...referenceBody(card));
      break;
    }
    case "journal": {
      const { entry, body: text } = await journalBody(cell.ref);
      title.textContent = entry ? entry.title || "Без названия" : "Запись недоступна";
      if (entry && !ctx.editing) head.append(openJournalButton(entry.id));
      body.append(text);
      break;
    }
  }
}

function dropInto(tab, e, index) {
  const moving = e.dataTransfer.getData("text/x-screen-cell");
  const fresh = e.dataTransfer.getData("text/x-screen-new");
  const cells = tab.cells || (tab.cells = []);
  if (moving) {
    const from = cells.findIndex((c) => c.id === moving);
    if (from < 0) return;
    const [cell] = cells.splice(from, 1);
    cells.splice(from < index ? index - 1 : index, 0, cell);
  } else if (fresh) {
    cells.splice(index, 0, { ...JSON.parse(fresh), id: newCellId() });
  } else return;
  ctx.persist();
}

function startResize(e, tab, cell, art, grid) {
  e.preventDefault();
  e.stopPropagation();
  const cols = tab.columns || 3;
  const gridRect = grid.getBoundingClientRect();
  const style = getComputedStyle(grid);
  const inner = gridRect.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const colW = (inner - GAP * (cols - 1)) / cols;
  const start = art.getBoundingClientRect();
  const handle = e.currentTarget;
  handle.setPointerCapture(e.pointerId);
  const move = (ev) => {
    cell.w = Math.min(cols, Math.max(1, Math.round((ev.clientX - start.left + GAP) / (colW + GAP))));
    cell.h = Math.min(6, Math.max(1, Math.round((ev.clientY - start.top + GAP) / (ROW_H + GAP))));
    art.style.setProperty("--w", cell.w);
    art.style.setProperty("--h", cell.h);
  };
  const up = () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    ctx.persist();
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
}

// ---- панель «Добавить в ширму» ----

function addPanel(tab) {
  const search = el("input", { class: "field", type: "search", placeholder: "Правило, карточка, запись…", "aria-label": "Поиск", style: "font-size:13px;height:36px" });
  const list = el("div", { class: "add-list" });
  const aside = el("aside", { class: "add-panel", "aria-label": "Добавить в ширму" }, [el("div", { class: "serif add-title", text: "Добавить в ширму" }), search, list]);

  const item = (glyph, text, cell, sub) => {
    const b = el("button", { class: "add-item", type: "button", draggable: "true" }, [el("span", { class: "add-ic", html: icon(glyph, { size: 14 }) }), el("span", { class: "add-text", text }), sub ? el("small", { text: sub }) : null]);
    b.onclick = () => {
      (tab.cells ||= []).push({ ...cell, id: newCellId() });
      ctx.persist();
    };
    b.ondragstart = (e) => {
      e.dataTransfer.setData("text/x-screen-new", JSON.stringify(cell));
      e.dataTransfer.effectAllowed = "copy";
    };
    return b;
  };

  const draw = async () => {
    const q = search.value.trim().toLowerCase();
    const [refs, notes] = await Promise.all([data.references(), data.journal()]);
    list.textContent = "";
    const group = (name) => list.append(el("div", { class: "add-group", text: name }));
    if (!q) {
      group("Виджеты");
      for (const w of WIDGETS) list.append(item(w.glyph, w.title, { kind: w.kind, w: w.w, h: w.h, seconds: w.seconds }));
    }
    const match = (s) => !q || String(s || "").toLowerCase().includes(q);
    const tables = q ? [] : refs.filter((r) => hasRollTable(r.description)).slice(0, 40);
    if (tables.length) {
      group("Таблицы");
      for (const r of tables) list.append(item("dice", shortName(r.name), { kind: "reference", ref: r.id, w: 1, h: 2 }));
    }
    const cards = refs.filter((r) => (q ? match(r.name) : isRule(r))).slice(0, 40);
    if (cards.length) {
      group(q ? "Справочник" : "Правила");
      for (const r of cards) list.append(item("book-open", shortName(r.name), { kind: "reference", ref: r.id, w: 1, h: 2 }));
    }
    const entries = notes.filter((n) => match(n.title) || match(n.folder)).slice(0, q ? 40 : 15);
    if (entries.length) {
      group("Журнал");
      for (const n of entries) list.append(item("scroll", n.title || "Без названия", { kind: "journal", ref: n.id, w: 1, h: 2 }, n.folder));
    }
    if (!list.children.length) list.append(el("p", { class: "dim", text: "Ничего не найдено." }));
  };
  search.oninput = draw;
  draw();
  return aside;
}
