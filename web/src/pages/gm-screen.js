// gm-screen.js — ширма ведущего в плавающем окне. Игрок видит только открытые
// ему вкладки, только для чтения.
import {
  fetchMe,
  fetchScreen,
  saveScreen,
  fetchConditions,
  fetchReferences,
  fetchJournal,
  fetchJournalEntry,
  createReference,
  updateReference,
} from "../api.js";
import { openSocket } from "../ws-reconnect.js";
import { isGM } from "../roles.js";
import { icon } from "../icons.js";
import { renderNoteHtml } from "../notes/markdown.js";
import { enhanceRolls } from "../inline-rolls.js";
import { glyphNode } from "../condition-glyphs.js";
import { loadSystemProfile, moduleTitle, moduleAttribution } from "../system-profile.js";
import { openModal, showPrompt, showAlert } from "../modal.js";
import { withRollMode } from "../roll-mode.js";

// Правило для ширмы — карточка справочника с этим тегом.
const RULE_TAG = "ширма";

const tabsEl = document.getElementById("tabs");
const bodyEl = document.getElementById("body");
const shareBtn = document.getElementById("shareBtn");
const modeBadge = document.getElementById("modeBadge");
const sharedStrip = document.getElementById("sharedStrip");

let gm = false;
let screen = { tabs: [] };
let currentTab = new URLSearchParams(location.search).get("tab") || "";
let socket = null;
let selectedNote = "";
const hiddenRolls = [];
let rollLabel = "";
let rollsEl = null;

const el = (tag, attrs = {}, kids = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n[k] = v;
    else n.setAttribute(k, v);
  }
  for (const kid of [].concat(kids)) if (kid) n.append(kid);
  return n;
};

const hostWindow = () => (window.opener && window.opener !== window ? window.opener : window.parent);

function openInHost(key, title, url, navigate = false) {
  hostWindow().postMessage({ type: "beacon:openFloatingWindow", key, title, url, navigate }, location.origin);
}

function sendRoll(formula, label, hidden) {
  if (!socket) return;
  const msg = { type: "roll_dice", formula, label };
  socket.send(hidden ? { ...msg, hidden: true } : withRollMode(msg));
}

// ---- вкладки ----

function tabById(id) {
  return screen.tabs.find((t) => t.id === id);
}

function renderTabs() {
  tabsEl.textContent = "";
  if (!tabById(currentTab)) currentTab = screen.tabs[0] ? screen.tabs[0].id : "";
  for (const t of screen.tabs) {
    const btn = el("button", { class: "tab" + (t.id === currentTab ? " on" : ""), role: "tab", "aria-selected": String(t.id === currentTab), type: "button" });
    if (gm && t.shared) btn.append(el("span", { class: "shared-eye", title: "Видят игроки", html: icon("eye", { size: 14 }) }));
    btn.append(t.title);
    btn.onclick = () => {
      currentTab = t.id;
      render();
    };
    tabsEl.append(btn);
  }
}

function renderHeader() {
  const t = tabById(currentTab);
  if (!gm) {
    modeBadge.hidden = false;
    modeBadge.innerHTML = icon("eye", { size: 13 }) + " Только чтение";
    shareBtn.hidden = true;
    sharedStrip.classList.remove("open");
    return;
  }
  const shareable = t && t.kind !== "tools";
  shareBtn.hidden = !shareable;
  shareBtn.setAttribute("aria-pressed", String(!!(t && t.shared)));
  modeBadge.hidden = shareable;
  modeBadge.innerHTML = icon("lock", { size: 12 }) + " Только ведущий";
  sharedStrip.classList.toggle("open", !!(t && t.shared));
  sharedStrip.innerHTML =
    icon("eye", { size: 15 }) + " Вкладку видят игроки — только для чтения. Личные записи журнала им не показываются.";
}

shareBtn.onclick = async () => {
  const t = tabById(currentTab);
  if (!t) return;
  t.shared = !t.shared;
  await persist();
};

async function persist() {
  try {
    screen = await saveScreen(screen);
  } catch (err) {
    showAlert("Не удалось сохранить ширму: " + err.message);
    await loadScreen();
  }
  render();
}

function render() {
  renderTabs();
  renderHeader();
  const t = tabById(currentTab);
  bodyEl.textContent = "";
  if (!t) {
    bodyEl.append(el("p", { class: "empty-state", text: gm ? "Вкладок нет." : "Ведущий пока ничего не открыл." }));
    return;
  }
  if (t.kind === "rules") renderRules();
  else if (t.kind === "notes") renderNotes(t);
  else if (t.kind === "tools") renderTools();
}

// ---- «Правила» ----

let rulesCache = null;

async function loadRules() {
  const [conds, refs] = await Promise.all([fetchConditions().catch(() => []), fetchReferences().catch(() => [])]);
  const rules = (refs || []).filter((r) => (r.tags || []).some((tag) => tag.trim().toLowerCase() === RULE_TAG));
  rules.sort((a, b) => shortName(a.name).localeCompare(shortName(b.name), "ru"));
  conds.sort((a, b) => a.name.localeCompare(b.name, "ru"));
  rulesCache = { conds, rules };
  return rulesCache;
}

// Английское название в скобках, как в карточках модулей, на ширме лишнее.
const shortName = (name) => name.replace(/\s*\[[^\]]*\]\s*$/, "");

function sourceLine(card) {
  if (!card.system) return el("div", { class: "attribution", text: "Библиотека мира" });
  const attribution = moduleAttribution(card.module);
  return el("div", { class: "attribution", text: moduleTitle(card.module), title: attribution ? "Источник: " + attribution : "" });
}

async function renderRules() {
  const grid = el("div", { class: "rules-grid" });
  bodyEl.append(grid);
  const { conds, rules } = rulesCache || (await loadRules());
  if (tabById(currentTab)?.kind !== "rules") return;

  if (conds.length) {
    const list = el("div");
    for (const c of conds) {
      const effect = (c.mechanics || c.description || "").replace(/[#*_>`[\]]/g, "").split(/\n|(?<=\.)\s/)[0];
      const row = el("button", { class: "cond-row", type: "button", title: c.name });
      const glyph = glyphNode(c.icon, c.name);
      glyph.style.color = c.color || "";
      row.append(glyph, el("b", { text: c.name }), el("span", { class: "dim", text: effect }));
      row.onclick = () => openInHost("condition-" + c.id, c.name, `/conditions.html?id=${c.id}`);
      list.append(row);
    }
    grid.append(el("article", { class: "cell" }, [el("div", { class: "cell-head" }, [el("h3", { text: "Состояния" })]), list]));
  }

  for (const r of rules) {
    const body = el("div", { class: "note-render", html: renderNoteHtml(r.description || "") });
    enhanceRolls(body, (formula, label) => sendRoll(formula, `${r.name} — ${label}`));
    const open = el("button", { class: "icon-btn", type: "button", title: "Открыть в справочнике", html: icon("external-link", { size: 14 }) });
    open.onclick = () => openInHost("reference-" + r.id, r.name, `/referencebook.html?id=${r.id}`);
    grid.append(el("article", { class: "cell" }, [el("div", { class: "cell-head" }, [el("h3", { text: shortName(r.name) }), open]), body, sourceLine(r)]));
  }

  if (!rules.length || gm) {
    const add = el("article", { class: "cell add" }, [
      el("p", {
        class: "dim",
        style: "margin:0",
        text: rules.length
          ? "Своё правило — карточка справочника с тегом «ширма»."
          : "В модулях мира нет правил для ширмы. Правило — карточка справочника с тегом «ширма».",
      }),
    ]);
    if (gm) {
      const btn = el("button", { class: "ghost-btn", type: "button", html: icon("plus", { size: 15 }) + " Добавить своё правило" });
      btn.onclick = addRule;
      add.append(btn);
    }
    grid.append(add);
  }
}

async function addRule() {
  const name = await showPrompt("Название правила", { title: "Новое правило", placeholder: "Например: Отдых", okLabel: "Создать" });
  if (!name || !name.trim()) return;
  try {
    const ref = await createReference(name.trim());
    await updateReference(ref.id, { ...ref, tags: [RULE_TAG] });
    rulesCache = null;
    openInHost("reference-" + ref.id, ref.name, `/referencebook.html?id=${ref.id}`);
    render();
  } catch (err) {
    showAlert("Не удалось создать правило: " + err.message);
  }
}

// ---- «Заметки» ----

let journalCache = null;

async function journalList() {
  if (!journalCache) journalCache = await fetchJournal().catch(() => []);
  return journalCache;
}

async function renderNotes(tab) {
  const wrap = el("div", { class: "notes" });
  const aside = el("aside", { "aria-label": "Закреплённые записи" });
  const article = el("article");
  wrap.append(aside, article);
  bodyEl.append(wrap);

  const entries = await journalList();
  const byId = new Map(entries.map((e) => [e.id, e]));
  const pinned = (tab.cells || []).filter((c) => c.kind === "journal" && byId.has(c.ref)).map((c) => byId.get(c.ref));
  if (!pinned.some((e) => e.id === selectedNote)) selectedNote = pinned[0] ? pinned[0].id : "";

  aside.append(el("div", { class: "dim", style: "font-size:12px;padding:0 4px 6px", text: "Закреплено из журнала" }));
  for (const e of pinned) {
    const mark = e.shared ? el("span", { title: "Видят все", style: "color:var(--green-bright);display:flex", html: icon("eye", { size: 13 }) }) : el("span", { title: "Личная", class: "dim", style: "display:flex", html: icon("lock", { size: 12 }) });
    const btn = el("button", { class: "pin" + (e.id === selectedNote ? " on" : ""), type: "button" }, [
      el("span", { class: "t" }, [e.title || "Без названия", gm ? mark : null]),
      e.folder ? el("small", { text: e.folder }) : null,
    ]);
    btn.onclick = () => {
      selectedNote = e.id;
      render();
    };
    aside.append(btn);
  }
  if (!pinned.length) aside.append(el("p", { class: "dim", style: "padding:0 4px", text: gm ? "Закрепите записи журнала, которые нужны под рукой." : "Здесь пусто." }));
  if (gm) {
    aside.append(el("div", { style: "flex:1" }));
    const pinBtn = el("button", { class: "ghost-btn", type: "button", style: "align-self:stretch;justify-content:center", html: icon("pin", { size: 15 }) + " Закрепить запись" });
    pinBtn.onclick = () => pickNote(tab, entries);
    aside.append(pinBtn);
  }

  if (!selectedNote) return;
  let entry;
  try {
    entry = await fetchJournalEntry(selectedNote);
  } catch {
    article.append(el("p", { class: "dim", text: "Запись недоступна." }));
    return;
  }
  const openBtn = el("button", { class: "ghost-btn", type: "button", text: "Открыть в журнале" });
  openBtn.onclick = () => openInHost("journal", "Журнал стола", `/journal.html?id=${entry.id}`, true);
  const head = el("div", { class: "note-head" }, [el("h1", { text: entry.title || "Без названия" }), openBtn]);
  if (gm) {
    const unpin = el("button", { class: "icon-btn", type: "button", title: "Открепить", html: icon("close", { size: 15 }) });
    unpin.onclick = async () => {
      tab.cells = (tab.cells || []).filter((c) => !(c.kind === "journal" && c.ref === entry.id));
      await persist();
    };
    head.append(unpin);
  }
  // Заголовок уже в шапке — первый # из текста не дублируем.
  const md = (entry.content || "").replace(/^\s*#\s+[^\n]*\n?/, "");
  const body = el("div", { class: "note-render", html: renderNoteHtml(md) });
  enhanceRolls(body, (formula, label) => sendRoll(formula, `${entry.title} — ${label}`));
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
  }).then(async (id) => {
    if (!id) return;
    tab.cells = [...(tab.cells || []), { kind: "journal", ref: id }];
    selectedNote = id;
    await persist();
  });
}

// ---- «Инструменты» ----

function renderTools() {
  const grid = el("div", { class: "tools-grid" });
  const formula = el("input", { class: "field", id: "hiddenFormula", value: localStorage.getItem("beacon:screenFormula") || "1d20", autocomplete: "off" });
  const label = el("input", { class: "field", id: "hiddenLabel", placeholder: "Например: Скрытность гоблинов", autocomplete: "off", style: "font-size:13px" });
  label.value = rollLabel;
  label.oninput = () => (rollLabel = label.value);
  const roll = () => {
    const f = formula.value.trim();
    if (!f) return;
    try {
      localStorage.setItem("beacon:screenFormula", f);
    } catch {
      /* приватный режим */
    }
    sendRoll(f, label.value.trim() || "Скрытый бросок", true);
  };
  formula.onkeydown = (e) => e.key === "Enter" && roll();
  label.onkeydown = (e) => e.key === "Enter" && roll();
  const quick = el("div", { class: "quick" });
  for (const f of ["1d20", "2d6", "1d100", "1d6", "1d4"]) {
    const b = el("button", { type: "button", text: f });
    b.onclick = () => {
      formula.value = f;
      roll();
    };
    quick.append(b);
  }
  const btn = el("button", { class: "primary", type: "button", html: icon("dice", { size: 17 }) + " Бросить скрытно" });
  btn.onclick = roll;

  rollsEl = el("div", { style: "display:flex;flex-direction:column;gap:8px" });
  renderRolls();

  grid.append(
    el("article", { class: "cell" }, [
      el("div", { class: "cell-head" }, [el("h3", { text: "Скрытый бросок" })]),
      el("label", { class: "label", for: "hiddenFormula", text: "Формула" }),
      formula,
      quick,
      el("label", { class: "label", for: "hiddenLabel", text: "Что бросаем" }),
      label,
      btn,
      rollsEl,
    ])
  );
  bodyEl.append(grid);
}

function renderRolls() {
  if (!rollsEl) return;
  rollsEl.textContent = "";
  const last = hiddenRolls[0];
  const result = last
    ? el("div", { class: "roll-result" }, [
        el("div", { class: "total", text: String(last.total) }),
        el("div", {}, [
          el("div", { text: `${last.label || last.formula}` }),
          el("div", { class: "dim", style: "font-size:12px", text: `${last.formula} · ${(last.rolls || []).join(", ")}${last.modifier ? ` ${last.modifier > 0 ? "+" : "−"} ${Math.abs(last.modifier)}` : ""}` }),
        ]),
      ])
    : el("p", { class: "dim", style: "margin:0", text: "Результат увидите только вы, на трансляцию кубы не уходят." });

  const recent = el("div");
  for (const r of hiddenRolls.slice(1, 8)) {
    recent.append(el("div", { class: "roll-row" }, [el("span", { style: "flex:1", text: r.label || "Бросок" }), el("span", { class: "dim", text: r.formula }), el("b", { text: String(r.total) })]));
  }

  rollsEl.append(result);
  if (hiddenRolls.length > 1) rollsEl.append(el("div", { class: "label", text: "Недавние" }), recent);
}

function onRoll(data) {
  if (!gm || !data.hidden || data.fromRole !== "dm") return;
  hiddenRolls.unshift(data);
  hiddenRolls.length = Math.min(hiddenRolls.length, 20);
  if (rollsEl && rollsEl.isConnected) renderRolls();
}

// ---- загрузка и живые обновления ----

async function loadScreen() {
  screen = await fetchScreen();
  if (!screen || !Array.isArray(screen.tabs)) screen = { tabs: [] };
}

(async function boot() {
  const me = await fetchMe();
  if (!me) {
    location.href = "/";
    return;
  }
  gm = isGM(me.role);
  loadSystemProfile();
  await loadScreen();
  render();

  socket = openSocket(gm ? "/ws/dm" : "/ws/player", {
    onAuthFailed: () => document.getElementById("authFailedOverlay").classList.add("open"),
    onMessage: async (data) => {
      if (data.type === "roll_result") onRoll(data);
      else if (data.type === "journal_changed") {
        journalCache = null;
        if (tabById(currentTab)?.kind === "notes") render();
      } else if (data.type === "library_changed" && data.kind === "screen") {
        await loadScreen();
        render();
      } else if (data.type === "library_changed" && data.kind === "compendium") {
        rulesCache = null;
        if (tabById(currentTab)?.kind === "rules") render();
      }
    },
  });
})();
