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
import { mergeInPlace } from "../merge-in-place.js";
import { icon } from "../icons.js";
import { renderNoteHtml } from "../notes/markdown.js";
import { mapFoundryReferenceBatch } from "../reference-import.js";
import { wireCatalogLinks } from "../catalog-links.js";
import { showAlert, showConfirm } from "../modal.js";
import { initFullscreenButton } from "../fullscreen.js";
import { el as hh, labeled, ornament, renderHero, fold, renderBody } from "../card-shell.js";
import { announceOwnHeader } from "../embed.js";
import { loadSchemas, schemaFor } from "../schemas.js";
import { compileSchema } from "../schema-formula.js";
import { cardBody, cardHead, cardSubtitle, renderSchemaCard } from "../schema-card.js";
import { loadSystemProfile, sheetKind } from "../system-profile.js";

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

// ==================== рендер ====================

let compiledReference = null;
function renderApp() {
  const root = document.getElementById("app");
  root.innerHTML = "";
  const s = schemaFor("reference");
  if (!compiledReference || compiledReference.schema !== s) compiledReference = compileSchema(s);
  renderSchemaView(root, compiledReference);
}

// sheetPreview — «На листе персонажа»: поле листа, которое подсказывает
// записи этого вида (suggest в схеме листа); null — такого поля нет.
function sheetPreview() {
  const kind = String(reference.kind || "").trim().toLowerCase();
  const sheet = schemaFor("sheet");
  const field = kind && sheet && Object.values(sheet.fields).find((f) => f.suggest && String(f.suggest.reference).toLowerCase() === kind);
  if (!field) return null;
  const box = h("div", { class: "rp" });
  box.update = () => {
    box.innerHTML = "";
    box.append(
      h("span", { class: "card-lbl", text: "На листе персонажа" }),
      h("div", { class: "rp-field" }, [h("span", { class: "rp-fl", text: field.label }), h("div", { class: "rp-fv" }, [h("span", { text: reference.name || "Без имени" }), h("span", { html: icon("chevron-down", { size: 12 }) })])]),
      h("span", { class: "card-aside-note", text: "Игрок выберет эту запись в поле листа, а описание появится подсказкой рядом." })
    );
  };
  box.update();
  return box;
}

// artField — «Арт»: загрузить свою иконку или убрать её; onArt() — после
// смены (обновить шапку).
function artField(onArt) {
  const upload = h("input", { type: "file", accept: "image/*", style: "display:none" });
  upload.addEventListener("change", async () => {
    const file = upload.files[0];
    if (!file) return;
    try {
      const { url } = await uploadFile(file, "tokens");
      reference.imageUrl = url;
      scheduleSave();
      artBtn.textContent = "Убрать арт";
      onArt();
    } catch (err) {
      showAlert("Не удалось загрузить иконку: " + err.message);
    }
  });
  const artBtn = h("button", {
    type: "button",
    text: reference.imageUrl ? "Убрать арт" : "Загрузить свой…",
    onclick: () => {
      if (reference.imageUrl) {
        reference.imageUrl = "";
        scheduleSave();
        artBtn.textContent = "Загрузить свой…";
        onArt();
      } else upload.click();
    },
  });
  return h("div", { class: "field" }, [h("span", { text: "Арт" }), artBtn, upload]);
}

// compatFold — «Совместимость и источник» (см. bestiary.js: compatFold).
function compatFold(readOnly, onPills) {
  const compatSummary = () => [reference.source, reference.foundryModuleId].filter(Boolean).join(" · ");
  if (readOnly) {
    const compat = compatSummary();
    return compat ? fold({ title: "Совместимость и источник", summary: compat, body: [h("p", { class: "card-text", text: compat })] }) : null;
  }
  const empty = "источник, теги, модуль Foundry";
  const f = fold({
    title: "Совместимость и источник",
    summary: compatSummary() || empty,
    body: [
      h("div", { class: "card-grid2" }, [
        labeled("Источник", textInput(() => reference.source, (v) => { reference.source = v; onPills(); f.setSummary(compatSummary() || empty); }, { placeholder: "PHB'24" })),
        labeled("Модуль Foundry", textInput(() => reference.foundryModuleId, (v) => { reference.foundryModuleId = v; f.setSummary(compatSummary() || empty); }, { placeholder: "dnd5e.classes" }), "Откуда импортирована — чтобы повторный импорт нашёл запись."),
      ]),
      tagsField(onPills),
    ],
  });
  return f;
}

// renderSchemaView — запись по схеме системы (schema-card.js): шапка без
// видов записей D&D, поля — из схемы, описание — как обычно. Превью «На
// листе персонажа» и импорт — только у карточки D&D.
function renderSchemaView(root, compiled) {
  const readOnly = !editMode;
  const subtitle = h("div", { class: "card-sub", text: cardSubtitle(compiled, reference) });
  const head = cardHead(compiled, reference, "scroll");
  const refreshHead = () => {
    const next = cardHead(compiled, reference, "scroll");
    subtitle.textContent = cardSubtitle(compiled, reference);
    hero.setGlyph(next.glyph, reference.imageUrl);
    hero.setColor(next.color);
    hero.setPills(next.pills);
  };
  const hero = renderHero({
    glyph: head.glyph,
    imageUrl: reference.imageUrl,
    color: head.color,
    name: reference.name,
    namePlaceholder: "Название записи",
    pills: head.pills,
    square: true,
    subtitle,
    readOnly,
    controls: readOnly ? undefined : [artField(refreshHead)],
    onName: (v) => {
      reference.name = v;
      document.getElementById("refTitle").textContent = v || "Без имени";
      scheduleSave();
    },
  });
  root.appendChild(hero.el);
  root.appendChild(ornament());
  const preview = sheetPreview();
  const middle = renderSchemaCard({
    compiled,
    data: reference,
    readOnly,
    scheduleSave,
    onChange: () => {
      refreshHead();
      preview?.update();
    },
    sendRoll: null,
    widgets: {},
  });
  let desc;
  if (readOnly) {
    desc = h("div", { class: "card-prose card-desc" });
    if (reference.description && reference.description.trim()) {
      desc.innerHTML = renderNoteHtml(reference.description);
      wireCatalogLinks(desc);
    } else desc.appendChild(h("p", { class: "card-note", text: "Описания пока нет." }));
  } else {
    desc = h("div", { class: "card-desc" }, [mdBlock("Описание", () => reference.description, (v) => (reference.description = v))]);
  }
  const folds = [...middle, desc, compatFold(readOnly, refreshHead)];
  if (!readOnly && sheetKind() !== "universal") folds.push(importSection());
  root.appendChild(renderBody(cardBody(folds), preview ? [preview] : null));
}

function tagsField(onChange) {
  const list = h("div", { class: "card-chips" });
  function renderTags() {
    list.innerHTML = "";
    reference.tags.forEach((tag, i) => {
      list.appendChild(h("span", { class: "card-chip" }, [tag, h("button", { type: "button", html: icon("close", { size: 11 }), "aria-label": "Убрать тег", onclick: () => { reference.tags.splice(i, 1); scheduleSave(); renderTags(); onChange(); } })]));
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
    onChange();
  });
  return h("div", {}, [labeled("Теги", input), list]);
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
  return fold({
    title: "Импорт из Foundry VTT",
    summary: "JSON-экспорт записи",
    body: [
      h("p", { class: "card-note" }, "Экспортируй класс/архетип/черту из Foundry VTT (или распакованный пак целиком) в JSON и выбери файл ниже. Поля карточки заменятся тем, что удастся разобрать."),
      labeled("Файл экспорта", fileInput),
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
    mergeInPlace(reference, normalizeReference(await updateReference(referenceId, reference)));
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

initFullscreenButton(document.getElementById("fullscreenBtn"));

// Своя шапка с ✕ — рамке на телефоне своя не нужна (см. embed.js).
announceOwnHeader();
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
  await Promise.all([loadSchemas(), loadSystemProfile()]);
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
