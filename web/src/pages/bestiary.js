// Карточка бестиария ДМ — отдельное окно, открывается из dm.html (панель
// "Бестиарий" или "📖 Статблок" в контекстном меню токена), по аналогии с
// character-sheet.js/note-window.js (тот же приём: плавающее окно =
// floating-window.js, тот же h()/textInput/... DOM-конструктор).
//
// "Умный бланк" — сервер (internal/domain/monster.go) не знает правил D&D,
// только хранит присланный JSON. Единственная посчитанная здесь на клиенте
// величина — модификатор характеристики (та же формула, что и в
// character-sheet.js: floor((score-10)/2)).
import { fetchMe, fetchMonster, createMonster, updateMonster, deleteMonster, uploadFile, fetchSpells } from "../api.js";
import { mergeInPlace } from "../merge-in-place.js";
import { openSocket } from "../ws-reconnect.js";
import { renderNoteHtml } from "../notes/markdown.js";
import { mapFoundryMonsterJson } from "../monster-import.js";
import { enhanceRolls } from "../inline-rolls.js";
import { wireCatalogLinks } from "../catalog-links.js";
import { icon } from "../icons.js";
import { initItemPicker } from "../item-picker.js";
import { showAlert, showConfirm } from "../modal.js";
import { createRollLog } from "../roll-log.js";
import { isGM } from "../roles.js";
import { initFullscreenButton } from "../fullscreen.js";
import { inApp } from "../native-app.js";
import { el as hh, labeled, ornament, renderHero, fold, renderBody } from "../card-shell.js";
import { glyphNode } from "../condition-glyphs.js";
import { monsterGlyphName, renderMonsterPreview } from "../monster-block.js";
import { cssUrl } from "../html.js";
import { withRollMode } from "../roll-mode.js";
import { announceOwnHeader } from "../embed.js";
import { formatWeight, loadSystemProfile, sheetKind } from "../system-profile.js";
import { loadSchemas, schemaFor } from "../schemas.js";
import { compileSchema } from "../schema-formula.js";
import { cardBody, cardHead, cardSubtitle, renderSchemaCard } from "../schema-card.js";
import { coreSummary } from "../schema-summary.js";

// ==================== state ====================

let monsterId = null;
let monster = null; // объект domain.Monster целиком (сервер отдаёт camelCase — см. json-теги)
let rollWS = null;
let rollLog = null; // общий виджет лога бросков (см. web/src/roll-log.js)
// editMode — по умолчанию карточка открывается в чистом read-режиме (как
// статблок в Foundry), редактирование — по явному клику на ✎ (см.
// editToggleBtn ниже), тот же приём, что у заметок ДМ (note-window.js:
// editing/editToggleBtn). Пустая карточка, созданная кнопкой "+" в панели,
// открывается сразу в edit — см. boot(): ?edit=1.
let editMode = false;

function normalizeMonster(raw) {
  const m = raw && typeof raw === "object" ? raw : {};
  m.abilities = m.abilities || {};
  for (const key of ["str", "dex", "con", "int", "wis", "cha"]) if (!m.abilities[key]) m.abilities[key] = 10;
  m.tags = Array.isArray(m.tags) ? m.tags : [];
  m.spells = Array.isArray(m.spells) ? m.spells : [];
  // inventory — шаблон добычи монстра (см. domain.InventoryEntry) — список
  // предметов каталога, снимаемый в Token.Loot убитого токена (см. план
  // фичи/service.Room.snapshotTokenSpoils).
  m.inventory = Array.isArray(m.inventory) ? m.inventory : [];
  return m;
}

// tmpInventoryId — id для НОВОЙ строки инвентаря монстра, добавленной прямо
// тут в редакторе (сервер при сохранении карточки не проверяет уникальность
// ID записей — целиком доверяет клиенту, как и остальным полям "умного
// бланка"; настоящие устойчивые ID запись получает только при снимке в
// Token.Loot в момент смерти монстра, см. service.Room.snapshotTokenSpoils).
function tmpInventoryId() {
  return "tmp-" + Math.random().toString(36).slice(2);
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

// textBlock — свёрнутый блок текста статблока («Описание»):
// в редакторе textarea markdown/HTML, в чтении — рендер с кликабельными
// формулами (см. inline-rolls.js). Пустой в чтении не показывается.
function textBlock(title, key, { open, readOnly } = {}) {
  const get = () => monster[key] || "";
  if (readOnly) {
    const text = get();
    if (!text.trim()) return null;
    const body = h("div", { class: "mb-prose" });
    body.innerHTML = renderNoteHtml(text);
    enhanceRolls(body, sendRoll);
    wireCatalogLinks(body);
    return fold({ title, body: [body], open: open !== false });
  }
  const t = h("textarea", { "aria-label": title, style: "min-height:110px" });
  t.value = monster[key] ?? "";
  t.addEventListener("input", () => {
    monster[key] = t.value;
    scheduleSave();
    f.setSummary(summary());
  });
  const summary = () => (monster[key] ? String(monster[key]).replace(/\*\*/g, "").replace(/<[^>]+>/g, "").slice(0, 80) : "пусто");
  const f = fold({ title, summary: summary(), body: [t], open });
  return f;
}

// ==================== рендер ====================

// renderApp — диспетчер: read-режим (по умолчанию, см. editMode) или полная
// форма редактирования. Обе ветки просто наполняют один и тот же #app.
function renderApp() {
  const root = document.getElementById("app");
  root.innerHTML = "";
  renderSchemaView(root, monsterSchema());
}

// compiledMonster — схема существа системы мира, разобранная один раз.
let compiledMonster = null;
function monsterSchema() {
  const s = schemaFor("monster");
  if (!compiledMonster || compiledMonster.schema !== s) compiledMonster = compileSchema(s);
  return compiledMonster;
}

// artField — «Арт»: загрузить токен-арт или убрать его; onArt() — после
// смены (обновить шапку и превью).
function artField(onArt) {
  const upload = h("input", { type: "file", accept: "image/*", style: "display:none" });
  upload.addEventListener("change", async () => {
    const file = upload.files[0];
    if (!file) return;
    try {
      const { url } = await uploadFile(file, "tokens");
      monster.imageUrl = url;
      scheduleSave();
      artBtn.textContent = "Убрать арт";
      onArt();
    } catch (err) {
      showAlert("Не удалось загрузить арт: " + err.message);
    }
  });
  const artBtn = h("button", {
    type: "button",
    text: monster.imageUrl ? "Убрать арт" : "Загрузить токен-арт…",
    onclick: () => {
      if (monster.imageUrl) {
        monster.imageUrl = "";
        scheduleSave();
        artBtn.textContent = "Загрузить токен-арт…";
        onArt();
      } else upload.click();
    },
  });
  return h("div", { class: "field" }, [h("span", { text: "Арт" }), artBtn, upload]);
}

// compatFold — «Совместимость и источник»: в правке — источник, модуль
// Foundry, теги и «можно призывать»; в чтении — строка, если есть что
// показать. onPills() — теги или источник поменялись.
function compatFold(readOnly, onPills) {
  const compatSummary = () => [monster.source, monster.foundryModuleId].filter(Boolean).join(" · ");
  if (readOnly) {
    const compat = compatSummary();
    return compat ? fold({ title: "Совместимость и источник", summary: compat, body: [h("p", { class: "card-text", text: compat })] }) : null;
  }
  const f = fold({
    title: "Совместимость и источник",
    summary: compatSummary() || "источник, теги, модуль Foundry",
    body: [
      h("div", { class: "card-grid2" }, [
        labeled("Источник", textInput(() => monster.source, (v) => { monster.source = v; onPills(); f.setSummary(compatSummary() || "источник, теги, модуль Foundry"); }, { placeholder: "MM'24" })),
        labeled("Модуль Foundry", textInput(() => monster.foundryModuleId, (v) => { monster.foundryModuleId = v; f.setSummary(compatSummary() || "источник, теги, модуль Foundry"); }, { placeholder: "dnd5e.monsters" }), "Откуда импортировано — чтобы повторный импорт нашёл карточку."),
      ]),
      tagsField(onPills),
      summonableField(),
    ],
  });
  return f;
}

// renderSchemaView — карточка по схеме системы (schema-card.js): шапка,
// середина — из схемы, «Описание» и «Совместимость» — как обычно. Превью
// «На карте и в трекере» — по общим полям ядра схемы; импорт Foundry — у
// D&D-миров.
function renderSchemaView(root, compiled) {
  const readOnly = !editMode;
  const subtitle = h("div", { class: "card-sub", text: cardSubtitle(compiled, monster) });
  const fallbackGlyph = () => monsterGlyphName(monster);
  const head = cardHead(compiled, monster, fallbackGlyph());
  const refreshHead = () => {
    const next = cardHead(compiled, monster, fallbackGlyph());
    subtitle.textContent = cardSubtitle(compiled, monster);
    hero.setGlyph(next.glyph, monster.imageUrl);
    hero.setColor(next.color);
    hero.setPills(next.pills);
    preview.update();
  };
  const hero = renderHero({
    glyph: head.glyph,
    imageUrl: monster.imageUrl,
    color: head.color,
    name: monster.name,
    namePlaceholder: "Имя существа",
    pills: head.pills,
    subtitle,
    readOnly,
    controls: readOnly ? undefined : [artField(refreshHead)],
    onName: (v) => {
      monster.name = v;
      document.getElementById("monsterTitle").textContent = v || "Без имени";
      scheduleSave();
      preview.update();
    },
  });
  root.appendChild(hero.el);
  root.appendChild(ornament());
  const preview = renderMonsterPreview(monster, {
    glyphNode,
    numbers: () => {
      const c = coreSummary(compiled, monster, []);
      return { ini: c.initiative, ac: c.ac || "—", hp: c.hpMax || "—" };
    },
  });
  const middle = renderSchemaCard({
    compiled,
    data: monster,
    readOnly,
    scheduleSave,
    onChange: refreshHead,
    sendRoll,
    widgets: { inventory: () => invSection(readOnly), spells: () => spellsSection(readOnly) },
  });
  const folds = [...middle, textBlock("Описание", "description", readOnly ? { readOnly: true, open: false } : {}), compatFold(readOnly, refreshHead)];
  if (!readOnly && sheetKind() !== "universal") folds.push(importSection());
  root.appendChild(renderBody(cardBody(folds), [preview]));
}

// applyImport — общая точка для файла и вставленного текста: парсит JSON,
// мапит через mapFoundryMonsterJson (см. web/src/monster-import.js), мержит
// результат в monster (переписывает только пришедшие поля — существующие
// теги монстра, которых импорт не касается, сохраняются; заклинания не
// перезаписываются, а дополняются, см. mergeSpellRefs) и перерисовывает
// карточку целиком, тем же приёмом, что и у карточки заклинания (см.
// web/src/pages/spellbook.js: applyImport).
function applyImport(rawText, msgEl) {
  msgEl.classList.remove("error", "ok");
  msgEl.textContent = "";
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    msgEl.textContent = "Не удалось разобрать JSON — проверь, что это файл экспорта существа.";
    msgEl.classList.add("error");
    return;
  }
  let mapped;
  try {
    mapped = mapFoundryMonsterJson(parsed);
  } catch (err) {
    msgEl.textContent = err.message;
    msgEl.classList.add("error");
    return;
  }
  // Заклинания — единственное поле, которое импорт не перезаписывает, а
  // дополняет: список мог быть собран руками из панели «Заклинания» ДМ.
  mapped.spells = mergeSpellRefs(monster.spells, mapped.spells);
  Object.assign(monster, mapped);
  document.getElementById("monsterTitle").textContent = monster.name || "Без имени";
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
    summary: "JSON-экспорт существа",
    body: [
      h("p", { class: "card-note" }, "На странице существа на 5e14.ttg.club нажми «Экспорт для FVTT» и сохрани JSON-файл — выбери его ниже (или вставь содержимое текстом). Поля карточки заменятся тем, что удастся разобрать из файла; уже добавленные заклинания и теги не трогаются."),
      labeled("Файл экспорта", fileInput),
      textarea,
      importBtn,
      msg,
    ],
  });
}

function spellLevelLabel(lvl) {
  return lvl ? lvl + "-й круг" : "Заговор";
}

// spellIndex — карточки библиотеки по имени. Импорт статблока spellId
// проставить не может (см. buildSpellRefs в monster-import.js): у актёра
// своя копия заклинания, с карточкой она сходится только названием.
let spellIndex = new Map();

function spellKey(name) {
  return String(name || "").trim().toLowerCase();
}
// spellBareKey — имя без хвоста "[English]": в каталоге «Свет [Light]»,
// вписанное руками — обычно «Свет».
function spellBareKey(name) {
  return spellKey(String(name || "").replace(/\s*\[[^\]]*\]\s*$/, ""));
}

// loadSpellIndex — один запрос на открытие карточки. Ошибка не должна ронять
// статблок: без индекса имена заклинаний просто останутся обычным текстом.
async function loadSpellIndex() {
  const list = await fetchSpells().catch(() => []);
  spellIndex = new Map();
  for (const sp of list) {
    const name = String(sp.name || "").trim();
    if (!name || !sp.id) continue;
    for (const key of [spellKey(name), spellBareKey(name)]) {
      if (!spellIndex.has(key)) spellIndex.set(key, sp.id);
    }
  }
}

// spellRefId — id карточки для строки списка: сохранённый (заклинание
// добавили из панели «Заклинания» ДМ) или найденный по имени.
function spellRefId(ref) {
  return ref.spellId || spellIndex.get(spellKey(ref.name)) || spellIndex.get(spellBareKey(ref.name)) || "";
}

// mergeSpellRefs — импорт дописывает к списку, а не затирает его: часть строк
// ДМ собрал руками, и у них проставлен spellId.
function mergeSpellRefs(existing, incoming) {
  const out = (existing || []).slice();
  const seen = new Set(out.map((r) => spellKey(r.name)));
  for (const ref of incoming || []) {
    const key = spellKey(ref.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

// spellsSection — список заклинаний монстра (domain.MonsterSpellRef).
// Заполняется импортом статблока (см. buildSpellRefs в monster-import.js) и
// панелью "Заклинания" ДМ (там виден весь стол и выбор целей сразу); здесь
// можно только посмотреть карточку и (в редактировании) убрать заклинание из
// списка — readOnly скрывает ✕, читает то же самое, чем пользуется
// read-режим (renderReadView).
function spellsSection(readOnly) {
  const list = h("div", { class: "mb-refs" });
  function renderList() {
    list.innerHTML = "";
    if (monster.spells.length === 0) {
      if (readOnly) return; // read-режим не занимает место под пустой список — как остальные пустые блоки
      list.appendChild(h("p", { class: "card-note", text: "Заклинаний нет — добавь их из панели «Заклинания» ДМ." }));
      return;
    }
    monster.spells.forEach((ref, i) => {
      const name = h("span", { class: "nm", text: ref.name });
      const spellId = spellRefId(ref);
      if (spellId) {
        name.classList.add("clickable");
        name.title = "Открыть карточку заклинания";
        // bestiary.js уже сам живёт внутри плавающего окна (floating-window.js
        // рендерит его в iframe) — вкладывать туда ещё один плавающий менеджер
        // окон незачем, поэтому просто открываем обычной вкладкой браузера
        // (тот же приём, что popoutBtn в floating-window.js).
        const url = `/spellbook.html?id=${spellId}`;
        name.onclick = () => (inApp ? location.assign(url) : window.open(url, "spell-" + spellId));
      }
      const row = [name, h("span", { class: "tag", text: spellLevelLabel(ref.level) })];
      if (!readOnly) {
        row.push(h("button", { type: "button", html: icon("close", { size: 11 }), "aria-label": "Убрать из списка", onclick: () => { monster.spells.splice(i, 1); scheduleSave(); renderList(); f.setSummary(summary()); } }));
      }
      list.appendChild(h("div", { class: "mb-ref" }, row));
    });
  }
  renderList();
  if (readOnly && monster.spells.length === 0) return null; // ничего показывать не нужно
  const summary = () => (monster.spells.length ? monster.spells.map((r) => r.name).join(", ") : "нет");
  const f = fold({ title: "Заклинания", summary: readOnly ? "" : summary(), body: [list], open: readOnly });
  return f;
}

// invSection — шаблон добычи монстра (domain.Monster.Inventory, см. план
// фичи). В отличие от spellsSection, добавление тут же, в редакторе (через
// item-picker.js) — не в отдельной панели ДМ, каталог предметов не тащит за
// собой того же "кому назначить"/выбора цели, что у заклинаний.
function invSection(readOnly) {
  const list = h("div", { class: "mb-refs" });
  function renderList() {
    list.innerHTML = "";
    if (monster.inventory.length === 0) {
      if (readOnly) return; // read-режим не занимает место под пустой список
      list.appendChild(h("p", { class: "card-note", text: "Инвентарь пуст — добавь предметы из каталога ниже." }));
      return;
    }
    monster.inventory.forEach((e, i) => {
      const avatar = h("div", { class: "av" });
      if (e.imageUrl) avatar.style.backgroundImage = cssUrl(e.imageUrl);
      const name = h("span", { class: "nm", text: e.name });
      const weight = h("span", { class: "tag", text: formatWeight(e.weightLb) });
      const row = [avatar, name, weight];
      if (readOnly) {
        row.push(h("span", { class: "tag", text: "×" + e.quantity }));
      } else {
        const qty = h("input", { type: "number", min: "0", value: String(e.quantity), "aria-label": "Количество" });
        qty.addEventListener("change", () => {
          e.quantity = parseInt(qty.value, 10) || 0;
          scheduleSave();
        });
        row.push(qty);
        row.push(
          h("button", {
            type: "button",
            html: icon("close", { size: 11 }),
            "aria-label": "Убрать из списка",
            onclick: () => {
              monster.inventory.splice(i, 1);
              scheduleSave();
              renderList();
              block.setSummary(summary());
            },
          })
        );
      }
      list.appendChild(h("div", { class: "mb-ref" }, row));
    });
  }
  renderList();
  if (readOnly && monster.inventory.length === 0) return null;

  const summary = () => (monster.inventory.length ? monster.inventory.map((e) => e.name).join(", ") : "нет");
  const block = fold({ title: "Инвентарь (лут)", summary: readOnly ? "" : summary(), body: [list], open: readOnly });
  if (!readOnly) {
    const pickerWrap = h("div", { style: "margin-top:8px;" });
    block.querySelector(".card-fold-body").appendChild(pickerWrap);
    initItemPicker(pickerWrap, {
      onPick: (item, qty) => {
        const existing = monster.inventory.find((x) => x.itemId === item.id);
        if (existing) existing.quantity += qty;
        else
          monster.inventory.push({
            id: tmpInventoryId(),
            itemId: item.id,
            name: item.name,
            imageUrl: item.imageUrl,
            weightLb: item.weightLb || 0,
            quantity: qty,
          });
        scheduleSave();
        renderList();
        block.setSummary(summary());
      },
    });
  }
  return block;
}

// summonableField — «Можно призывать» (см. domain.Monster.Summonable):
// игрок увидит существо в панели «Призыв» и сможет попросить его на карту.
function summonableField() {
  const cb = h("input", { type: "checkbox", class: "switch" });
  cb.checked = !!monster.summonable;
  cb.addEventListener("change", () => {
    monster.summonable = cb.checked;
    scheduleSave();
  });
  const label = h("label", {}, [cb, " Можно призывать — игрок может попросить это существо на карту (фамильяр, зверь для призыва); ДМ подтверждает каждый раз. Не нужно, если в настройках стола включено «любых существ библиотеки»"]);
  return h("div", { class: "checkbox-row" }, [label]);
}

function tagsField(onChange) {
  const list = h("div", { class: "card-chips" });
  function renderTags() {
    list.innerHTML = "";
    monster.tags.forEach((tag, i) => {
      list.appendChild(h("span", { class: "card-chip" }, [tag, h("button", { type: "button", html: icon("close", { size: 11 }), "aria-label": "Убрать тег", onclick: () => { monster.tags.splice(i, 1); scheduleSave(); renderTags(); onChange(); } })]));
    });
  }
  renderTags();
  const input = h("input", { type: "text", placeholder: "тег + Enter" });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const v = input.value.trim();
    if (!v) return;
    monster.tags.push(v);
    input.value = "";
    scheduleSave();
    renderTags();
    onChange();
  });
  return h("div", {}, [labeled("Теги", input), list]);
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
    mergeInPlace(monster, normalizeMonster(await updateMonster(monsterId, monster)));
    setSaveStatus("saved");
    // Панель "Бестиарий" в dm.html кэширует список (обновляется только при
    // открытии панели) — без этого пинга её карточка/токен-арт оставались бы
    // видимо устаревшими, пока DM не закроет и не откроет панель заново.
    // window.parent === window, если лист вынесен кнопкой 🗗 в отдельное
    // окно браузера — тогда обновлять нечего, молча пропускаем.
    if (window.parent !== window) {
      window.parent.postMessage({ type: "beacon:monsterSaved", id: monsterId }, location.origin);
    }
  } catch (err) {
    dirty = true;
    setSaveStatus("error", err.message);
  }
}

window.addEventListener("beforeunload", () => {
  if (dirty) doSave(); // best-effort, как в character-sheet.js
});

// ==================== dice rolls ====================
// Бестиарий — инструмент только ДМ (см. dm.html), поэтому сокет всегда /ws/dm
// (в отличие от character-sheet.js, где ещё бывает роль игрока).

function connectRollSocket() {
  if (!rollLog) rollLog = createRollLog(document.getElementById("rollLogWrap"), { layout: "strip" });
  // Сокет с переподключением (см. web/src/ws-reconnect.js): без него обрыв
  // связи выглядел бы как «кубик перестал кидаться», без единого признака
  // на экране — сюда приходят только ответы на броски, и заметить нечего.
  rollWS = openSocket("/ws/dm", {
    onMessage: (data) => {
      if (data.type === "roll_result") rollLog.push(data);
    },
  });
}

function sendRoll(formula, label) {
  if (!rollWS) return;
  const fullLabel = monster && monster.name ? `${monster.name} — ${label || ""}`.trim().replace(/ —$/, "") : label;
  rollWS.send(withRollMode({ type: "roll_dice", formula, label: fullLabel }));
}

// ==================== boot ====================

// editToggleBtn — тот же приём, что editToggleBtn в note-window.js: "✎" в
// read-режиме предлагает включить редактирование, "👁" в edit-режиме —
// вернуться к чистому просмотру.
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

// cloneBtn — карточки каталога "из коробки" (monster.system, см.
// internal/repository/monsterfile/system.go) нельзя редактировать/удалять
// (сервер отдаёт 403 — см. monsterfile.Catalog.Update/Delete), поэтому
// вместо ✎ показываем это и кнопку "Клонировать": создаёт обычную
// (пользовательскую) карточку с теми же полями и переключает окно на неё.
const cloneBtn = document.getElementById("cloneBtn");
cloneBtn.onclick = async () => {
  cloneBtn.disabled = true;
  try {
    const created = await createMonster(monster.name || "Без имени");
    const copy = Object.assign({}, monster, { id: created.id, system: false });
    await updateMonster(created.id, copy);
    if (window.parent !== window) {
      window.parent.postMessage({ type: "beacon:monsterSaved", id: created.id }, location.origin);
    }
    // Переоткрываем это же окно уже на копии, сразу в редактировании — то же
    // самое, что видит ДМ после создания монстра с нуля (см. dm.js: newMonsterForm).
    location.href = `/bestiary.html?id=${created.id}&edit=1`;
  } catch (err) {
    showAlert("Не удалось клонировать: " + err.message);
  } finally {
    cloneBtn.disabled = false;
  }
};

// deleteBtn — тот же приём, что и в itembook.js/spellbook.js: подтверждение,
// DELETE, сообщить панели "Бестиарий" (beacon:monsterSaved — refresh() в
// pages/catalog.js просто перезапросит список) и закрыть окно. Тот же текст
// предупреждения о токенах, что и в cfg.deleteConfirm списка (pages/catalog.js).
const deleteBtn = document.getElementById("deleteBtn");
deleteBtn.onclick = async () => {
  const okDelete = await showConfirm(`Удалить «${monster.name || "Без имени"}» из бестиария?`, {
    title: "Удалить монстра",
    okLabel: "Удалить",
    danger: true,
    hint: "Это необратимо. Уже расставленные токены останутся на карте, но перестанут открывать статблок.",
  });
  if (!okDelete) return;
  deleteBtn.disabled = true;
  try {
    await deleteMonster(monsterId);
    if (window.parent !== window) {
      window.parent.postMessage({ type: "beacon:monsterSaved", id: monsterId }, location.origin);
      window.parent.postMessage({ type: "beacon:closeFloatingWindow" }, location.origin);
    } else {
      window.close();
    }
  } catch (err) {
    showAlert("Не удалось удалить: " + err.message);
    deleteBtn.disabled = false;
  }
};

initFullscreenButton(document.getElementById("fullscreenBtn"));

// Своя шапка с ✕ — рамке на телефоне своя не нужна (см. embed.js).
announceOwnHeader();
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

function currentId() {
  return new URLSearchParams(location.search).get("id");
}

(async function boot() {
  const me = await fetchMe();
  await Promise.all([loadSystemProfile(), loadSchemas()]);
  if (!me) {
    location.href = "/";
    return;
  }
  // Игрок открывает карточку своего призванного существа (см. api/http:
  // handleMonsterGet) — только чтение: правка, удаление и клон спрятаны.
  const readOnlyViewer = !isGM(me.role);
  monsterId = currentId();
  if (!monsterId) {
    document.getElementById("loadingHint").textContent = "Не указан id монстра (?id=...).";
    return;
  }
  try {
    monster = normalizeMonster(await fetchMonster(monsterId));
  } catch (err) {
    document.getElementById("loadingHint").textContent = "Не удалось загрузить монстра: " + err.message;
    return;
  }

  document.getElementById("monsterTitle").textContent = monster.name || "Без имени";
  if (readOnlyViewer) {
    editMode = false;
    editToggleBtn.style.display = "none";
    deleteBtn.style.display = "none";
  } else if (monster.system) {
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
    document.getElementById("monsterTitle").after(pill);
  } else {
    // ?edit=1 — только что созданная пустая карточка (см. dm.js: newMonsterForm)
    // открывается сразу в редактировании, смотреть там всё равно не на что.
    editMode = new URLSearchParams(location.search).get("edit") === "1";
  }
  updateEditToggleBtn();
  // Библиотека заклинаний — чтобы имена в блоке «Заклинания» стали ссылками
  // на карточки (см. spellRefId).
  await loadSpellIndex();
  renderApp();

  document.getElementById("loadingHint").style.display = "none";
  document.getElementById("app").classList.add("ready");

  connectRollSocket();
})();
