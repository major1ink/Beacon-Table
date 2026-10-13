// gm-screen.js — ширма ведущего в плавающем окне. Игрок видит только открытые
// ему вкладки, только для чтения.
import { fetchMe, fetchScreen, saveScreen, createReference, updateReference } from "../api.js";
import { openSocket } from "../ws-reconnect.js";
import { isGM } from "../roles.js";
import { icon } from "../icons.js";
import { loadSystemProfile } from "../system-profile.js";
import { openModal, showPrompt, showAlert, showConfirm } from "../modal.js";
import { ctx, data, el, isRule, newCellId, openInHost, RULE_TAG, shortName } from "../gm-screen/shared.js";
import { conditionsList, journalBody, onRoll, openReferenceButton, referenceBody } from "../gm-screen/cells.js";
import { renderGrid } from "../gm-screen/grid.js";

const tabsEl = document.getElementById("tabs");
const bodyEl = document.getElementById("body");
const shareBtn = document.getElementById("shareBtn");
const editBtn = document.getElementById("editBtn");
const modeBadge = document.getElementById("modeBadge");
const sharedStrip = document.getElementById("sharedStrip");
const editBar = document.getElementById("editBar");

const TAB_KEY = "beacon:screenTab";
let currentTab = new URLSearchParams(location.search).get("tab") || readTab();

function readTab() {
  try {
    return localStorage.getItem(TAB_KEY) || "";
  } catch {
    return "";
  }
}
let selectedNote = "";
// updatedAt своего последнего сохранения: на своё же уведомление не перерисовываемся.
let savedAt = "";

// ---- вкладки ----

const tabById = (id) => ctx.screen.tabs.find((t) => t.id === id);

function renderTabs() {
  tabsEl.textContent = "";
  if (!tabById(currentTab)) currentTab = ctx.screen.tabs[0] ? ctx.screen.tabs[0].id : "";
  for (const t of ctx.screen.tabs) {
    const btn = el("button", { class: "tab" + (t.id === currentTab ? " on" : ""), role: "tab", "aria-selected": String(t.id === currentTab), type: "button" });
    if (ctx.gm && t.shared) btn.append(el("span", { class: "shared-eye", title: "Видят игроки", html: icon("eye", { size: 14 }) }));
    btn.append(t.title);
    btn.onclick = () => {
      currentTab = t.id;
      try {
        localStorage.setItem(TAB_KEY, t.id);
      } catch {
        /* приватный режим */
      }
      render();
    };
    tabsEl.append(btn);
  }
  if (ctx.editing) {
    const add = el("button", { class: "tab", type: "button", title: "Новая вкладка", html: icon("plus", { size: 15 }) + " Вкладка" });
    add.onclick = newTab;
    tabsEl.append(add);
  }
}

function renderHeader() {
  const t = tabById(currentTab);
  if (!ctx.gm) {
    modeBadge.hidden = false;
    modeBadge.innerHTML = icon("eye", { size: 13 }) + " Только чтение";
    shareBtn.hidden = editBtn.hidden = true;
    sharedStrip.classList.remove("open");
    return;
  }
  editBtn.hidden = false;
  editBtn.setAttribute("aria-pressed", String(ctx.editing));
  editBtn.innerHTML = ctx.editing ? icon("check", { size: 15 }) + " Готово" : icon("pencil", { size: 14 }) + " Правка";
  shareBtn.hidden = !t;
  shareBtn.setAttribute("aria-pressed", String(!!(t && t.shared)));
  modeBadge.hidden = true;
  sharedStrip.classList.toggle("open", !!(t && t.shared));
  sharedStrip.innerHTML = icon("eye", { size: 15 }) + " Вкладку видят игроки — только для чтения. Личные записи журнала им не показываются.";
  renderEditBar(t);
}

function renderEditBar(t) {
  editBar.textContent = "";
  editBar.hidden = !ctx.editing || !t;
  if (editBar.hidden) return;
  const name = el("input", { class: "field", value: t.title, "aria-label": "Название вкладки", maxlength: "60", style: "width:200px;height:34px;font-size:13px" });
  name.onchange = () => {
    if (!name.value.trim()) return;
    t.title = name.value.trim();
    ctx.persist();
  };
  editBar.append(el("label", { class: "label", text: "Название" }), name);
  if (t.kind === "rules" || t.kind === "notes") {
    editBar.append(
      el("span", { class: "label", text: t.kind === "rules" ? "Собирается сама из правил и состояний" : "Список закреплённых записей" }),
      el("button", { class: "ghost-btn", type: "button", html: icon("board", { size: 14 }) + " Расставлять вручную", onclick: () => toGrid(t) })
    );
  }
  if (t.kind === "grid") {
    const cols = t.columns || 3;
    const step = (d) => () => {
      t.columns = Math.min(6, Math.max(1, cols + d));
      ctx.persist();
    };
    editBar.append(
      el("span", { class: "label", text: "Колонки" }),
      el("div", { class: "stepper" }, [
        el("button", { type: "button", text: "−", "aria-label": "Меньше колонок", onclick: step(-1) }),
        el("span", { text: String(cols) }),
        el("button", { type: "button", text: "+", "aria-label": "Больше колонок", onclick: step(1) }),
      ])
    );
  }
  const i = ctx.screen.tabs.indexOf(t);
  const move = (d) => () => {
    const tabs = ctx.screen.tabs;
    [tabs[i], tabs[i + d]] = [tabs[i + d], tabs[i]];
    ctx.persist();
  };
  editBar.append(
    el("div", { style: "flex:1" }),
    el("button", { class: "icon-btn", type: "button", title: "Сдвинуть влево", disabled: i === 0, html: icon("chevron-left", { size: 15 }), onclick: move(-1) }),
    el("button", { class: "icon-btn", type: "button", title: "Сдвинуть вправо", disabled: i === ctx.screen.tabs.length - 1, html: icon("chevron-right", { size: 15 }), onclick: move(1) }),
    el("button", { class: "ghost-btn danger", type: "button", html: icon("trash", { size: 14 }) + " Удалить вкладку", onclick: () => removeTab(t) })
  );
}

async function newTab() {
  const title = await showPrompt("Название вкладки", { title: "Новая вкладка", placeholder: "Например: Бой", okLabel: "Создать" });
  if (!title || !title.trim()) return;
  const tab = { id: "t" + newCellId(), kind: "grid", title: title.trim(), columns: 3, cells: [] };
  ctx.screen.tabs.push(tab);
  currentTab = tab.id;
  ctx.persist();
}

// toGrid — готовая вкладка становится сеткой с тем же содержимым.
async function toGrid(t) {
  const lead =
    t.kind === "rules"
      ? "Вкладка станет сеткой: ячейки можно будет двигать и растягивать, но новые правила из модулей придётся добавлять самому."
      : "Вкладка станет сеткой: каждая закреплённая запись — отдельная ячейка.";
  if (!(await showConfirm(lead, { title: "Расставлять вручную", okLabel: "Превратить в сетку" }))) return;
  let cells;
  if (t.kind === "rules") {
    const refs = (await data.references()).filter(isRule).sort((a, b) => shortName(a.name).localeCompare(shortName(b.name), "ru"));
    cells = [{ kind: "conditions", w: 1, h: 4 }, ...refs.map((r) => ({ kind: "reference", ref: r.id, w: 1, h: 2 }))];
  } else {
    cells = (t.cells || []).filter((c) => c.kind === "journal").map((c) => ({ kind: "journal", ref: c.ref, w: 2, h: 3 }));
  }
  Object.assign(t, { kind: "grid", columns: 3, cells: cells.map((c) => ({ ...c, id: newCellId() })) });
  ctx.persist();
}

async function removeTab(t) {
  if (ctx.screen.tabs.length === 1) {
    showAlert("Последнюю вкладку удалить нельзя.");
    return;
  }
  const ok = await showConfirm(`Удалить вкладку «${t.title}»? Карточки и записи журнала останутся, уберётся только раскладка.`, { title: "Удалить вкладку", okLabel: "Удалить", danger: true });
  if (!ok) return;
  ctx.screen.tabs = ctx.screen.tabs.filter((x) => x !== t);
  ctx.persist();
}

shareBtn.onclick = () => {
  const t = tabById(currentTab);
  if (!t) return;
  t.shared = !t.shared;
  ctx.persist();
};

editBtn.onclick = () => {
  ctx.editing = !ctx.editing;
  render();
};

// ---- сохранение ----

// Уведомление о своём сохранении может обогнать ответ — разбираем его после.
let inflight = 0;
let recheck = false;

async function save() {
  inflight++;
  try {
    const saved = await saveScreen(ctx.screen);
    savedAt = saved.updatedAt;
    syncClock(saved);
    return saved;
  } finally {
    inflight--;
    if (!inflight && recheck) {
      recheck = false;
      setTimeout(reloadIfForeign);
    }
  }
}

// Своё сохранение не перечитываем: виджеты держат ссылки на текущие ячейки.
async function reloadIfForeign() {
  if (inflight) {
    recheck = true;
    return;
  }
  const sc = await fetchScreen().catch(() => null);
  if (!sc || sc.updatedAt === savedAt) return;
  ctx.screen = sc;
  syncClock(sc);
  render();
}

ctx.persist = async () => {
  try {
    ctx.screen = await save();
  } catch (err) {
    showAlert("Не удалось сохранить ширму: " + err.message);
    await loadScreen();
  }
  render();
};

// Счётчик и таймер правятся на месте: сохраняем без перерисовки, чтобы не сбить ввод.
let quietTimer = 0;
ctx.saveQuiet = () => {
  clearTimeout(quietTimer);
  quietTimer = setTimeout(() => save().catch((err) => showAlert("Не удалось сохранить ширму: " + err.message)), 400);
};

function render() {
  renderTabs();
  renderHeader();
  const t = tabById(currentTab);
  bodyEl.textContent = "";
  if (!t) {
    bodyEl.append(el("p", { class: "empty-state", text: ctx.gm ? "Вкладок нет." : "Ведущий пока ничего не открыл." }));
    return;
  }
  if (t.kind === "rules") renderRules();
  else if (t.kind === "notes") renderNotes(t);
  else if (t.kind === "grid") renderGrid(t, bodyEl);
}
ctx.render = render;

// ---- «Правила» ----

async function renderRules() {
  const grid = el("div", { class: "rules-grid" });
  bodyEl.append(grid);
  const [conds, refs] = await Promise.all([data.conditions(), data.references()]);
  if (!grid.isConnected) return;
  const rules = refs.filter(isRule).sort((a, b) => shortName(a.name).localeCompare(shortName(b.name), "ru"));

  if (conds.length) grid.append(el("article", { class: "cell" }, [el("div", { class: "cell-head" }, [el("h3", { text: "Состояния" })]), conditionsList(conds)]));
  for (const r of rules) {
    grid.append(el("article", { class: "cell" }, [el("div", { class: "cell-head" }, [el("h3", { text: shortName(r.name) }), openReferenceButton(r)]), ...referenceBody(r)]));
  }
  if (!rules.length || ctx.gm) {
    const add = el("article", { class: "cell add" }, [
      el("p", {
        class: "dim",
        style: "margin:0",
        text: rules.length ? "Своё правило — карточка справочника с тегом «ширма»." : "В модулях мира нет правил для ширмы. Правило — карточка справочника с тегом «ширма».",
      }),
    ]);
    if (ctx.gm) add.append(el("button", { class: "ghost-btn", type: "button", html: icon("plus", { size: 15 }) + " Добавить своё правило", onclick: addRule }));
    grid.append(add);
  }
}

async function addRule() {
  const name = await showPrompt("Название правила", { title: "Новое правило", placeholder: "Например: Отдых", okLabel: "Создать" });
  if (!name || !name.trim()) return;
  try {
    const ref = await createReference(name.trim());
    await updateReference(ref.id, { ...ref, tags: [RULE_TAG] });
    data.forget("references");
    openInHost("reference-" + ref.id, ref.name, `/referencebook.html?id=${ref.id}`);
    render();
  } catch (err) {
    showAlert("Не удалось создать правило: " + err.message);
  }
}

// ---- «Заметки» ----

async function renderNotes(tab) {
  const wrap = el("div", { class: "notes" });
  const aside = el("aside", { "aria-label": "Закреплённые записи" });
  const article = el("article");
  wrap.append(aside, article);
  bodyEl.append(wrap);

  const entries = await data.journal();
  const byId = new Map(entries.map((e) => [e.id, e]));
  const pinned = (tab.cells || []).filter((c) => c.kind === "journal" && byId.has(c.ref)).map((c) => byId.get(c.ref));
  if (!pinned.some((e) => e.id === selectedNote)) selectedNote = pinned[0] ? pinned[0].id : "";

  aside.append(el("div", { class: "dim", style: "font-size:12px;padding:0 4px 6px", text: "Закреплено из журнала" }));
  for (const e of pinned) {
    const mark = e.shared
      ? el("span", { title: "Видят все", style: "color:var(--green-bright);display:flex", html: icon("eye", { size: 13 }) })
      : el("span", { title: "Личная", class: "dim", style: "display:flex", html: icon("lock", { size: 12 }) });
    const btn = el("button", { class: "pin" + (e.id === selectedNote ? " on" : ""), type: "button" }, [el("span", { class: "t" }, [e.title || "Без названия", ctx.gm ? mark : null]), e.folder ? el("small", { text: e.folder }) : null]);
    btn.onclick = () => {
      selectedNote = e.id;
      render();
    };
    aside.append(btn);
  }
  if (!pinned.length) aside.append(el("p", { class: "dim", style: "padding:0 4px", text: ctx.gm ? "Закрепите записи журнала, которые нужны под рукой." : "Здесь пусто." }));
  if (ctx.gm) {
    aside.append(el("div", { style: "flex:1" }));
    aside.append(el("button", { class: "ghost-btn", type: "button", style: "align-self:stretch;justify-content:center", html: icon("pin", { size: 15 }) + " Закрепить запись", onclick: () => pickNote(tab, entries) }));
  }

  if (!selectedNote) return;
  const { entry, body } = await journalBody(selectedNote);
  if (!entry) {
    article.append(body);
    return;
  }
  const openBtn = el("button", { class: "ghost-btn", type: "button", text: "Открыть в журнале" });
  openBtn.onclick = () => openInHost("journal", "Журнал стола", `/journal.html?id=${entry.id}`, true);
  const head = el("div", { class: "note-head" }, [el("h1", { text: entry.title || "Без названия" }), openBtn]);
  if (ctx.gm) {
    const unpin = el("button", { class: "icon-btn", type: "button", title: "Открепить", html: icon("close", { size: 15 }) });
    unpin.onclick = () => {
      tab.cells = (tab.cells || []).filter((c) => !(c.kind === "journal" && c.ref === entry.id));
      ctx.persist();
    };
    head.append(unpin);
  }
  article.append(head, body);
}

function pickNote(tab, entries) {
  const pinned = new Set((tab.cells || []).map((c) => c.ref));
  let chosen = "";
  openModal({
    title: "Закрепить запись",
    okLabel: "Закрепить",
    cancelLabel: "Отмена",
    buildBody: (body, submit) => {
      const search = el("input", { class: "bt-modal-input", type: "search", placeholder: "Поиск по названию или папке", "aria-label": "Поиск" });
      const list = el("div", { style: "display:flex;flex-direction:column;gap:2px;max-height:320px;overflow-y:auto;margin-top:8px" });
      const draw = () => {
        const q = search.value.trim().toLowerCase();
        list.textContent = "";
        for (const e of entries) {
          if (pinned.has(e.id)) continue;
          if (q && !`${e.title} ${e.folder || ""}`.toLowerCase().includes(q)) continue;
          const row = el("button", { class: "pin" + (e.id === chosen ? " on" : ""), type: "button" }, [el("span", { class: "t", text: e.title || "Без названия" }), e.folder ? el("small", { text: e.folder }) : null]);
          row.onclick = () => {
            chosen = e.id;
            for (const r of list.querySelectorAll(".pin.on")) r.classList.remove("on");
            row.classList.add("on");
          };
          row.ondblclick = () => {
            chosen = e.id;
            submit();
          };
          list.append(row);
        }
        if (!list.children.length) list.append(el("p", { class: "dim", text: "Ничего не найдено." }));
      };
      search.oninput = draw;
      draw();
      body.append(search, list);
      return search;
    },
    onOk: () => chosen,
    onCancel: () => "",
  }).then((id) => {
    if (!id) return;
    tab.cells = [...(tab.cells || []), { kind: "journal", ref: id }];
    selectedNote = id;
    ctx.persist();
  });
}

// ---- загрузка и живые обновления ----

// shows — на открытой вкладке есть такое содержимое: иначе не перерисовываем и не сбиваем ввод.
function shows(tabKind, ...cellKinds) {
  const t = tabById(currentTab);
  return !!t && (t.kind === tabKind || (t.cells || []).some((c) => cellKinds.includes(c.kind)));
}

async function loadScreen() {
  const sc = await fetchScreen();
  ctx.screen = sc && Array.isArray(sc.tabs) ? sc : { tabs: [] };
  syncClock(ctx.screen);
}

function syncClock(sc) {
  if (sc && sc.serverNow) ctx.clock = sc.serverNow - Date.now();
}

(async function boot() {
  const me = await fetchMe();
  if (!me) {
    location.href = "/";
    return;
  }
  ctx.gm = isGM(me.role);
  loadSystemProfile();
  await loadScreen();
  render();

  ctx.socket = openSocket(ctx.gm ? "/ws/dm" : "/ws/player", {
    onAuthFailed: () => document.getElementById("authFailedOverlay").classList.add("open"),
    onMessage: async (msg) => {
      if (msg.type === "roll_result") onRoll(msg);
      else if (msg.type === "journal_changed") {
        data.forget("journal");
        if (shows("notes", "journal")) render();
      } else if (msg.type === "library_changed" && msg.kind === "screen") {
        reloadIfForeign();
      } else if (msg.type === "library_changed" && msg.kind === "compendium") {
        data.forget("references", "conditions");
        if (shows("rules", "reference", "conditions")) render();
      }
    },
  });
})();
