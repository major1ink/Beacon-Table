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
import { openSocket } from "../ws-reconnect.js";
import { icon } from "../icons.js";
import { renderNoteHtml } from "../notes/markdown.js";
import { mapFoundryItemJson } from "../item-import.js";
import { enhanceRolls } from "../inline-rolls.js";
import { wireCatalogLinks } from "../catalog-links.js";
import { renderModifierEditor, loadModifierTargets, ensureModifierEditorCSS, describeModifier } from "../modifier-editor.js";
import { showAlert, showConfirm } from "../modal.js";
import { createRollLog } from "../roll-log.js";
import { isGM } from "../roles.js";

// ==================== state ====================

let itemId = null;
let item = null; // объект domain.Item целиком (сервер отдаёт camelCase — см. json-теги)
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

// ==================== DOM helpers (та же схема, что spellbook.js) ====================

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

function field(labelText, inputEl) {
  return h("label", { class: "field" }, [h("span", { text: labelText }), inputEl]);
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

function numberInput(get, set, opts) {
  const inp = h("input", Object.assign({ type: "number" }, opts || {}));
  inp.value = get() ?? 0;
  inp.addEventListener("input", () => {
    set(parseFloat(inp.value) || 0);
    scheduleSave();
  });
  return inp;
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
// `marked`, что и заметки ДМ/бестиарий/заклинания, см. web/src/notes/markdown.js).
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

function renderApp() {
  const root = document.getElementById("app");
  root.innerHTML = "";
  if (editMode) renderEditView(root);
  else renderReadView(root);
}

function renderEditView(root) {
  // ---- шапка: иконка + имя/тип/редкость/источник/теги ----
  const portrait = item.imageUrl
    ? h("img", { class: "portrait-img", src: item.imageUrl })
    : h("div", { class: "portrait-placeholder", text: "нет иконки" });
  const upload = h("input", { type: "file", accept: "image/*" });
  upload.addEventListener("change", async () => {
    const file = upload.files[0];
    if (!file) return;
    try {
      const { url } = await uploadFile(file, "tokens");
      item.imageUrl = url;
      scheduleSave();
      renderApp();
    } catch (err) {
      showAlert("Не удалось загрузить иконку: " + err.message);
    }
  });
  root.appendChild(
    h("div", { class: "section" }, [
      h("div", { class: "portrait-wrap" }, [portrait, h("div", { class: "col", style: "flex:1 1 auto;gap:6px;" }, [
        field("Имя", textInput(() => item.name, (v) => { item.name = v; document.getElementById("itemTitle").textContent = v || "Без имени"; })),
        field("Иконка", upload),
      ])]),
      h("div", { class: "row" }, [
        field("Тип", textInput(() => item.type, (v) => (item.type = v), { placeholder: "Чудесный предмет" })),
        field("Редкость", textInput(() => item.rarity, (v) => (item.rarity = v), { placeholder: "обычный" })),
        field("Источник", textInput(() => item.source, (v) => (item.source = v), { placeholder: "XGE" })),
      ]),
      h("div", { class: "checkbox-row" }, [checkboxField("Требует настройки", () => item.requiresAttunement, (v) => (item.requiresAttunement = v))]),
      field("Кем/чем настраивается", textInput(() => item.attunementNote, (v) => (item.attunementNote = v), { placeholder: "колдуном" })),
      tagsField(),
    ])
  );

  // ---- характеристики ----
  root.appendChild(
    h("div", { class: "section" }, [
      h("h3", { text: "Характеристики" }),
      h("div", { class: "row" }, [
        field("Стоимость", textInput(() => item.cost, (v) => (item.cost = v), { placeholder: "50 зм." })),
        field("Вес", textInput(() => item.weight, (v) => (item.weight = v), { placeholder: "1 фунт." })),
        // weightLb — тот же вес, но числом (см. domain.Item.WeightLb), для
        // подсчёта суммарного веса инвентаря (сумма quantity*weightLb, см.
        // pages/character-sheet.js: totalWeight) — не синхронизируется со
        // свободнотекстовым "Вес" выше, оба поля независимы.
        field("Вес, фунты (число)", numberInput(() => item.weightLb, (v) => (item.weightLb = v), { min: 0, step: "any" })),
        field("Активация", textInput(() => item.activation, (v) => (item.activation = v), { placeholder: "1 действие" })),
      ]),
      h("div", { class: "row" }, [
        field("Урон", textInput(() => item.damage, (v) => (item.damage = v), { placeholder: "1к8 рубящий" })),
        field("Класс доспеха", textInput(() => item.armorClass, (v) => (item.armorClass = v), { placeholder: "14 + Лов (макс 2)" })),
      ]),
      field("Свойства", textInput(() => item.properties, (v) => (item.properties = v), { placeholder: "лёгкое, фехтовальное" })),
      field("Заряды", textInput(() => item.charges, (v) => (item.charges = v), { placeholder: "3 заряда, 1к3 на рассвете" })),
    ])
  );

  // ---- изменения, которые даёт НАДЕТЫЙ предмет (см. domain.Modifier) ----
  root.appendChild(
    h("div", { class: "section" }, [
      h("h3", { text: "Изменения, пока предмет надет" }),
      renderModifierEditor(item.modifiers, scheduleSave, {
        hint:
          "Лист персонажа применяет это, когда предмет отмечен «надет» в инвентаре: КД, скорость, характеристики. Поле «Класс доспеха» выше — текстовая формулировка целиком («14 + Лов (макс 2)»), а тут — та её часть, которую приложение умеет посчитать; заполнять оба не обязательно.",
      }),
    ])
  );

  // ---- описание ----
  root.appendChild(mdBlock("Описание", () => item.description, (v) => (item.description = v)));

  // ---- импорт из Foundry VTT ----
  root.appendChild(importSection());
}

// ==================== read-режим (по умолчанию) ====================

function lineIf(label, value) {
  const v = (value ?? "").toString().trim();
  if (!v) return null;
  return h("div", { class: "ib-line" }, [h("strong", { text: label + " " }), v]);
}

function attunementText(it) {
  if (!it.requiresAttunement) return "";
  return it.attunementNote ? `требуется настройка (${it.attunementNote})` : "требуется настройка";
}

function readHeader() {
  const portrait = item.imageUrl
    ? h("img", { class: "ib-portrait", src: item.imageUrl })
    : null;
  const subtitleBits = [item.type, item.rarity].filter(Boolean).join(", ");
  const pills = [...(item.source ? [item.source] : []), ...item.tags].map((t) => h("span", { class: "ib-tag-pill", text: t }));
  const text = h("div", { class: "ib-header-text" }, [
    h("h2", { class: "ib-name", text: item.name || "Без имени" }),
    h("div", { class: "ib-subtitle", text: subtitleBits }),
    pills.length ? h("div", { class: "ib-tags" }, pills) : null,
  ]);
  return portrait ? h("div", { class: "ib-header" }, [portrait, text]) : text;
}

function readInfoGrid() {
  const wrap = h("div", { class: "ib-info" });
  const add = (label, value) => {
    const line = lineIf(label, value);
    if (line) wrap.appendChild(line);
  };
  add("Настройка:", attunementText(item));
  add("Стоимость:", item.cost);
  add("Вес:", item.weight);
  add("Вес (число):", item.weightLb ? item.weightLb + " фнт" : "");
  add("Активация:", item.activation);
  add("Урон:", item.damage);
  add("Класс доспеха:", item.armorClass);
  add("Свойства:", item.properties);
  add("Заряды:", item.charges);
  for (const m of item.modifiers) add("Пока надет:", describeModifier(m));
  return wrap;
}

function renderReadView(root) {
  root.appendChild(readHeader());
  root.appendChild(h("div", { class: "ib-hr" }));
  const info = readInfoGrid();
  root.appendChild(info);
  enhanceRolls(info, sendRoll); // формула урона и т.п. в этих строках — кликабельная

  const desc = item.description && item.description.trim();
  if (desc) {
    root.appendChild(h("div", { class: "ib-hr" }));
    const body = h("div", { class: "ib-prose" });
    body.innerHTML = renderNoteHtml(item.description);
    enhanceRolls(body, sendRoll);
    wireCatalogLinks(body);
    root.appendChild(h("div", { class: "ib-block" }, [h("h3", { class: "ib-section-title", text: "Описание" }), body]));
  }
}

function tagsField() {
  const wrap = h("div", {});
  const list = h("div", { class: "tag-list" });
  function renderTags() {
    list.innerHTML = "";
    item.tags.forEach((tag, i) => {
      list.appendChild(
        h("span", { class: "tag-pill" }, [tag, h("button", { type: "button", html: icon("close", { size: 11 }), onclick: () => { item.tags.splice(i, 1); scheduleSave(); renderTags(); } })])
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
  });
  wrap.append(field("Теги", input), list);
  return wrap;
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
  return h("div", { class: "section", id: "importSection" }, [
    h("h3", { text: "Импорт из Foundry VTT" }),
    h("p", { class: "hint" }, "Экспортируй предмет (оружие/доспех/чудесный предмет и т.п.) из Foundry VTT в JSON и выбери файл ниже (или вставь содержимое текстом). У предметов ttg.club, в отличие от заклинаний/существ, своей кнопки экспорта нет. Поля карточки заменятся тем, что удастся разобрать из файла."),
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
    item = normalizeItem(await updateItem(itemId, item));
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
  rollWS.send({ type: "roll_dice", formula, label: fullLabel });
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
  ensureModifierEditorCSS();
  await loadModifierTargets(); // справочник целей для таблицы «Изменения»
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
