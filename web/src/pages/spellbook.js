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
import { fetchMe, fetchSpell, createSpell, updateSpell, fetchConditions } from "../api.js";
import { icon } from "../icons.js";
import { renderNoteHtml } from "../notes/markdown.js";
import { mapFoundrySpellJson } from "../spell-import.js";
import { enhanceRolls } from "../inline-rolls.js";
import { wireCatalogLinks } from "../catalog-links.js";

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

// ==================== DOM helpers (та же схема, что bestiary.js) ====================

function h(tag, attrs, children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(children || [])) {
    if (c === undefined || c === null || c === false) continue;
    e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
}

function field(labelText, inputEl, title) {
  return h("label", { class: "field", title }, [h("span", { text: labelText }), inputEl]);
}

function textInput(get, set, opts) {
  const inp = h("input", Object.assign({ type: "text" }, opts || {}));
  inp.value = get() ?? "";
  inp.addEventListener("input", () => {
    set(inp.value);
    scheduleSave();
  });
  return inp;
}

function selectInput(get, set, options) {
  const sel = h(
    "select",
    {},
    options.map((o) => h("option", { value: o.value, text: o.label }))
  );
  sel.value = String(get());
  sel.addEventListener("change", () => {
    set(parseInt(sel.value, 10));
    scheduleSave();
  });
  return sel;
}

function checkboxField(labelText, get, set) {
  const cb = h("input", { type: "checkbox" });
  cb.checked = !!get();
  cb.addEventListener("change", () => {
    set(cb.checked);
    scheduleSave();
  });
  return h("label", { class: "check-row" }, [cb, labelText]);
}

// mdBlock — textarea markdown/HTML слева + живой рендер справа (тот же
// `marked`, что и заметки ДМ/бестиарий, см. web/src/notes/markdown.js).
// Импортированное описание приходит уже HTML-ом — marked пропускает
// инлайновый HTML как есть, рендер работает одинаково что для markdown, что
// для готового HTML.
function mdBlock(labelText, get, set, opts) {
  const render = h("div", { class: "md-render" });
  render.innerHTML = renderNoteHtml(get());
  const t = h("textarea", opts || {});
  t.value = get() ?? "";
  t.addEventListener("input", () => {
    set(t.value);
    render.innerHTML = renderNoteHtml(t.value);
    scheduleSave();
  });
  return h("div", { class: "section" }, [h("h3", { text: labelText }), h("div", { class: "md-block" }, [t, render])]);
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
  // ---- шапка: имя/уровень/школа/источник/теги ----
  root.appendChild(
    h("div", { class: "section" }, [
      h("div", { class: "row" }, [
        field("Имя", textInput(() => spell.name, (v) => { spell.name = v; document.getElementById("spellTitle").textContent = v || "Без имени"; })),
        field("Уровень", selectInput(() => spell.level, (v) => (spell.level = v), LEVEL_OPTIONS)),
        field("Школа", textInput(() => spell.school, (v) => (spell.school = v), { placeholder: "Прорицание" })),
        field("Источник", textInput(() => spell.source, (v) => (spell.source = v), { placeholder: "PHB'24" })),
      ]),
      tagsField(),
    ])
  );

  // ---- сотворение ----
  root.appendChild(
    h("div", { class: "section" }, [
      h("h3", { text: "Сотворение" }),
      h("div", { class: "row" }, [
        field("Время накладывания", textInput(() => spell.castTime, (v) => (spell.castTime = v), { placeholder: "1 действие" })),
        field("Дистанция", textInput(() => spell.range, (v) => (spell.range = v), { placeholder: "120 фт." })),
        field("Длительность", textInput(() => spell.duration, (v) => (spell.duration = v), { placeholder: "Мгновенная" })),
      ]),
      h("div", { class: "checkbox-row" }, [
        checkboxField("Ритуал", () => spell.ritual, (v) => (spell.ritual = v)),
        checkboxField("Концентрация", () => spell.concentration, (v) => (spell.concentration = v)),
        checkboxField("В (вербальный)", () => spell.verbal, (v) => (spell.verbal = v)),
        checkboxField("С (соматический)", () => spell.somatic, (v) => (spell.somatic = v)),
        checkboxField("М (материальный)", () => spell.material, (v) => (spell.material = v)),
      ]),
      field("Материальные компоненты", textInput(() => spell.materialNote, (v) => (spell.materialNote = v), { placeholder: "жемчужина стоимостью не менее 100 зм..." })),
    ])
  );

  // ---- эффект ----
  root.appendChild(
    h("div", { class: "section" }, [
      h("h3", { text: "Эффект" }),
      h("div", { class: "row" }, [
        field("Спасбросок", textInput(() => spell.savingThrow, (v) => (spell.savingThrow = v), { placeholder: "Тел" })),
        field("Урон", textInput(() => spell.damage, (v) => (spell.damage = v), { placeholder: "8к6 (огонь)" })),
        field("Классы", textInput(() => spell.classes, (v) => (spell.classes = v), { placeholder: "Волшебник, Чародей" })),
      ]),
      statusesField(),
    ])
  );

  // ---- описание ----
  root.appendChild(mdBlock("Описание", () => spell.description, (v) => (spell.description = v)));

  // ---- импорт из TTG Club ----
  root.appendChild(importSection());
}

// ==================== read-режим (по умолчанию) ====================
// Карточка заклинания в духе Foundry: имя + "уровень, школа" подстрокой,
// сетка сотворения, эффект, описание — без единого сырого инпута. Урон и
// прочие формулы в описании кликабельны (см. web/src/inline-rolls.js).

function lineIf(label, value) {
  const v = (value ?? "").toString().trim();
  if (!v) return null;
  return h("div", { class: "sb-line" }, [h("strong", { text: label + " " }), v]);
}

function levelLabel(lvl) {
  const opt = LEVEL_OPTIONS.find((o) => o.value === lvl);
  return opt ? opt.label : String(lvl);
}

// componentsText — "В, С, М (материалы)" собранная строка из трёх чекбоксов
// + свободного текста материалов (то же самое, что показал бы Foundry в
// шапке карточки заклинания).
function componentsText(s) {
  const parts = [];
  if (s.verbal) parts.push("В");
  if (s.somatic) parts.push("С");
  if (s.material) parts.push("М" + (s.materialNote ? ` (${s.materialNote})` : ""));
  return parts.join(", ");
}

function readHeader() {
  const subtitleBits = [levelLabel(spell.level), spell.school].filter(Boolean).join(", ");
  const badges = [];
  if (spell.ritual) badges.push("Ритуал");
  if (spell.concentration) badges.push("Концентрация");
  const pills = [...(spell.source ? [spell.source] : []), ...spell.tags].map((t) => h("span", { class: "sb-tag-pill", text: t }));
  return h("div", { class: "sb-header-text" }, [
    h("h2", { class: "sb-name", text: spell.name || "Без имени" }),
    h("div", { class: "sb-subtitle", text: subtitleBits + (badges.length ? " · " + badges.join(", ") : "") }),
    pills.length ? h("div", { class: "sb-tags" }, pills) : null,
  ]);
}

function readCastingGrid() {
  const wrap = h("div", { class: "sb-info" });
  const add = (label, value) => {
    const line = lineIf(label, value);
    if (line) wrap.appendChild(line);
  };
  add("Время накладывания", spell.castTime);
  add("Дистанция", spell.range);
  add("Компоненты", componentsText(spell));
  add("Длительность", spell.duration);
  add("Спасбросок", spell.savingThrow);
  add("Урон", spell.damage);
  add("Классы", spell.classes);
  return wrap;
}

function renderReadView(root) {
  root.appendChild(readHeader());
  root.appendChild(h("div", { class: "sb-hr" }));
  const info = readCastingGrid();
  root.appendChild(info);
  enhanceRolls(info, sendRoll); // формула урона и т.п. в этих строках — кликабельная

  const statusesBlock = readStatuses();
  if (statusesBlock) root.appendChild(statusesBlock);

  const desc = spell.description && spell.description.trim();
  if (desc) {
    root.appendChild(h("div", { class: "sb-hr" }));
    const body = h("div", { class: "sb-prose" });
    body.innerHTML = renderNoteHtml(spell.description);
    enhanceRolls(body, sendRoll);
    wireCatalogLinks(body);
    root.appendChild(h("div", { class: "sb-block" }, [h("h3", { class: "sb-section-title", text: "Описание" }), body]));
  }
}

// statusesField — правка списка «что накладывает» руками (режим ✎). Список
// состояний мира тянется один раз при загрузке карточки (см. boot) — тем же
// приёмом, что и остальные подсказки в конструкторах; если он не загрузился,
// поле всё равно работает, просто без выпадашки.
function statusesField() {
  const wrap = h("div", { style: "margin-top:8px;" });
  const list = h("div", { class: "tag-list" });

  function renderList() {
    list.innerHTML = "";
    spell.statuses.forEach((ref, i) => {
      const roundsInp = h("input", {
        type: "number",
        min: "0",
        value: ref.rounds || 0,
        style: "width:56px;",
        title: "Раундов, 0 — по описанию заклинания",
      });
      roundsInp.addEventListener("input", () => {
        const v = parseInt(roundsInp.value, 10);
        ref.rounds = Number.isNaN(v) ? 0 : v;
        scheduleSave();
      });
      const noteInp = h("input", {
        type: "text",
        value: ref.note || "",
        placeholder: "при провале спасброска",
        style: "width:170px;",
      });
      noteInp.addEventListener("input", () => {
        ref.note = noteInp.value;
        scheduleSave();
      });
      list.appendChild(
        h("span", { class: "tag-pill", style: "gap:6px;padding:2px 6px 2px 10px;" }, [
          ref.name || ref.slug,
          roundsInp,
          noteInp,
          h("button", {
            type: "button",
            html: icon("close", { size: 11 }),
            onclick: () => {
              spell.statuses.splice(i, 1);
              scheduleSave();
              renderList();
            },
          }),
        ])
      );
    });
  }
  renderList();

  const select = h("select", {});
  select.appendChild(h("option", { value: "", text: "+ добавить состояние…" }));
  for (const c of allConditions) {
    if (!c.slug) continue;
    select.appendChild(h("option", { value: c.slug, text: `${c.name} (${c.slug})` }));
  }
  select.addEventListener("change", () => {
    const slug = select.value;
    select.value = "";
    if (!slug || spell.statuses.some((s) => s.slug === slug)) return;
    const cond = allConditions.find((c) => c.slug === slug);
    spell.statuses.push({ slug, name: cond ? cond.name : slug, rounds: (cond && cond.defaultRounds) || 0, note: "" });
    scheduleSave();
    renderList();
  });

  wrap.append(
    field("Накладывает состояния", select, "Заполняется и импортом из Foundry (effects[] заклинания). Метку всё равно вешает ДМ вручную — сервер спасброски не кидает."),
    list
  );
  return wrap;
}

// readStatuses — блок «Накладывает состояния» (см. domain.SpellStatusRef).
// Заполняется импортом из Foundry (effects[] заклинания, см.
// spell-import.js: mapFoundrySpellStatuses) или руками в режиме правки.
//
// Чип кликабелен только у ДМ и только когда карточка открыта внутри
// dm.html: сама она живёт в iframe плавающего окна и WS-команды слать не
// может — вместо этого просит топ-документ показать выбор цели и наложить
// (postMessage "beacon:applySpellStatus", см. web/src/pages/dm.js). У игрока
// и в отдельном окне браузера это просто справочная строка: сервер всё
// равно не даст игроку наложить метку (см. Room.authorize).
function readStatuses() {
  if (!spell.statuses.length) return null;
  const canApply = isAdminView && window.parent !== window;
  const chips = spell.statuses.map((ref) => {
    const bits = [ref.name || ref.slug];
    if (ref.rounds) bits.push(`${ref.rounds} р.`);
    if (ref.note) bits.push(ref.note);
    const chip = h("span", { class: "tag-pill" + (canApply ? " clickable" : ""), text: bits.join(" · ") });
    if (canApply) {
      chip.title = "Наложить это состояние на токен на карте";
      chip.style.cursor = "pointer";
      chip.onclick = () =>
        window.parent.postMessage(
          {
            type: "beacon:applySpellStatus",
            slug: ref.slug,
            name: ref.name || ref.slug,
            rounds: ref.rounds || 0,
            spellName: spell.name || "",
          },
          location.origin
        );
    }
    return chip;
  });
  return h("div", { class: "sb-block" }, [
    h("h3", { class: "sb-section-title", text: "Накладывает состояния" }),
    h("div", { class: "tag-list" }, chips),
    canApply ? null : h("div", { class: "hint", text: "Наложить метку может только ДМ — из окна ДМ-стола." }),
  ]);
}

function tagsField() {
  const wrap = h("div", {});
  const list = h("div", { class: "tag-list" });
  function renderTags() {
    list.innerHTML = "";
    spell.tags.forEach((tag, i) => {
      list.appendChild(
        h("span", { class: "tag-pill" }, [tag, h("button", { type: "button", html: icon("close", { size: 11 }), onclick: () => { spell.tags.splice(i, 1); scheduleSave(); renderTags(); } })])
      );
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
  });
  wrap.append(field("Теги", input), list);
  return wrap;
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
  return h("div", { class: "section", id: "importSection" }, [
    h("h3", { text: "Импорт из TTG Club" }),
    h("p", { class: "hint" }, "На странице заклинания на 5e14.ttg.club нажми «Экспортировать в FvTT» и сохрани JSON-файл — выбери его ниже (или вставь содержимое текстом). Поля карточки заменятся тем, что удастся разобрать из файла."),
    field("Файл экспорта", fileInput),
    textarea,
    importBtn,
    msg,
  ]);
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
    spell = normalizeSpell(await updateSpell(spellId, spell));
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
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  rollWS = new WebSocket(`${scheme}//${location.host}${isAdminView ? "/ws/dm" : "/ws/player"}`);
  rollWS.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
    if (data.type === "roll_result") showRollResult(data);
  };
}

function sendRoll(formula, label) {
  if (!rollWS || rollWS.readyState !== WebSocket.OPEN) return;
  const fullLabel = spell && spell.name ? `${spell.name} — ${label || ""}`.trim().replace(/ —$/, "") : label;
  rollWS.send(JSON.stringify({ type: "roll_dice", formula, label: fullLabel }));
}

function showRollResult(data) {
  const wrap = document.getElementById("rollLogWrap");
  wrap.classList.remove("hidden");
  const log = document.getElementById("rollLog");
  const mod = data.modifier ? (data.modifier > 0 ? "+" + data.modifier : String(data.modifier)) : "";
  const who = data.label ? `${data.name} — ${data.label}` : data.name;
  const row = h("div", { class: "dice-log-row", text: `${who}: ${data.formula} → [${(data.rolls || []).join(", ")}]${mod} = ${data.total}` });
  log.prepend(row);
  while (log.children.length > 20) log.removeChild(log.lastChild);
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
    alert("Не удалось клонировать: " + err.message);
  } finally {
    cloneBtn.disabled = false;
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
  isAdminView = me.role === "admin";
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
