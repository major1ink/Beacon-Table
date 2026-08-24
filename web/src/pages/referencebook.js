// Карточка справочника (класс/архетип/происхождение/вид/черта — см.
// domain.Reference.Kind) — отдельное окно, открывается из dm.html/player.html
// (панель/модалка "Справочник"), по аналогии с itembook.js/spellbook.js/
// bestiary.js (тот же приём: плавающее окно = floating-window.js, тот же
// h()/textInput/... DOM-конструктор). В отличие от itembook.js — нет
// числовых полей с кнопкой броска (справочник не про боевую механику), поэтому
// нет ни WS-сокета, ни enhanceRolls.
//
// "Умный бланк" — сервер (internal/domain/reference.go) не знает правил
// D&D, только хранит присланный JSON. Импорт — разбор пака Foundry VTT
// целиком в web/src/reference-import.js (чистая функция, батчевая — см. её
// комментарий), этот файл только вызывает её и мержит результат.
import { fetchMe, fetchReference, createReference, updateReference, deleteReference, uploadFile } from "../api.js";
import { icon } from "../icons.js";
import { renderNoteHtml } from "../notes/markdown.js";
import { mapFoundryReferenceBatch } from "../reference-import.js";
import { wireCatalogLinks } from "../catalog-links.js";
import { showAlert, showConfirm } from "../modal.js";

// ==================== state ====================

let referenceId = null;
let reference = null; // объект domain.Reference целиком (сервер отдаёт camelCase — см. json-теги)
// editMode — по умолчанию карточка открывается в чистом read-режиме, как у
// Item/Spell/Monster (см. itembook.js и соседей).
let editMode = false;

function normalizeReference(raw) {
  const ref = raw && typeof raw === "object" ? raw : {};
  ref.tags = Array.isArray(ref.tags) ? ref.tags : [];
  return ref;
}

// ==================== DOM helpers (та же схема, что itembook.js) ====================

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

// mdBlock — textarea markdown/HTML слева + живой рендер справа (тот же
// `marked`, что и заметки ДМ/бестиарий/заклинания/предметы).
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
  const portrait = reference.imageUrl
    ? h("img", { class: "portrait-img", src: reference.imageUrl })
    : h("div", { class: "portrait-placeholder", text: "нет иконки" });
  const upload = h("input", { type: "file", accept: "image/*" });
  upload.addEventListener("change", async () => {
    const file = upload.files[0];
    if (!file) return;
    try {
      const { url } = await uploadFile(file, "tokens");
      reference.imageUrl = url;
      scheduleSave();
      renderApp();
    } catch (err) {
      showAlert("Не удалось загрузить иконку: " + err.message);
    }
  });
  root.appendChild(
    h("div", { class: "section" }, [
      h("div", { class: "portrait-wrap" }, [portrait, h("div", { class: "col", style: "flex:1 1 auto;gap:6px;" }, [
        field("Имя", textInput(() => reference.name, (v) => { reference.name = v; document.getElementById("refTitle").textContent = v || "Без имени"; })),
        field("Иконка", upload),
      ])]),
      h("div", { class: "row" }, [
        field("Вид записи", textInput(() => reference.kind, (v) => (reference.kind = v), { placeholder: "класс / архетип / происхождение / вид / черта класса" })),
        field("Родитель", textInput(() => reference.parentName, (v) => (reference.parentName = v), { placeholder: "например «Варвар» — для архетипа" })),
        field("Источник", textInput(() => reference.source, (v) => (reference.source = v), { placeholder: "PHB 2024" })),
      ]),
      tagsField(),
    ])
  );

  root.appendChild(mdBlock("Описание", () => reference.description, (v) => (reference.description = v)));

  root.appendChild(importSection());
}

// ==================== read-режим (по умолчанию) ====================

function readHeader() {
  const portrait = reference.imageUrl
    ? h("img", { class: "ib-portrait", src: reference.imageUrl })
    : null;
  const subtitleBits = [reference.kind, reference.parentName ? "родитель: " + reference.parentName : ""].filter(Boolean).join(", ");
  const pills = [...(reference.source ? [reference.source] : []), ...reference.tags].map((t) => h("span", { class: "ib-tag-pill", text: t }));
  const text = h("div", { class: "ib-header-text" }, [
    h("h2", { class: "ib-name", text: reference.name || "Без имени" }),
    h("div", { class: "ib-subtitle", text: subtitleBits }),
    pills.length ? h("div", { class: "ib-tags" }, pills) : null,
  ]);
  return portrait ? h("div", { class: "ib-header" }, [portrait, text]) : text;
}

function renderReadView(root) {
  root.appendChild(readHeader());

  const desc = reference.description && reference.description.trim();
  if (desc) {
    root.appendChild(h("div", { class: "ib-hr" }));
    const body = h("div", { class: "ib-prose" });
    body.innerHTML = renderNoteHtml(reference.description);
    wireCatalogLinks(body);
    root.appendChild(h("div", { class: "ib-block" }, [h("h3", { class: "ib-section-title", text: "Описание" }), body]));
  }
}

function tagsField() {
  const wrap = h("div", {});
  const list = h("div", { class: "tag-list" });
  function renderTags() {
    list.innerHTML = "";
    reference.tags.forEach((tag, i) => {
      list.appendChild(
        h("span", { class: "tag-pill" }, [tag, h("button", { type: "button", html: icon("close", { size: 11 }), onclick: () => { reference.tags.splice(i, 1); scheduleSave(); renderTags(); } })])
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
    reference.tags.push(v);
    input.value = "";
    scheduleSave();
    renderTags();
  });
  wrap.append(field("Теги", input), list);
  return wrap;
}

// applyImport — общая точка для файла и вставленного текста: парсит JSON
// (один документ ИЛИ массив документов — см. mapFoundryReferenceBatch),
// мапит батчево, но в этой карточке всегда применяет только ПЕРВЫЙ
// результат — редактор здесь один-на-одну-запись, массовый импорт живёт в
// панели "Справочник" (см. pages/dm.js), не в самой карточке.
function applyImport(rawText, msgEl) {
  msgEl.classList.remove("error", "ok");
  msgEl.textContent = "";
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    msgEl.textContent = "Не удалось разобрать JSON.";
    msgEl.classList.add("error");
    return;
  }
  const mapped = mapFoundryReferenceBatch(parsed);
  if (mapped.length === 0) {
    msgEl.textContent = "Не удалось распознать ни одной записи справочника (нужен класс/архетип/черта Foundry VTT).";
    msgEl.classList.add("error");
    return;
  }
  Object.assign(reference, mapped[0]);
  msgEl.textContent = `Импортировано: «${mapped[0].name}».` + (mapped.length > 1 ? ` (В файле было ${mapped.length} записей — применена первая; для массового импорта всех сразу используй панель «Справочник».)` : "");
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
  return h("div", { class: "section", id: "importSection" }, [
    h("h3", { text: "Импорт из Foundry VTT" }),
    h("p", { class: "hint" }, "Экспортируй класс/архетип/черту из Foundry VTT (или распакованный пак целиком) в JSON и выбери файл ниже. Поля карточки заменятся тем, что удастся разобрать."),
    field("Файл экспорта", fileInput),
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
    reference = normalizeReference(await updateReference(referenceId, reference));
    setSaveStatus("saved");
    // Панель "Справочник" в dm.html/player.html кэширует список (обновляется
    // только при открытии) — без этого пинга её строка оставалась бы видимо
    // устаревшей, тот же приём, что beacon:itemSaved у библиотеки предметов.
    if (window.parent !== window) {
      window.parent.postMessage({ type: "beacon:referenceSaved", id: referenceId }, location.origin);
    }
  } catch (err) {
    dirty = true;
    setSaveStatus("error", err.message);
  }
}

window.addEventListener("beforeunload", () => {
  if (dirty) doSave(); // best-effort, как в itembook.js/spellbook.js/bestiary.js
});

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

// cloneBtn — карточки каталога "из коробки" (reference.system, см.
// internal/repository/referencefile/system.go) нельзя редактировать/удалять
// (сервер отдаёт 403), поэтому вместо ✎ показываем это и "Клонировать": та
// же логика, что и в itembook.js/spellbook.js/bestiary.js.
const cloneBtn = document.getElementById("cloneBtn");
cloneBtn.onclick = async () => {
  cloneBtn.disabled = true;
  try {
    const created = await createReference(reference.name || "Без имени");
    const copy = Object.assign({}, reference, { id: created.id, system: false });
    await updateReference(created.id, copy);
    if (window.parent !== window) {
      window.parent.postMessage({ type: "beacon:referenceSaved", id: created.id }, location.origin);
    }
    location.href = `/referencebook.html?id=${created.id}&edit=1`;
  } catch (err) {
    showAlert("Не удалось клонировать: " + err.message);
  } finally {
    cloneBtn.disabled = false;
  }
};

// deleteBtn — тот же приём, что и в itembook.js/spellbook.js/bestiary.js/conditions.js.
const deleteBtn = document.getElementById("deleteBtn");
deleteBtn.onclick = async () => {
  if (!(await showConfirm(`Удалить «${reference.name || "Без имени"}» из библиотеки?`, { title: "Удалить запись", okLabel: "Удалить", danger: true }))) return;
  deleteBtn.disabled = true;
  try {
    await deleteReference(referenceId);
    if (window.parent !== window) {
      window.parent.postMessage({ type: "beacon:referenceSaved", id: referenceId }, location.origin);
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
  referenceId = currentId();
  if (!referenceId) {
    document.getElementById("loadingHint").textContent = "Не указан id записи (?id=...).";
    return;
  }
  try {
    reference = normalizeReference(await fetchReference(referenceId));
  } catch (err) {
    document.getElementById("loadingHint").textContent = "Не удалось загрузить запись: " + err.message;
    return;
  }

  document.getElementById("refTitle").textContent = reference.name || "Без имени";
  if (reference.system) {
    editMode = false;
    editToggleBtn.style.display = "none";
    deleteBtn.style.display = "none";
    cloneBtn.classList.add("visible");
    const pill = document.createElement("span");
    pill.className = "sys-pill";
    pill.title = "Карточка каталога «из коробки» — только для чтения";
    pill.innerHTML = icon("lock", { size: 11 }) + " каталог";
    document.getElementById("refTitle").after(pill);
  } else {
    // ?edit=1 — только что созданная пустая карточка (см. dm.js/player.js)
    // открывается сразу в редактировании.
    editMode = new URLSearchParams(location.search).get("edit") === "1";
  }
  updateEditToggleBtn();
  renderApp();

  document.getElementById("loadingHint").style.display = "none";
  document.getElementById("app").classList.add("ready");
})();
