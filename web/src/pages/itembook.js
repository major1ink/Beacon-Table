// Карточка библиотеки предметов — отдельное окно, открывается из
// dm.html/player.html (панель/модалка "Предметы"), по аналогии с
// spellbook.js/bestiary.js (тот же приём: плавающее окно = floating-window.js,
// тот же h()/textInput/... DOM-конструктор).
//
// "Умный бланк" — сервер (internal/domain/item.go) не знает правил D&D,
// только хранит присланный JSON. Единственная нетривиальная часть здесь —
// блок импорта: разбор экспорта предмета из Foundry VTT целиком в
// web/src/item-import.js (чистая функция, без побочных эффектов), этот файл
// только вызывает её и мержит результат в текущую карточку.
import { fetchMe, fetchItem, createItem, updateItem, deleteItem, uploadFile } from "../api.js";
import { mergeInPlace } from "../merge-in-place.js";
import { openSocket } from "../ws-reconnect.js";
import { icon } from "../icons.js";
import { renderNoteHtml } from "../notes/markdown.js";
import { mapFoundryItemJson } from "../item-import.js";
import { enhanceRolls } from "../inline-rolls.js";
import { wireCatalogLinks } from "../catalog-links.js";
import { renderStatEditor, loadTargets } from "../stat-editor.js";
import { loadStand, renderStandSelect } from "../stand.js";
import { el as hh, labeled, pill, ornament, renderHero, fold, renderBody } from "../card-shell.js";
import { renderKvTable } from "../kv-table.js";
import { renderInventoryPreview } from "../inventory-preview.js";
import { glyphNode } from "../condition-glyphs.js";
import { itemGlyphName } from "../item-glyph.js";
import { RARITY, rarityColor } from "../item-rarity.js";
import { showAlert, showConfirm } from "../modal.js";
import { createRollLog } from "../roll-log.js";
import { isGM } from "../roles.js";
import { initFullscreenButton } from "../fullscreen.js";
import { withRollMode } from "../roll-mode.js";

// ==================== state ====================

let itemId = null;
let item = null; // объект domain.Item целиком (сервер отдаёт camelCase — см. json-теги)
// standEntries — существа и персонажи для «примерить на» (см. stand.js).
let standEntries = [];
let rollWS = null;
let rollLog = null; // общий виджет лога бросков (см. web/src/roll-log.js)
let isAdminView = false; // роль текущего аккаунта (см. boot()) — определяет /ws/dm или /ws/player
// editMode — по умолчанию карточка открывается в чистом read-режиме, как
// domain.Spell/Monster (см. spellbook.js/bestiary.js) — тот же приём и там же обоснование.
let editMode = false;

function normalizeItem(raw) {
  const it = raw && typeof raw === "object" ? raw : {};
  it.tags = Array.isArray(it.tags) ? it.tags : [];
  it.modifiers = Array.isArray(it.modifiers) ? it.modifiers : [];
  return it;
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

// mdBlock — textarea markdown/HTML + живой рендер (тот же `marked`, что и
// заметки ДМ, см. web/src/notes/markdown.js).
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

// attunementText — «требует настройки (колдуном)» для плашки и подзаголовка.
function attunementText(it) {
  if (!it.requiresAttunement) return "";
  return it.attunementNote ? `требует настройки (${it.attunementNote})` : "требует настройки";
}

function heroPills() {
  return [
    item.rarity ? pill(item.rarity, "rar") : null,
    item.requiresAttunement ? pill(attunementText(item), "att") : null,
    item.source ? pill(item.source, "gold") : null,
    ...item.tags.map((t) => pill(t)),
  ];
}

// kvRows — строки таблицы «показатель · значение» (kv-table.js).
function kvRows() {
  return [
    { label: "Стоимость", get: () => item.cost, set: (v) => (item.cost = v), placeholder: "50 зм.", mono: true },
    { label: "Вес", get: () => item.weight, set: (v) => (item.weight = v), placeholder: "1 фунт.", mono: true },
    // weightLb — тот же вес числом (см. domain.Item.WeightLb) для суммы
    // инвентаря на листе; с текстовым «Вес» не синхронизируется.
    { label: "Вес числом, фнт", get: () => item.weightLb, set: (v) => (item.weightLb = v), placeholder: "0", mono: true, type: "number", min: "0", step: "any", unit: " фнт" },
    { label: "Активация", get: () => item.activation, set: (v) => (item.activation = v), placeholder: "1 действие" },
    { label: "Урон", get: () => item.damage, set: (v) => (item.damage = v), placeholder: "1к8 рубящий", mono: true },
    { label: "Класс доспеха", get: () => item.armorClass, set: (v) => (item.armorClass = v), placeholder: "14 + Лов (макс 2)", mono: true },
    { label: "Свойства", get: () => item.properties, set: (v) => (item.properties = v), placeholder: "лёгкое, фехтовальное" },
    { label: "Заряды", get: () => item.charges, set: (v) => (item.charges = v), placeholder: "3 заряда, 1к3 на рассвете" },
  ];
}

// ==================== рендер ====================

function renderApp() {
  const root = document.getElementById("app");
  root.innerHTML = "";
  if (editMode) renderEditView(root);
  else renderReadView(root);
}

function renderEditView(root) {
  const upload = h("input", { type: "file", accept: "image/*", style: "display:none" });
  upload.addEventListener("change", async () => {
    const file = upload.files[0];
    if (!file) return;
    try {
      const { url } = await uploadFile(file, "tokens");
      item.imageUrl = url;
      scheduleSave();
      hero.setGlyph(glyphNode(itemGlyphName(item), ""), item.imageUrl);
      artBtn.textContent = "Убрать арт";
      preview.update();
    } catch (err) {
      showAlert("Не удалось загрузить иконку: " + err.message);
    }
  });
  const artBtn = h("button", {
    type: "button",
    text: item.imageUrl ? "Убрать арт" : "Загрузить свой…",
    onclick: () => {
      if (item.imageUrl) {
        item.imageUrl = "";
        scheduleSave();
        hero.setGlyph(glyphNode(itemGlyphName(item), ""), "");
        artBtn.textContent = "Загрузить свой…";
        preview.update();
      } else upload.click();
    },
  });

  // Редкость — известные значения списком, любое другое остаётся текстом.
  const raritySel = h("select", {});
  raritySel.appendChild(h("option", { value: "", text: "—" }));
  for (const r of RARITY) raritySel.appendChild(h("option", { value: r.ru, text: r.ru }));
  if (item.rarity && !RARITY.some((r) => r.ru === item.rarity)) raritySel.appendChild(h("option", { value: item.rarity, text: item.rarity }));
  raritySel.value = item.rarity || "";
  raritySel.addEventListener("change", () => {
    item.rarity = raritySel.value;
    scheduleSave();
    refreshHead();
  });
  const attCb = h("input", { type: "checkbox" });
  attCb.checked = !!item.requiresAttunement;
  attCb.addEventListener("change", () => {
    item.requiresAttunement = attCb.checked;
    scheduleSave();
    attNoteBox.hidden = !item.requiresAttunement;
    refreshHead();
  });
  const attNote = textInput(() => item.attunementNote, (v) => { item.attunementNote = v; refreshHead(); }, { placeholder: "колдуном", style: "width:180px" });
  const attNoteBox = labeled("Кем", attNote);
  attNoteBox.hidden = !item.requiresAttunement;

  // Книжный подзаголовок: тип правится прямо в нём.
  const typeInp = textInput(() => item.type, (v) => { item.type = v; typeInp.size = Math.max(14, v.length + 1); hero.setGlyph(glyphNode(itemGlyphName(item), ""), item.imageUrl); preview.update(); }, { placeholder: "Доспех (кольчуга)", "aria-label": "Тип" });
  typeInp.size = Math.max(14, (item.type || "").length + 1);
  const subTail = h("span", {});
  const subtitle = h("div", { class: "card-sub" }, [typeInp, subTail]);
  const refreshHead = () => {
    subTail.textContent = [item.rarity ? ", " + item.rarity : "", item.requiresAttunement ? " (" + attunementText(item) + ")" : ""].join("");
    hero.setPills(heroPills());
    hero.setColor(rarityColor(item.rarity) || "");
  };

  const hero = renderHero({
    glyph: glyphNode(itemGlyphName(item), ""),
    imageUrl: item.imageUrl,
    color: rarityColor(item.rarity) || "",
    name: item.name,
    namePlaceholder: "Название предмета",
    pills: heroPills(),
    square: true,
    subtitle,
    controls: [labeled("Редкость", raritySel), h("div", { class: "field" }, [h("span", { text: "Требует" }), h("label", { class: "card-toggle" }, [attCb, "настройки"])]), attNoteBox, h("div", { class: "field" }, [h("span", { text: "Арт" }), artBtn, upload])],
    onName: (v) => {
      item.name = v;
      document.getElementById("itemTitle").textContent = v || "Без имени";
      scheduleSave();
      preview.update();
    },
  });
  refreshHead();
  root.appendChild(hero.el);
  root.appendChild(ornament());

  const stand = renderStandSelect(standEntries);
  const preview = renderInventoryPreview(item, { stand, sendRoll });
  const kv = renderKvTable(kvRows(), { onChange: () => { scheduleSave(); preview.update(); }, hint: "Пустые строки в режиме чтения скрываются. Формулы кубов кликабельны." });
  const worn = h("div", {}, [
    h("div", { class: "card-worn-h" }, [h("span", { class: "card-lbl", text: "Пока надет" })]),
    renderStatEditor(item.modifiers, () => { scheduleSave(); preview.update(); }, { stand, periodic: false }),
  ]);

  const descFold = fold({ title: "Описание", summary: item.description || "что это и как выглядит", body: [mdBlock("Описание", () => item.description, (v) => { item.description = v; descFold.setSummary(v || "что это и как выглядит"); })] });
  const compatSummary = () => [item.source, item.foundryModuleId].filter(Boolean).join(" · ") || "источник, теги, модуль Foundry";
  const compatFold = fold({
    title: "Совместимость и источник",
    summary: compatSummary(),
    body: [
      h("div", { class: "card-grid2" }, [
        labeled("Источник", textInput(() => item.source, (v) => { item.source = v; hero.setPills(heroPills()); compatFold.setSummary(compatSummary()); }, { placeholder: "DMG'24" })),
        labeled("Модуль Foundry", textInput(() => item.foundryModuleId, (v) => { item.foundryModuleId = v; compatFold.setSummary(compatSummary()); }, { placeholder: "dnd5e.items" }), "Откуда импортирован — чтобы повторный импорт нашёл карточку."),
      ]),
      tagsField(() => hero.setPills(heroPills())),
    ],
  });

  root.appendChild(renderBody([kv, worn, h("div", { class: "card-folds" }, [descFold, compatFold, importSection()])], [preview]));
}

// ==================== read-режим (по умолчанию) ====================

function renderReadView(root) {
  const subtitle = h("div", { class: "card-sub", text: [item.type, item.rarity].filter(Boolean).join(", ") + (item.requiresAttunement ? " (" + attunementText(item) + ")" : "") });
  const hero = renderHero({
    glyph: glyphNode(itemGlyphName(item), ""),
    imageUrl: item.imageUrl,
    color: rarityColor(item.rarity) || "",
    name: item.name,
    pills: heroPills(),
    square: true,
    subtitle,
    readOnly: true,
  });
  root.appendChild(hero.el);
  root.appendChild(ornament());

  const stand = renderStandSelect(standEntries);
  const preview = renderInventoryPreview(item, { stand, sendRoll });
  const kv = renderKvTable(kvRows(), { readOnly: true, sendRoll });
  const worn = item.modifiers.length
    ? h("div", {}, [h("div", { class: "card-worn-h" }, [h("span", { class: "card-lbl", text: "Пока надет" })]), renderStatEditor(item.modifiers, () => {}, { stand, periodic: false, readOnly: true })])
    : null;

  const folds = [];
  const desc = item.description && item.description.trim();
  if (desc) {
    const body = h("div", { class: "card-prose" });
    body.innerHTML = renderNoteHtml(item.description);
    enhanceRolls(body, sendRoll);
    wireCatalogLinks(body);
    folds.push(fold({ title: "Описание", body: [body], open: true }));
  }
  const compat = [item.source, item.foundryModuleId].filter(Boolean).join(" · ");
  if (compat) folds.push(fold({ title: "Совместимость и источник", summary: compat, body: [h("p", { class: "card-text", text: compat })] }));

  root.appendChild(renderBody([kv, worn, folds.length ? h("div", { class: "card-folds" }, folds) : null], [preview]));
}

function tagsField(onChange) {
  const list = h("div", { class: "card-chips" });
  function renderTags() {
    list.innerHTML = "";
    item.tags.forEach((tag, i) => {
      list.appendChild(
        h("span", { class: "card-chip" }, [tag, h("button", { type: "button", html: icon("close", { size: 11 }), "aria-label": "Убрать тег", onclick: () => { item.tags.splice(i, 1); scheduleSave(); renderTags(); onChange(); } })])
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
    item.tags.push(v);
    input.value = "";
    scheduleSave();
    renderTags();
    onChange();
  });
  return h("div", {}, [labeled("Теги", input), list]);
}

// applyImport — общая точка для файла и вставленного текста: парсит JSON,
// мапит через mapFoundryItemJson, мержит результат в item.
function applyImport(rawText, msgEl) {
  msgEl.classList.remove("error", "ok");
  msgEl.textContent = "";
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    msgEl.textContent = "Не удалось разобрать JSON — проверь, что это файл экспорта предмета.";
    msgEl.classList.add("error");
    return;
  }
  let mapped;
  try {
    mapped = mapFoundryItemJson(parsed);
  } catch (err) {
    msgEl.textContent = err.message;
    msgEl.classList.add("error");
    return;
  }
  Object.assign(item, mapped);
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
    title: "Импорт из Foundry VTT",
    summary: "JSON-экспорт предмета",
    body: [
      h("p", { class: "card-note" }, "Экспортируй предмет (оружие/доспех/чудесный предмет и т.п.) из Foundry VTT в JSON и выбери файл ниже (или вставь содержимое текстом). У предметов ttg.club, в отличие от заклинаний/существ, своей кнопки экспорта нет. Поля карточки заменятся тем, что удастся разобрать из файла."),
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
    mergeInPlace(item, normalizeItem(await updateItem(itemId, item)));
    setSaveStatus("saved");
    // Панель "Предметы" в dm.html/player.html кэширует список (обновляется
    // только при открытии) — без этого пинга её строка оставалась бы видимо
    // устаревшей, пока панель не переоткроют (тот же приём, что
    // beacon:spellSaved у библиотеки заклинаний). window.parent === window,
    // если лист вынесен кнопкой 🗗 в отдельное окно браузера — тогда
    // обновлять нечего.
    if (window.parent !== window) {
      window.parent.postMessage({ type: "beacon:itemSaved", id: itemId }, location.origin);
    }
  } catch (err) {
    dirty = true;
    setSaveStatus("error", err.message);
  }
}

window.addEventListener("beforeunload", () => {
  if (dirty) doSave(); // best-effort, как в spellbook.js/bestiary.js
});

// ==================== dice rolls ====================
// Библиотека предметов доступна и ДМ, и игрокам (в отличие от bestiary.js,
// которая только ДМ) — сокет броска выбирается по роли, тот же приём, что в
// spellbook.js: connectRollSocket.

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
  const fullLabel = item && item.name ? `${item.name} — ${label || ""}`.trim().replace(/ —$/, "") : label;
  rollWS.send(withRollMode({ type: "roll_dice", formula, label: fullLabel }));
}


// ==================== boot ====================

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
  if (window.parent !== window) {
    window.parent.postMessage({ type: "beacon:closeFloatingWindow" }, location.origin);
  } else {
    window.close();
  }
};

// cloneBtn — карточки каталога "из коробки" (item.system, см.
// internal/repository/itemfile/system.go) нельзя редактировать/удалять
// (сервер отдаёт 403), поэтому вместо ✎ показываем это и "Клонировать": та
// же логика, что и в spellbook.js/bestiary.js.
const cloneBtn = document.getElementById("cloneBtn");
cloneBtn.onclick = async () => {
  cloneBtn.disabled = true;
  try {
    const created = await createItem(item.name || "Без имени");
    const copy = Object.assign({}, item, { id: created.id, system: false });
    await updateItem(created.id, copy);
    if (window.parent !== window) {
      window.parent.postMessage({ type: "beacon:itemSaved", id: created.id }, location.origin);
    }
    location.href = `/itembook.html?id=${created.id}&edit=1`;
  } catch (err) {
    showAlert("Не удалось клонировать: " + err.message);
  } finally {
    cloneBtn.disabled = false;
  }
};

// deleteBtn — то же подтверждение и тот же API-вызов, что и у кнопки-корзины
// в списке библиотеки (см. pages/catalog.js: buildRow.delBtn), только отсюда
// удаляется уже открытая карточка: после успеха окно закрывается само (как
// closeBtn выше), библиотека узнаёт об этом через тот же beacon:itemSaved,
// которым сохранение сообщает о себе панели "Предметы" (см. doSave).
const deleteBtn = document.getElementById("deleteBtn");
deleteBtn.onclick = async () => {
  if (!(await showConfirm(`Удалить «${item.name || "Без имени"}» из библиотеки?`, { title: "Удалить предмет", okLabel: "Удалить", danger: true }))) return;
  deleteBtn.disabled = true;
  try {
    await deleteItem(itemId);
    if (window.parent !== window) {
      window.parent.postMessage({ type: "beacon:itemSaved", id: itemId }, location.origin);
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
  itemId = currentId();
  if (!itemId) {
    document.getElementById("loadingHint").textContent = "Не указан id предмета (?id=...).";
    return;
  }
  await loadTargets(); // подписи целей для статблока
  standEntries = await loadStand();
  try {
    item = normalizeItem(await fetchItem(itemId));
  } catch (err) {
    document.getElementById("loadingHint").textContent = "Не удалось загрузить предмет: " + err.message;
    return;
  }

  document.getElementById("itemTitle").textContent = item.name || "Без имени";
  if (item.system) {
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
    document.getElementById("itemTitle").after(pill);
  } else {
    // ?edit=1 — только что созданная пустая карточка (см. dm.js/player.js:
    // newItemForm) открывается сразу в редактировании.
    editMode = new URLSearchParams(location.search).get("edit") === "1";
  }
  updateEditToggleBtn();
  renderApp();

  document.getElementById("loadingHint").style.display = "none";
  document.getElementById("app").classList.add("ready");

  connectRollSocket();
})();
