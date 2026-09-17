// Карточка библиотеки заклинаний — отдельное окно, открывается из
// dm.html/player.html (панель/модалка "Заклинания"), по аналогии с
// bestiary.js/character-sheet.js (тот же приём: плавающее окно =
// floating-window.js, тот же h()/textInput/... DOM-конструктор).
//
// "Умный бланк" — сервер (internal/domain/spell.go) не знает правил D&D,
// только хранит присланный JSON. Единственная нетривиальная часть здесь —
// блок импорта: разбор экспорта заклинания с ttg.club целиком в
// web/src/spell-import.js (чистая функция, без побочных эффектов), этот файл
// только вызывает её и мержит результат в текущую карточку.
import { fetchMe, fetchSpell, createSpell, updateSpell, deleteSpell, fetchConditions } from "../api.js";
import { mergeInPlace } from "../merge-in-place.js";
import { openSocket } from "../ws-reconnect.js";
import { icon } from "../icons.js";
import { renderNoteHtml } from "../notes/markdown.js";
import { mapFoundrySpellJson } from "../spell-import.js";
import { enhanceRolls } from "../inline-rolls.js";
import { wireCatalogLinks } from "../catalog-links.js";
import { showAlert, showConfirm } from "../modal.js";
import { createRollLog } from "../roll-log.js";
import { isGM } from "../roles.js";
import { initFullscreenButton } from "../fullscreen.js";
import { el as hh, labeled, pill, ornament, renderHero, fold, renderBody } from "../card-shell.js";
import { renderKvTable } from "../kv-table.js";
import { renderSpellPreview } from "../spell-preview.js";
import { glyphNode } from "../condition-glyphs.js";
import { SCHOOLS, schoolInfo } from "../spell-school.js";

const LEVEL_OPTIONS = [
  { value: 0, label: "Заговор" },
  { value: 1, label: "1-й круг" },
  { value: 2, label: "2-й круг" },
  { value: 3, label: "3-й круг" },
  { value: 4, label: "4-й круг" },
  { value: 5, label: "5-й круг" },
  { value: 6, label: "6-й круг" },
  { value: 7, label: "7-й круг" },
  { value: 8, label: "8-й круг" },
  { value: 9, label: "9-й круг" },
];

// ==================== state ====================

let spellId = null;
let spell = null; // объект domain.Spell целиком (сервер отдаёт camelCase — см. json-теги)
let rollWS = null;
let rollLog = null; // общий виджет лога бросков (см. web/src/roll-log.js)
let allConditions = []; // справочник состояний мира — только для выпадашки «Накладывает» (см. statusesField)
let isAdminView = false; // роль текущего аккаунта (см. boot()) — определяет /ws/dm или /ws/player
// editMode — по умолчанию карточка открывается в чистом read-режиме, как
// domain.Monster (см. bestiary.js) — тот же приём и там же обоснование.
let editMode = false;

function normalizeSpell(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  s.tags = Array.isArray(s.tags) ? s.tags : [];
  s.statuses = Array.isArray(s.statuses) ? s.statuses : [];
  s.level = Number.isFinite(s.level) ? s.level : 0;
  return s;
}

// ==================== DOM helpers ====================

const h = hh;

function textInput(get, set, opts) {
  const inp = h("input", Object.assign({ type: "text" }, opts || {}));
  inp.value = get() ?? "";
  inp.addEventListener("input", () => {
    set(inp.value);
    scheduleSave();
  });
  return inp;
}

// ATTACK_OPTIONS — вид броска атаки (см. domain.Spell.Attack): код и подпись.
const ATTACK_OPTIONS = [
  { value: "", label: "нет (спасбросок или без броска)" },
  { value: "melee", label: "рукопашная" },
  { value: "ranged", label: "дистанционная" },
];

function attackLabel(value) {
  const opt = ATTACK_OPTIONS.find((o) => o.value === value);
  return value && opt ? opt.label : "";
}

// mdBlock — textarea markdown/HTML + живой рендер (тот же `marked`, что и
// заметки ДМ, см. web/src/notes/markdown.js). Импортированное описание
// приходит HTML-ом — marked пропускает его как есть.
function mdBlock(labelText, get, set) {
  const render = h("div", { class: "md-render" });
  render.innerHTML = renderNoteHtml(get());
  const t = h("textarea", { "aria-label": labelText });
  t.value = get() ?? "";
  t.addEventListener("input", () => {
    set(t.value);
    render.innerHTML = renderNoteHtml(t.value);
    scheduleSave();
  });
  return h("div", { class: "md-block" }, [t, render]);
}

// levelPhrase — книжная форма для подзаголовка: «заговор» / «2-го круга».
function levelPhrase(lvl) {
  return lvl === 0 ? "заговор" : lvl + "-го круга";
}

// componentsText — "В, С, М (материалы)" из трёх флагов и текста материалов.
function componentsText(s) {
  const parts = [];
  if (s.verbal) parts.push("В");
  if (s.somatic) parts.push("С");
  if (s.material) parts.push("М" + (s.materialNote ? ` (${s.materialNote})` : ""));
  return parts.join(", ");
}

const spellGlyph = () => glyphNode((schoolInfo(spell.school) || { glyph: "sparkle" }).glyph, "");
const spellColor = () => (schoolInfo(spell.school) || {}).color || "";

function heroPills() {
  return [spell.concentration ? pill("концентрация", "att") : null, spell.ritual ? pill("ритуал") : null, spell.source ? pill(spell.source, "gold") : null, ...spell.tags.map((t) => pill(t))];
}

// kvRows — строки таблицы «показатель · значение» (kv-table.js).
function kvRows(onChange) {
  const set = (k) => (v) => {
    spell[k] = v;
    onChange && onChange();
  };
  return [
    { label: "Время накладывания", get: () => spell.castTime, set: set("castTime"), placeholder: "1 действие" },
    { label: "Дистанция", get: () => spell.range, set: set("range"), placeholder: "120 фт." },
    { label: "Компоненты", get: () => componentsText(spell), custom: () => componentsEditor(onChange) },
    { label: "Длительность", get: () => spell.duration, set: set("duration"), placeholder: "мгновенная" },
    { label: "Атака заклинанием", get: () => attackLabel(spell.attack), custom: () => attackSelect(onChange) },
    { label: "Спасбросок", get: () => spell.savingThrow, set: set("savingThrow"), placeholder: "Телосложение" },
    { label: "Урон", get: () => spell.damage, set: set("damage"), placeholder: "8к6 огнём", mono: true },
    { label: "За круг ячейки выше", get: () => spell.upcast, set: set("upcast"), placeholder: "1к6", mono: true },
    { label: "Классы", get: () => spell.classes, set: set("classes"), placeholder: "волшебник, чародей" },
  ];
}

// componentsEditor — В · С · М кнопками плюс материал; в чтении вместо него
// строка componentsText.
function componentsEditor(onChange) {
  const btns = h("div", { class: "comp", role: "group", "aria-label": "Компоненты" });
  for (const [key, label, title] of [["verbal", "В", "вербальный"], ["somatic", "С", "соматический"], ["material", "М", "материальный"]]) {
    const b = h("button", { type: "button", text: label, title, "aria-pressed": String(!!spell[key]) });
    b.addEventListener("click", () => {
      spell[key] = !spell[key];
      b.setAttribute("aria-pressed", String(spell[key]));
      scheduleSave();
      onChange && onChange();
    });
    btns.appendChild(b);
  }
  const note = textInput(() => spell.materialNote, (v) => { spell.materialNote = v; onChange && onChange(); }, { placeholder: "материал: жемчужина не дешевле 100 зм", "aria-label": "Материальные компоненты" });
  return h("div", { class: "comp-row" }, [btns, note]);
}

function attackSelect(onChange) {
  const sel = h("select", { "aria-label": "Атака заклинанием" }, ATTACK_OPTIONS.map((o) => h("option", { value: o.value, text: o.label })));
  sel.value = String(spell.attack || "");
  sel.addEventListener("change", () => {
    spell.attack = sel.value;
    scheduleSave();
    onChange && onChange();
  });
  return sel;
}

// ==================== рендер ====================

// renderApp — диспетчер: read-режим (по умолчанию, см. editMode) или полная
// форма редактирования (та же схема, что bestiary.js).
function renderApp() {
  const root = document.getElementById("app");
  root.innerHTML = "";
  if (editMode) renderEditView(root);
  else renderReadView(root);
}

function renderEditView(root) {
  const lvlSel = h("select", { class: "mono", "aria-label": "Круг" }, LEVEL_OPTIONS.map((o) => h("option", { value: o.value, text: o.value === 0 ? "заговор" : o.value + "-й круг" })));
  lvlSel.value = String(spell.level);
  lvlSel.addEventListener("change", () => {
    spell.level = parseInt(lvlSel.value, 10);
    scheduleSave();
  });
  const schSel = h("select", { "aria-label": "Школа" });
  schSel.appendChild(h("option", { value: "", text: "— школа —" }));
  for (const sc of SCHOOLS) schSel.appendChild(h("option", { value: sc.ru, text: sc.ru }));
  if (spell.school && !schoolInfo(spell.school)) schSel.appendChild(h("option", { value: spell.school, text: spell.school }));
  schSel.value = spell.school || "";
  schSel.addEventListener("change", () => {
    spell.school = schSel.value;
    scheduleSave();
    hero.setGlyph(spellGlyph(), "");
    hero.setColor(spellColor());
  });
  const subtitle = h("div", { class: "card-sub" }, [schSel, h("span", { text: " " }), lvlSel]);

  const flag = (key, label) => {
    const cb = h("input", { type: "checkbox" });
    cb.checked = !!spell[key];
    cb.addEventListener("change", () => {
      spell[key] = cb.checked;
      scheduleSave();
      hero.setPills(heroPills());
      preview.update();
    });
    return h("label", { class: "card-toggle" }, [cb, label]);
  };

  const hero = renderHero({
    glyph: spellGlyph(),
    color: spellColor(),
    name: spell.name,
    namePlaceholder: "Название заклинания",
    pills: heroPills(),
    subtitle,
    controls: [h("div", { class: "field" }, [h("span", { text: "Свойства" }), h("div", { style: "display:flex;gap:14px;min-height:36px;align-items:center;flex-wrap:wrap" }, [flag("concentration", "концентрация"), flag("ritual", "ритуал")])])],
    onName: (v) => {
      spell.name = v;
      document.getElementById("spellTitle").textContent = v || "Без имени";
      scheduleSave();
    },
  });
  root.appendChild(hero.el);
  root.appendChild(ornament());

  const preview = renderSpellPreview(spell, { sendRoll, attackLabel, conditions: allConditions, canApply: false });
  const kv = renderKvTable(kvRows(() => preview.update()), { onChange: scheduleSave, hint: "Формулы урона кликабельны в чтении. Пустые строки в чтении скрываются." });
  const statuses = h("div", { class: "card-worn-h" }, [h("span", { class: "card-lbl", text: "Накладывает состояния" }), statusesField(() => preview.update())]);

  const descFold = fold({ title: "Описание", summary: spell.description || "текст заклинания", body: [mdBlock("Описание", () => spell.description, (v) => { spell.description = v; descFold.setSummary(v || "текст заклинания"); })], open: true });
  const compatSummary = () => [spell.source, spell.foundryModuleId].filter(Boolean).join(" · ") || "источник, теги, модуль Foundry";
  const compatFold = fold({
    title: "Совместимость и источник",
    summary: compatSummary(),
    body: [
      h("div", { class: "card-grid2" }, [
        labeled("Источник", textInput(() => spell.source, (v) => { spell.source = v; hero.setPills(heroPills()); compatFold.setSummary(compatSummary()); }, { placeholder: "PHB'24" })),
        labeled("Модуль Foundry", textInput(() => spell.foundryModuleId, (v) => { spell.foundryModuleId = v; compatFold.setSummary(compatSummary()); }, { placeholder: "dnd5e.spells" }), "Откуда импортировано — чтобы повторный импорт нашёл карточку."),
      ]),
      tagsField(() => hero.setPills(heroPills())),
    ],
  });

  root.appendChild(renderBody([kv, statuses, h("div", { class: "card-folds" }, [descFold, compatFold, importSection()])], [preview]));
}

// ==================== read-режим (по умолчанию) ====================

function renderReadView(root) {
  const subtitle = h("div", { class: "card-sub", text: [spell.school, levelPhrase(spell.level)].filter(Boolean).join(" ") + (spell.ritual ? " (ритуал)" : "") });
  const hero = renderHero({ glyph: spellGlyph(), color: spellColor(), name: spell.name, pills: heroPills(), subtitle, readOnly: true });
  root.appendChild(hero.el);
  root.appendChild(ornament());

  // Чип состояния кликабелен только у ДМ внутри окна стола: карточка живёт
  // в iframe и WS-команды слать не может — просит топ-документ (см.
  // spell-preview.js). Игроку сервер наложить метку всё равно не даст.
  const preview = renderSpellPreview(spell, { sendRoll, attackLabel, conditions: allConditions, canApply: isAdminView && window.parent !== window });
  const kv = renderKvTable(kvRows(), { readOnly: true, sendRoll });

  const folds = [];
  const desc = spell.description && spell.description.trim();
  if (desc) {
    const body = h("div", { class: "card-prose" });
    body.innerHTML = renderNoteHtml(spell.description);
    enhanceRolls(body, sendRoll);
    wireCatalogLinks(body);
    folds.push(fold({ title: "Описание", body: [body], open: true }));
  }
  const compat = [spell.source, spell.foundryModuleId].filter(Boolean).join(" · ");
  if (compat) folds.push(fold({ title: "Совместимость и источник", summary: compat, body: [h("p", { class: "card-text", text: compat })] }));

  root.appendChild(renderBody([kv, folds.length ? h("div", { class: "card-folds" }, folds) : null], [preview]));
}

function statusesField(onChange) {
  const list = h("div", { class: "card-chips", style: "margin-top:8px" });
  const select = h("select", { "aria-label": "Добавить состояние" });

  function renderList() {
    list.innerHTML = "";
    spell.statuses.forEach((ref, i) => {
      const roundsInp = h("input", { type: "number", min: "0", class: "num", value: ref.rounds || 0, title: "Раундов, 0 — по описанию заклинания", "aria-label": "Раундов" });
      roundsInp.addEventListener("input", () => {
        const v = parseInt(roundsInp.value, 10);
        ref.rounds = Number.isNaN(v) ? 0 : v;
        scheduleSave();
        onChange();
      });
      const noteInp = h("input", { type: "text", class: "note", value: ref.note || "", placeholder: "при провале спасброска", "aria-label": "Подпись" });
      noteInp.addEventListener("input", () => {
        ref.note = noteInp.value;
        scheduleSave();
        onChange();
      });
      const cond = allConditions.find((c) => c.slug === ref.slug);
      list.appendChild(
        h("span", { class: "sc-chip" }, [
          h("span", { class: "spp-chip-g", style: cond && cond.color ? "color:" + cond.color : "" }, [glyphNode(cond ? cond.icon : "question", "")]),
          ref.name || ref.slug,
          roundsInp,
          noteInp,
          h("button", { type: "button", html: icon("close", { size: 11 }), "aria-label": "Убрать состояние", onclick: () => { spell.statuses.splice(i, 1); scheduleSave(); renderList(); onChange(); } }),
        ])
      );
    });
    select.innerHTML = "";
    select.appendChild(h("option", { value: "", text: "+ добавить состояние…" }));
    for (const c of allConditions) {
      if (!c.slug || spell.statuses.some((s) => s.slug === c.slug)) continue;
      select.appendChild(h("option", { value: c.slug, text: c.name }));
    }
    select.style.width = "auto";
    list.appendChild(select);
  }
  select.addEventListener("change", () => {
    const slug = select.value;
    if (!slug || spell.statuses.some((s) => s.slug === slug)) return;
    const cond = allConditions.find((c) => c.slug === slug);
    spell.statuses.push({ slug, name: cond ? cond.name : slug, rounds: (cond && cond.defaultRounds) || 0, note: "" });
    scheduleSave();
    renderList();
    onChange();
  });
  renderList();
  return h("div", {}, [list, h("p", { class: "card-note", text: "Заполняется и импортом из Foundry (effects[] заклинания). Метку всё равно вешает ДМ — сервер спасброски не кидает." })]);
}

function tagsField(onChange) {
  const list = h("div", { class: "card-chips" });
  function renderTags() {
    list.innerHTML = "";
    spell.tags.forEach((tag, i) => {
      list.appendChild(h("span", { class: "card-chip" }, [tag, h("button", { type: "button", html: icon("close", { size: 11 }), "aria-label": "Убрать тег", onclick: () => { spell.tags.splice(i, 1); scheduleSave(); renderTags(); onChange(); } })]));
    });
  }
  renderTags();
  const input = h("input", { type: "text", placeholder: "тег + Enter" });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const v = input.value.trim();
    if (!v) return;
    spell.tags.push(v);
    input.value = "";
    scheduleSave();
    renderTags();
    onChange();
  });
  return h("div", {}, [labeled("Теги", input), list]);
}

// applyImport — общая точка для файла и вставленного текста: парсит JSON,
// мапит через mapFoundrySpellJson, мержит результат в spell (кроме имени —
// его тоже обновляем, но заголовок окна не трогаем задним числом умышленно
// не нужен: renderApp() перерисует всё, включая шапку).
function applyImport(rawText, msgEl) {
  msgEl.classList.remove("error", "ok");
  msgEl.textContent = "";
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    msgEl.textContent = "Не удалось разобрать JSON — проверь, что это файл экспорта заклинания.";
    msgEl.classList.add("error");
    return;
  }
  let mapped;
  try {
    mapped = mapFoundrySpellJson(parsed);
  } catch (err) {
    msgEl.textContent = err.message;
    msgEl.classList.add("error");
    return;
  }
  Object.assign(spell, mapped);
  msgEl.textContent = `Импортировано: «${mapped.name}».`;
  msgEl.classList.add("ok");
  scheduleSave();
  renderApp();
}

function importSection() {
  const msg = h("div", { id: "importMsg" });
  const fileInput = h("input", { type: "file", accept: "application/json,.json" });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) return;
    applyImport(await file.text(), msg);
    fileInput.value = "";
  });
  const textarea = h("textarea", { id: "importTextarea", placeholder: "...или вставь сюда содержимое JSON-файла" });
  const importBtn = h("button", { type: "button", id: "importBtn", text: "Импортировать вставленный JSON", onclick: () => applyImport(textarea.value, msg) });
  return fold({
    title: "Импорт из TTG Club / Foundry VTT",
    summary: "JSON-экспорт заклинания",
    body: [
      h("p", { class: "card-note" }, "На странице заклинания на 5e14.ttg.club нажми «Экспортировать в FvTT» и сохрани JSON-файл — выбери его ниже (или вставь содержимое текстом). Поля карточки заменятся тем, что удастся разобрать из файла."),
      labeled("Файл экспорта", fileInput),
      textarea,
      importBtn,
      msg,
    ],
  });
}

// ==================== autosave ====================

let saveTimer = null;
let dirty = false;
const saveStatusEl = document.getElementById("saveStatus");

function setSaveStatus(kind, detail) {
  saveStatusEl.classList.remove("saving", "error");
  if (kind === "saving") {
    saveStatusEl.textContent = "Сохранение…";
    saveStatusEl.classList.add("saving");
  } else if (kind === "saved") {
    saveStatusEl.textContent = "Сохранено";
  } else if (kind === "error") {
    saveStatusEl.textContent = "Ошибка: " + (detail || "");
    saveStatusEl.classList.add("error");
  } else {
    saveStatusEl.textContent = "";
  }
}

function scheduleSave() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 700);
}

async function doSave() {
  if (!dirty) return;
  dirty = false;
  setSaveStatus("saving");
  try {
    mergeInPlace(spell, normalizeSpell(await updateSpell(spellId, spell)));
    setSaveStatus("saved");
    // Панель "Заклинания" в dm.html/player.html кэширует список (обновляется
    // только при открытии) — без этого пинга её строка/уровень оставались бы
    // видимо устаревшими, пока панель не переоткроют (тот же приём, что
    // beacon:monsterSaved у бестиария). window.parent === window, если лист
    // вынесен кнопкой 🗗 в отдельное окно браузера — тогда обновлять нечего.
    if (window.parent !== window) {
      window.parent.postMessage({ type: "beacon:spellSaved", id: spellId }, location.origin);
    }
  } catch (err) {
    dirty = true;
    setSaveStatus("error", err.message);
  }
}

window.addEventListener("beforeunload", () => {
  if (dirty) doSave(); // best-effort, как в bestiary.js/character-sheet.js
});

// ==================== dice rolls ====================
// Библиотека заклинаний доступна и ДМ, и игрокам (в отличие от bestiary.js,
// которая только ДМ) — сокет броска выбирается по роли, тот же приём, что в
// character-sheet.js: connectRollSocket.

function connectRollSocket() {
  if (!rollLog) rollLog = createRollLog(document.getElementById("rollLogWrap"), { layout: "strip" });
  // Сокет с переподключением (см. web/src/ws-reconnect.js): без него обрыв
  // связи выглядел бы как «кубик перестал кидаться», без единого признака
  // на экране — сюда приходят только ответы на броски, и заметить нечего.
  rollWS = openSocket(isAdminView ? "/ws/dm" : "/ws/player", {
    onMessage: (data) => {
      if (data.type === "roll_result") rollLog.push(data);
    },
  });
}

function sendRoll(formula, label) {
  if (!rollWS) return;
  const fullLabel = spell && spell.name ? `${spell.name} — ${label || ""}`.trim().replace(/ —$/, "") : label;
  rollWS.send({ type: "roll_dice", formula, label: fullLabel });
}

// ==================== boot ====================

// editToggleBtn — тот же приём, что в bestiary.js/note-window.js.
const editToggleBtn = document.getElementById("editToggleBtn");
function updateEditToggleBtn() {
  editToggleBtn.innerHTML = icon(editMode ? "eye" : "pencil", { size: 14 });
  editToggleBtn.title = editMode ? "Просмотр" : "Редактировать";
  editToggleBtn.classList.toggle("active", editMode);
}
editToggleBtn.onclick = () => {
  editMode = !editMode;
  updateEditToggleBtn();
  renderApp();
};

initFullscreenButton(document.getElementById("fullscreenBtn"));

document.getElementById("closeBtn").onclick = () => {
  // Плавающее окно (обычный случай, см. floating-window.js) — iframe, не
  // умеет window.close() сам, сообщаем родителю; вынесенное 🗗-кнопкой в
  // настоящее окно браузера — закрываем как обычно.
  if (window.parent !== window) {
    window.parent.postMessage({ type: "beacon:closeFloatingWindow" }, location.origin);
  } else {
    window.close();
  }
};

// cloneBtn — карточки каталога "из коробки" (spell.system, см.
// internal/repository/spellfile/system.go) нельзя редактировать/удалять
// (сервер отдаёт 403), поэтому вместо ✎ показываем это и "Клонировать": та
// же логика, что и в bestiary.js.
const cloneBtn = document.getElementById("cloneBtn");
cloneBtn.onclick = async () => {
  cloneBtn.disabled = true;
  try {
    const created = await createSpell(spell.name || "Без имени");
    const copy = Object.assign({}, spell, { id: created.id, system: false });
    await updateSpell(created.id, copy);
    if (window.parent !== window) {
      window.parent.postMessage({ type: "beacon:spellSaved", id: created.id }, location.origin);
    }
    location.href = `/spellbook.html?id=${created.id}&edit=1`;
  } catch (err) {
    showAlert("Не удалось клонировать: " + err.message);
  } finally {
    cloneBtn.disabled = false;
  }
};

// deleteBtn — тот же приём, что и в itembook.js: подтверждение, DELETE,
// сообщить панели "Заклинания" (beacon:spellSaved — тот же тип, что и
// сохранение, refresh() в pages/catalog.js просто перезапросит список) и
// закрыть окно.
const deleteBtn = document.getElementById("deleteBtn");
deleteBtn.onclick = async () => {
  if (!(await showConfirm(`Удалить «${spell.name || "Без имени"}» из библиотеки?`, { title: "Удалить заклинание", okLabel: "Удалить", danger: true }))) return;
  deleteBtn.disabled = true;
  try {
    await deleteSpell(spellId);
    if (window.parent !== window) {
      window.parent.postMessage({ type: "beacon:spellSaved", id: spellId }, location.origin);
      window.parent.postMessage({ type: "beacon:closeFloatingWindow" }, location.origin);
    } else {
      window.close();
    }
  } catch (err) {
    showAlert("Не удалось удалить: " + err.message);
    deleteBtn.disabled = false;
  }
};

function currentId() {
  return new URLSearchParams(location.search).get("id");
}

(async function boot() {
  const me = await fetchMe();
  if (!me) {
    location.href = "/";
    return;
  }
  isAdminView = isGM(me.role);
  spellId = currentId();
  if (!spellId) {
    document.getElementById("loadingHint").textContent = "Не указан id заклинания (?id=...).";
    return;
  }
  try {
    spell = normalizeSpell(await fetchSpell(spellId));
  } catch (err) {
    document.getElementById("loadingHint").textContent = "Не удалось загрузить заклинание: " + err.message;
    return;
  }
  // Справочник состояний нужен только выпадашке «Накладывает» в режиме
  // правки — если он не загрузился, карточка всё равно должна открыться.
  try {
    allConditions = await fetchConditions();
  } catch {
    allConditions = [];
  }

  document.getElementById("spellTitle").textContent = spell.name || "Без имени";
  if (spell.system) {
    // Каталог "из коробки" — только просмотр, ✎ прячем совсем (сервер всё
    // равно откажет 403), вместо неё бейдж + "Клонировать" (см. cloneBtn выше).
    editMode = false;
    editToggleBtn.style.display = "none";
    deleteBtn.style.display = "none";
    cloneBtn.classList.add("visible");
    const pill = document.createElement("span");
    pill.className = "sys-pill";
    pill.title = "Карточка каталога «из коробки» — только для чтения";
    pill.innerHTML = icon("lock", { size: 11 }) + " каталог";
    document.getElementById("spellTitle").after(pill);
  } else {
    // ?edit=1 — только что созданная пустая карточка (см. dm.js/player.js:
    // newSpellForm) открывается сразу в редактировании.
    editMode = new URLSearchParams(location.search).get("edit") === "1";
  }
  updateEditToggleBtn();
  renderApp();

  document.getElementById("loadingHint").style.display = "none";
  document.getElementById("app").classList.add("ready");

  connectRollSocket();
})();
