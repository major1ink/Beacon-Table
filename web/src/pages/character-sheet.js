// Лист персонажа D&D 2024 (PHB 2024, стиль бланка "Long Story Short") —
// отдельное окно, открывается из player.html ("Мои персонажи", кнопка 📜,
// владелец — редактирует) или из dm.html (панель "Персонажи", та же кнопка
// 📜 — ДМ редактирует ЛЮБОЙ лист наравне с владельцем, см. isAdminView
// ниже), по аналогии с note-window.html/note-window.js.
//
// "Умный бланк" (см. README и план реализации): почти все поля — свободный
// ввод, как в бумажном листе. Автоматически считаются только производные
// значения по формулам PHB 2024 — весь rules-блок ниже (abilityMod..spellAtk).
// Сервер (internal/domain/character_sheet.go) эти формулы не знает и не
// проверяет, только хранит присланный JSON целиком.
import {
  fetchMe,
  fetchItems,
  fetchCharacter,
  updateCharacterSheet,
  fetchAdminCharacter,
  updateAdminCharacterSheet,
  fetchCharacterInventory,
  updateCharacterInventoryItem,
  deleteCharacterInventoryItem,
  fetchReferences,
  fetchPregen,
  updateAdminPregen,
} from "../api.js";
import { openSocket } from "../ws-reconnect.js";
import { icon } from "../icons.js";
import { parseLssExport, applyLssImport } from "../lss-import.js";
import { enhanceRolls } from "../inline-rolls.js";
import { attachHpDrag, hpColor, hpFillRatios, parseQuickValue } from "../hp-bar.js";
import { renderStatusChips } from "../status-palette.js";
import { applyModifiers, explainModifiers, collectModifiers, ABILITY_TARGETS, TARGET_AC, TARGET_SPEED, TARGET_HP_MAX } from "../modifiers.js";
import { showAlert, openModal } from "../modal.js";
import { renderNoteHtml } from "../notes/markdown.js";
import { wireCatalogLinks } from "../catalog-links.js";
import { createRollLog } from "../roll-log.js";
import { isGM, isPlayer } from "../roles.js";

// ==================== PHB 2024 rules ====================

const ABILITIES = [
  { key: "str", label: "Сила" },
  { key: "dex", label: "Ловкость" },
  { key: "con", label: "Телосложение" },
  { key: "int", label: "Интеллект" },
  { key: "wis", label: "Мудрость" },
  { key: "cha", label: "Харизма" },
];

// Соответствие 18 навыков характеристикам — PHB 2024, полностью совпадает с
// бланком (см. приложенный PDF).
const SKILLS = [
  { key: "athletics", label: "Атлетика", ability: "str" },
  { key: "acrobatics", label: "Акробатика", ability: "dex" },
  { key: "sleightOfHand", label: "Ловкость рук", ability: "dex" },
  { key: "stealth", label: "Скрытность", ability: "dex" },
  { key: "investigation", label: "Анализ", ability: "int" },
  { key: "history", label: "История", ability: "int" },
  { key: "arcana", label: "Магия", ability: "int" },
  { key: "nature", label: "Природа", ability: "int" },
  { key: "religion", label: "Религия", ability: "int" },
  { key: "perception", label: "Восприятие", ability: "wis" },
  { key: "survival", label: "Выживание", ability: "wis" },
  { key: "medicine", label: "Медицина", ability: "wis" },
  { key: "insight", label: "Проницательность", ability: "wis" },
  { key: "animalHandling", label: "Уход за животными", ability: "wis" },
  { key: "performance", label: "Выступление", ability: "cha" },
  { key: "intimidation", label: "Запугивание", ability: "cha" },
  { key: "deception", label: "Обман", ability: "cha" },
  { key: "persuasion", label: "Убеждение", ability: "cha" },
];

function abilityMod(score) {
  return Math.floor(((score || 0) - 10) / 2);
}
function fmtMod(n) {
  return n >= 0 ? "+" + n : String(n);
}

// ---- применение изменений (см. internal/domain/modifier.go) ----
// Лист и так считает производные числа сам (модификаторы характеристик,
// бонус владения, спасброски, СЛ заклинаний — весь rules-блок вокруг), так
// что надетая экипировка и висящие состояния — просто ещё одно слагаемое в
// том же расчёте. Правил приложение при этом не знает: ЧТО именно даёт
// кольчуга или ослепление, записано в карточке предмета/состояния человеком
// или импортом, а здесь это только складывается.

// activeModifiers — всё, что сейчас действует на персонажа: изменения от
// НАДЕТЫХ предметов инвентаря плюс изменения от наложенных состояний.
// Считается на каждое обращение, а не кэшируется: и то и другое меняется
// прямо во время просмотра листа (галочка «надето», метка из трекера).
function activeModifiers() {
  const equipped = inventory
    .filter((e) => e.equipped && e.itemId && itemCatalog.has(e.itemId))
    .map((e) => ({ name: e.name, modifiers: itemCatalog.get(e.itemId).modifiers }));
  return collectModifiers([...equipped, ...liveStatuses]);
}

// abilityScore — значение характеристики С УЧЁТОМ изменений. Именно его
// читает весь rules-блок ниже, поэтому «+2 к Силе» от пояса сам собой
// доезжает и до модификатора, и до спасбросков, и до навыков, и до
// грузоподъёмности. Поля ввода характеристик при этом показывают БАЗУ —
// правит игрок её, а не результат.
function abilityScore(sheet, key) {
  return applyModifiers(sheet.abilities[key] || 0, ABILITY_TARGETS[key], activeModifiers());
}
function effectiveAC(sheet) {
  return applyModifiers(sheet.combat.ac || 0, TARGET_AC, activeModifiers());
}
function effectiveSpeed(sheet) {
  return applyModifiers(sheet.combat.speed || 0, TARGET_SPEED, activeModifiers());
}
function effectiveHPMax(sheet) {
  return applyModifiers(sheet.combat.hpMax || 0, TARGET_HP_MAX, activeModifiers());
}
// modifierHint — подсказка «из чего сложилось» для плитки; пустая строка,
// если ничего не применилось (тогда подсказку не показываем вовсе).
function modifierHint(target, base) {
  const parts = explainModifiers(target, activeModifiers());
  return parts.length ? `база ${base}; ${parts.join("; ")}` : "";
}
// Бонус владения по уровню — единая таблица PHB 2024, одна на всех, не
// зависит от класса.
function profBonus(level) {
  const lvl = Math.max(1, Math.min(20, level || 1));
  return 2 + Math.floor((lvl - 1) / 4);
}
function skillBonus(sheet, skill) {
  const state = sheet.skillProf[skill.key] || 0; // 0 нет / 1 владение / 2 экспертиза
  return abilityMod(abilityScore(sheet, skill.ability)) + profBonus(sheet.info.level) * state;
}
function saveBonus(sheet, abilityKey) {
  return abilityMod(abilityScore(sheet, abilityKey)) + (sheet.saveProf[abilityKey] ? profBonus(sheet.info.level) : 0);
}
function passivePerception(sheet) {
  const perception = SKILLS.find((s) => s.key === "perception");
  return 10 + skillBonus(sheet, perception);
}
// Грузоподъёмность/прыжки — PHB 2024, "с разбега": прыжок в длину = Сила
// (значение) фут., прыжок в высоту = 3 + модификатор Силы фут. При Силе 10
// это даёт "10 фут."/"3 фут." — ровно дефолты пустого бланка.
function carryCapacity(sheet) {
  return abilityScore(sheet, "str") * 15;
}
function longJumpFt(sheet) {
  return abilityScore(sheet, "str");
}
function highJumpFt(sheet) {
  return 3 + abilityMod(abilityScore(sheet, "str"));
}
function spellAbilityMod(sheet) {
  const a = sheet.spellcasting.ability;
  return a ? abilityMod(abilityScore(sheet, a)) : 0;
}
function spellSaveDC(sheet) {
  return sheet.spellcasting.ability ? 8 + profBonus(sheet.info.level) + spellAbilityMod(sheet) : null;
}
function spellAtkBonus(sheet) {
  return sheet.spellcasting.ability ? profBonus(sheet.info.level) + spellAbilityMod(sheet) : null;
}
// parseFlatBonus — распознаёт колонку "Бонус/Сложность" таблицы оружия как
// чистое число со знаком (для кнопки-броска); "СЛ 13" или что угодно ещё
// текстовое — не распознаётся, кнопка не показывается (это не бросок
// персонажа, а спасбросок цели).
function parseFlatBonus(text) {
  const m = /^([+-]?\d+)$/.exec(String(text || "").trim());
  return m ? parseInt(m[1], 10) : null;
}

// ==================== state ====================

let me = null;
let charId = null;
let character = null; // {id, name, avatarUrl, sheet, accountUsername?}
let sheet = null; // character.sheet, нормализованный
// readOnly — управляет ТОЛЬКО disabled-состоянием полей ниже по файлу;
// с тех пор как ДМ тоже полноценно редактирует чужой лист (см. isAdminView),
// это поле никогда не становится true, но название и условия оставлены как
// есть — переписывать каждый `if (readOnly)` в разметке смысла не было бы.
let readOnly = false;
// isAdminView — ДМ смотрит/правит лист ЧУЖОГО персонажа: влияет только на
// подзаголовок с именем игрока, баннер и то, какой из двух PUT-эндпоинтов
// (свой/админский) дёргать при автосохранении, см. doSave().
let isAdminView = false;
// isPregenAdmin — ДМ правит заготовку из пула «Готовые персонажи»
// (character-sheet.html?pregen=<id> под ролью admin, см. dm.js:
// createPregenFlow). Полноценная правка листа, но персонажа ещё нет —
// автосохранение уходит в updateAdminPregen, инвентаря и бросков нет.
let isPregenAdmin = false;
let pregenEditId = null;
let rollWS = null;
let rollLog = null; // общий виджет лога бросков (см. web/src/roll-log.js); null во встроенном листе — там лог показывает стол

// liveStatuses/liveStatusesEl — наложенные состояния этого персонажа (см.
// domain.AppliedStatus): приходят с сервера в combat_state тем же сокетом,
// что и броски (см. connectRollSocket), лист их только показывает.
let liveStatuses = [];
// itemCatalog — карточки библиотеки предметов по id, нужны РОВНО для одного:
// достать Item.Modifiers надетых вещей (см. activeModifiers). Записи
// инвентаря хранят только снимок имени/веса (см. domain.InventoryEntry), а
// цифры «пока надет» должны быть свежими — ДМ поправил кольчугу, и КД
// пересчитался у всех, а не только у новых владельцев.
let itemCatalog = new Map();
let liveStatusesEl = null;

// isClassic — система ЭТОГО персонажа (Character.System, см.
// internal/domain/company.go: SystemDnD5e2014/2024, проставляется один раз
// при создании персонажа из компании игрока) — D&D 5e 2014, а не 2024.
// Влияет только на то, какие поля бланка показываем: "Раса" вместо "Вид" и
// 4 отдельные графы (Черты/Идеалы/Привязанности/Слабости) бланка 2014
// вместо единого текста "Предыстория и личные качества" бланка 2024 — сами
// данные (sheet) хранятся в одном и том же формате на обе системы, см.
// internal/domain/character_sheet.go.
function isClassic() {
  return character && character.system === "dnd5e-2014";
}

function normalizeSheet(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  s.info = s.info || {};
  if (!s.info.level) s.info.level = 1;
  s.abilities = s.abilities || {};
  for (const a of ABILITIES) if (!s.abilities[a.key]) s.abilities[a.key] = 10;
  s.saveProf = s.saveProf || {};
  for (const a of ABILITIES) if (s.saveProf[a.key] === undefined) s.saveProf[a.key] = false;
  s.skillProf = s.skillProf || {};
  s.armor = s.armor || {};
  s.combat = s.combat || {};
  s.weapons = Array.isArray(s.weapons) ? s.weapons : [];
  s.notes = Array.isArray(s.notes) && s.notes.length === 6 ? s.notes : ["", "", "", "", "", ""];
  s.spellcasting = s.spellcasting || {};
  s.spellcasting.ability = s.spellcasting.ability || "";
  s.spellcasting.slotsByLevel =
    Array.isArray(s.spellcasting.slotsByLevel) && s.spellcasting.slotsByLevel.length === 9
      ? s.spellcasting.slotsByLevel
      : ["", "", "", "", "", "", "", "", ""];
  s.preparedSpells = Array.isArray(s.preparedSpells) ? s.preparedSpells : [];
  s.coins = s.coins || {};
  for (const k of ["cp", "sp", "gp", "ep", "pp"]) s.coins[k] = Math.max(0, parseInt(s.coins[k], 10) || 0);
  // personalityTraits/ideals/bonds/flaws — показываются на обеих системах
  // (см. renderTab1/renderTab4 ниже), просто в разных местах листа;
  // race/species — только 2014/2024 соответственно, у "чужой" системы
  // остаются пустой строкой, ничего не отображающей.
  s.personalityTraits = s.personalityTraits || "";
  s.ideals = s.ideals || "";
  s.bonds = s.bonds || "";
  s.flaws = s.flaws || "";
  s.info.race = s.info.race || "";
  s.info.species = s.info.species || "";
  s.info.playerName = s.info.playerName || "";
  s.physical = s.physical || {};
  for (const k of ["age", "height", "weight", "eyes", "skin", "hair"]) s.physical[k] = s.physical[k] || "";
  s.traits = s.traits || "";
  s.proficiencyNotes = s.proficiencyNotes || "";
  s.combat.darkvision = s.combat.darkvision || 0;
  s.combat.isDying = !!s.combat.isDying;
  s.resources = Array.isArray(s.resources) ? s.resources : [];
  // attunementItems — заменяет прежние безымянные 3 чекбокса (см.
  // internal/domain/character_sheet.go: AttunementItems); дополняем как
  // минимум до 3 строк при первой загрузке, чтобы сохранить привычный UX
  // "3 слота", но список динамический — можно добавлять/удалять строки.
  s.attunementItems = Array.isArray(s.attunementItems) ? s.attunementItems.slice() : [];
  while (s.attunementItems.length < 3) s.attunementItems.push({ name: "", attuned: false });
  return s;
}

// ==================== DOM helpers ====================

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
  if (readOnly) inp.disabled = true;
  else
    inp.addEventListener("input", () => {
      set(inp.value);
      scheduleSave();
    });
  return inp;
}

// suggestInput — текстовое поле с подсказками из справочника (см.
// api.js: fetchReferences, domain.Reference) через HTML <datalist>:
// выглядит в браузере как обычный выпадающий список, но НЕ блокирует ввод
// произвольного текста — тот же принцип "умного бланка", что и у остального
// листа: мультикласс ("Воин 3 / Плут 2"), домашний класс/вид, которого ещё
// нет в справочнике, старые листы с уже вписанным значением — ничего из
// этого не ломается строгой валидацией. options — обычный массив имён,
// вычисленный на момент вызова (не геттер) — для полей, чьи подсказки не
// зависят от других полей листа (Вид/Раса, Происхождение). У связки
// Класс+Подкласс, где список архетипов зависит от выбранного класса,
// datalist пересчитывается отдельно вручную (см. classSubclassFields ниже),
// не через этот generic-хелпер.
let suggestSeq = 0;
function suggestInput(get, set, options, opts) {
  const id = "dl" + suggestSeq++;
  const dl = h("datalist", { id });
  for (const name of options) dl.appendChild(h("option", { value: name }));
  const inp = h("input", Object.assign({ type: "text", list: id }, opts || {}));
  inp.value = get() ?? "";
  if (readOnly) inp.disabled = true;
  else
    inp.addEventListener("input", () => {
      set(inp.value);
      scheduleSave();
    });
  return h("span", { class: "suggest-wrap" }, [inp, dl]);
}

function textareaInput(get, set, opts) {
  const t = h("textarea", opts || {});
  t.value = get() ?? "";
  if (readOnly) t.disabled = true;
  else
    t.addEventListener("input", () => {
      set(t.value);
      scheduleSave();
    });
  return t;
}

function numberInput(get, set, opts) {
  const inp = h("input", Object.assign({ type: "number" }, opts || {}));
  inp.value = get() ?? 0;
  if (readOnly) inp.disabled = true;
  else
    inp.addEventListener("input", () => {
      set(parseInt(inp.value, 10) || 0);
      scheduleSave();
      refreshComputed();
    });
  return inp;
}

function checkboxInput(get, set, opts) {
  const c = h("input", Object.assign({ type: "checkbox" }, opts || {}));
  c.checked = !!get();
  if (readOnly) c.disabled = true;
  else
    c.addEventListener("change", () => {
      set(c.checked);
      scheduleSave();
      refreshComputed();
    });
  return c;
}

// computed-элементы, которые надо освежить после любого изменения, влияющего
// на формулы (характеристика/уровень/владения) — каждый описан функцией
// пересчёта текста.
const computedRefs = [];
function computed(labelText, compute, extra) {
  const span = h("span", { class: "computed" });
  computedRefs.push(() => (span.textContent = compute()));
  span.textContent = compute();
  const wrap = h("span", {}, [labelText ? h("span", { class: "computed-lbl", text: labelText }) : null, span, extra]);
  return wrap;
}
function refreshComputed() {
  for (const fn of computedRefs) fn();
}

// renderEditTabs — полная пересборка бланка (все вкладки разом). Только
// целиком: computedRefs выше собирается со всех вкладок сразу, и чистить его
// перед отрисовкой ОДНОЙ вкладки нельзя — потерялись бы ссылки остальных
// трёх. Вызывается при загрузке, после импорта из LSS и при возврате из
// режима чтения (там правятся ХП/ячейки/ресурсы — бланк должен показать уже
// новые числа).
function renderEditTabs() {
  computedRefs.length = 0;
  renderTab1();
  renderTab2();
  renderTab3();
  renderTab4();
}

function rollBtn(getFormula, label) {
  if (readOnly) return null;
  return h("button", {
    type: "button",
    class: "roll-btn",
    title: "Бросить " + label,
    html: icon("dice", { size: 12 }),
    onclick: () => sendRoll(getFormula(), label),
  });
}

// ==================== переиспользуемые секции (обе системы/вкладки) ====================

// equipmentSection — "Снаряжение". У бланка 2024 живёт на вкладке
// "Заклинания" (см. renderTab4), у классического бланка 2014 — на вкладке
// "Лист" рядом с оружием (ближе к бумажному page 1, см. renderTab1) —
// содержимое (sheet.equipment) общее на обе системы, отличается только
// место в вёрстке, поэтому вынесено в общую функцию.
function equipmentSection() {
  return h("div", { class: "section" }, [h("h3", { text: "Снаряжение" }), textareaInput(() => sheet.equipment, (v) => (sheet.equipment = v), { rows: 6 })]);
}

// personalityFields — 4 текстовых поля личных качеств + мировоззрение.
// Показываются на обеих системах (см. internal/domain/character_sheet.go:
// PersonalityTraits/Ideals/Bonds/Flaws), но в разных местах листа: у
// классического бланка 2014 — на вкладке "Лист" рядом со способностями
// (renderTab1), у 2024 — на вкладке "Заклинания" вместе с историей
// персонажа (renderTab4). Общие геттеры/сеттеры вынесены сюда, чтобы не
// дублировать проводку — обёртку (заголовок, .section) добавляет каждый
// вызывающий сам.
function personalityFields() {
  return [
    field("Черты характера", textareaInput(() => sheet.personalityTraits, (v) => (sheet.personalityTraits = v), { rows: 2 })),
    field("Идеалы", textareaInput(() => sheet.ideals, (v) => (sheet.ideals = v), { rows: 2 })),
    field("Привязанности", textareaInput(() => sheet.bonds, (v) => (sheet.bonds = v), { rows: 2 })),
    field("Слабости", textareaInput(() => sheet.flaws, (v) => (sheet.flaws = v), { rows: 2 })),
    field("Мировоззрение", textInput(() => sheet.alignment, (v) => (sheet.alignment = v))),
  ];
}

// ==================== импорт из Long Story Short ====================

// applyLssFile — общая точка для файла и вставленного текста: парсит,
// маппит через lss-import.js, мутирует sheet напрямую (applyLssImport), а
// не мержит патч — тот же принцип, что и у остального этого файла (sheet
// правится через геттеры/сеттеры на месте, не иммутабельно). Затрагивает
// поля почти всех 4 вкладок — после успеха перерисовываем всё.
async function applyLssFile(rawText, msgEl) {
  msgEl.classList.remove("error", "ok");
  msgEl.textContent = "";
  let parsed;
  try {
    parsed = parseLssExport(rawText);
  } catch (err) {
    msgEl.textContent = err.message;
    msgEl.classList.add("error");
    return;
  }
  const { name, warnings } = applyLssImport(sheet, parsed, isClassic());
  msgEl.textContent = `Импортировано${name ? `: «${name}»` : ""}.` + (warnings.length ? " " + warnings.join(" ") : "");
  msgEl.classList.add("ok");
  renderEditTabs();
  await saveNow(); // сразу, не дожидаясь debounce — иначе теряется при быстром закрытии
}

function importSection() {
  const msg = h("div", { id: "lssImportMsg" });
  const fileInput = h("input", { type: "file", accept: "application/json,.json" });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) return;
    await applyLssFile(await file.text(), msg);
    fileInput.value = "";
  });
  const textarea = h("textarea", { placeholder: "...или вставь сюда содержимое JSON-файла экспорта", rows: 2 });
  const importBtn = h("button", { type: "button", text: "Импортировать вставленный JSON", onclick: () => applyLssFile(textarea.value, msg) });
  return h("div", { class: "section" }, [
    h("h3", { text: "Импорт из Long Story Short" }),
    h("p", { style: "margin:0 0 8px;color:var(--text-dim);font-size:11px;" }, "На lss экспортируй лист персонажа в JSON и выбери файл ниже (или вставь содержимое текстом). Уже заполненные текстовые поля не затираются — импорт дописывает к ним снизу."),
    field("Файл экспорта", fileInput),
    textarea,
    importBtn,
    msg,
  ]);
}

// referencesByKind — записи справочника (см. api.js: fetchReferences,
// domain.Reference), сгруппированные по Kind — источник подсказок для
// suggestInput ниже. Заполняется один раз в boot(), пусто (не ошибка), пока
// нужный Kind ("вид"/"происхождение") ещё не завезли импортом — datalist
// тогда просто окажется пустым, поле остаётся обычным текстовым вводом.
let references = [];
function referenceNames(kind) {
  return references.filter((r) => r.kind === kind).map((r) => r.name);
}

// classSubclassFields — "Класс"+"Подкласс" неразделимы: список подсказок
// архетипа зависит от того, что сейчас набрано в поле класса, поэтому
// datalist подкласса пересчитывается вручную по input-событию поля класса
// (см. refreshSubclassOptions) — БЕЗ полного renderTab1() на каждую
// клавишу, иначе терялся бы фокус/курсор посреди набора имени класса.
// Архетипы без ParentName (или пока класс не набран) показываются все —
// лучше избыточная подсказка, чем пустой список.
function classSubclassFields() {
  const subclassDl = h("datalist", { id: "dl" + suggestSeq++ });
  function refreshSubclassOptions() {
    subclassDl.innerHTML = "";
    const cls = (sheet.info.class || "").trim();
    for (const r of references) {
      if (r.kind !== "архетип") continue;
      if (cls && r.parentName && r.parentName !== cls) continue;
      subclassDl.appendChild(h("option", { value: r.name }));
    }
  }
  refreshSubclassOptions();

  const classDl = h("datalist", { id: "dl" + suggestSeq++ });
  for (const name of referenceNames("класс")) classDl.appendChild(h("option", { value: name }));
  const classInput = h("input", { type: "text", list: classDl.id });
  classInput.value = sheet.info.class ?? "";
  if (readOnly) classInput.disabled = true;
  else
    classInput.addEventListener("input", () => {
      sheet.info.class = classInput.value;
      scheduleSave();
      refreshSubclassOptions();
    });

  const subclassInput = h("input", { type: "text", list: subclassDl.id });
  subclassInput.value = sheet.info.subclass ?? "";
  if (readOnly) subclassInput.disabled = true;
  else
    subclassInput.addEventListener("input", () => {
      sheet.info.subclass = subclassInput.value;
      scheduleSave();
    });

  return [
    field("Класс", h("span", { class: "suggest-wrap" }, [classInput, classDl])),
    field("Подкласс", h("span", { class: "suggest-wrap" }, [subclassInput, subclassDl])),
  ];
}

// ==================== tab 1: лист ====================

function renderTab1() {
  const root = document.getElementById("tab1");
  root.innerHTML = "";

  root.appendChild(importSection());

  // ---- шапка ----
  root.appendChild(
    h("div", { class: "section" }, [
      h("h3", { text: "Персонаж" }),
      h("div", { class: "row" }, [
        field("Имя игрока", textInput(() => sheet.info.playerName, (v) => (sheet.info.playerName = v))),
        field("Предыстория", suggestInput(() => sheet.info.background, (v) => (sheet.info.background = v), referenceNames("происхождение"))),
        ...classSubclassFields(),
        isClassic()
          ? field("Раса", suggestInput(() => sheet.info.race, (v) => (sheet.info.race = v), referenceNames("вид")))
          : field("Вид", suggestInput(() => sheet.info.species, (v) => (sheet.info.species = v), referenceNames("вид"))),
        field(
          "Уровень",
          numberInput(() => sheet.info.level, (v) => (sheet.info.level = Math.max(1, Math.min(20, v || 1))), { min: 1, max: 20 })
        ),
        field("Опыт", numberInput(() => sheet.info.xp, (v) => (sheet.info.xp = v), { min: 0 })),
        field("Бонус владения", computed("", () => fmtMod(profBonus(sheet.info.level)))),
      ]),
    ])
  );

  // ---- характеристики + навыки + спасброски ----
  const abilitiesCol = h("div", { class: "col" });
  for (const a of ABILITIES) {
    const scoreGet = () => sheet.abilities[a.key];
    const scoreSet = (v) => (sheet.abilities[a.key] = Math.max(1, Math.min(30, v || 10)));
    const box = h("div", { class: "ability-box" }, [
      h("div", { class: "ability-head" }, [
        h("span", { class: "ability-name", text: a.label }),
        numberInput(scoreGet, scoreSet, { min: 1, max: 30 }),
        computed("мод.", () => fmtMod(abilityMod(abilityScore(sheet, a.key)))),
      ]),
      h("div", { class: "save-row" }, [
        profToggleBool(() => sheet.saveProf[a.key], (v) => (sheet.saveProf[a.key] = v)),
        h("span", { class: "skill-name", text: "Спасбросок" }),
        computed("", () => fmtMod(saveBonus(sheet, a.key))),
        rollBtn(() => "1d20" + fmtMod(saveBonus(sheet, a.key)), "Спасбросок " + a.label),
      ]),
      ...SKILLS.filter((s) => s.ability === a.key).map((s) =>
        h("div", { class: "skill-row" }, [
          profToggleTri(() => sheet.skillProf[s.key] || 0, (v) => (sheet.skillProf[s.key] = v)),
          h("span", { class: "skill-name", text: s.label }),
          computed("", () => fmtMod(skillBonus(sheet, s))),
          rollBtn(() => "1d20" + fmtMod(skillBonus(sheet, s)), s.label),
        ])
      ),
    ]);
    abilitiesCol.appendChild(box);
  }

  // ---- бой ----
  const combatCol = h("div", { class: "col" });
  combatCol.appendChild(
    h("div", { class: "section" }, [
      h("h3", { text: "Боевые показатели" }),
      h("div", { class: "row" }, [
        field("КЗ (AC)", numberInput(() => sheet.combat.ac, (v) => (sheet.combat.ac = v))),
        field("Скорость", numberInput(() => sheet.combat.speed, (v) => (sheet.combat.speed = v))),
        field("Тёмное зрение", numberInput(() => sheet.combat.darkvision, (v) => (sheet.combat.darkvision = v), { min: 0, placeholder: "0" })),
        field("Инициатива", computed("", () => fmtMod(abilityMod(abilityScore(sheet, "dex"))))),
        field("Пасс. восприятие", computed("", () => String(passivePerception(sheet)))),
      ]),
      h("div", { class: "row" }, [
        field("ХП текущие", numberInput(() => sheet.combat.hpCurrent, (v) => (sheet.combat.hpCurrent = v))),
        field("ХП временные", numberInput(() => sheet.combat.hpTemp, (v) => (sheet.combat.hpTemp = v))),
        field("ХП максимум", numberInput(() => sheet.combat.hpMax, (v) => (sheet.combat.hpMax = v))),
      ]),
      h("div", { class: "row" }, [
        field("Кости хитов (всего)", textInput(() => sheet.combat.hitDiceTotal, (v) => (sheet.combat.hitDiceTotal = v), { placeholder: "3к8" })),
        field("Кости хитов (сейчас)", textInput(() => sheet.combat.hitDiceCurrent, (v) => (sheet.combat.hitDiceCurrent = v), { placeholder: "3к8" })),
      ]),
      h("div", { class: "row" }, [
        h("div", {}, [
          h("span", { class: "computed-lbl", text: "Спасброски от смерти — успехи" }),
          bulbRow(3, () => sheet.combat.deathSaveSuccess || 0, (v) => (sheet.combat.deathSaveSuccess = v), false),
        ]),
        h("div", {}, [
          h("span", { class: "computed-lbl", text: "провалы" }),
          bulbRow(3, () => sheet.combat.deathSaveFail || 0, (v) => (sheet.combat.deathSaveFail = v), true),
        ]),
      ]),
      h("div", { class: "row" }, [
        h("div", {}, [
          h("span", { class: "computed-lbl", text: "Истощение (0-6)" }),
          bulbRow(6, () => sheet.combat.exhaustion || 0, (v) => (sheet.combat.exhaustion = v), true),
        ]),
        h("label", { class: "checkbox-line" }, [
          checkboxInput(() => sheet.combat.inspiration, (v) => (sheet.combat.inspiration = v)),
          "Героическое вдохновение",
        ]),
        h("label", { class: "checkbox-line" }, [
          checkboxInput(() => sheet.combat.isDying, (v) => (sheet.combat.isDying = v)),
          "Умирает / без сознания",
        ]),
      ]),
      field("Состояния", textareaInput(() => sheet.combat.conditions, (v) => (sheet.combat.conditions = v), { rows: 2 })),
    ])
  );

  combatCol.appendChild(
    h("div", { class: "section" }, [
      h("h3", { text: "Владение снаряжением" }),
      h("div", { class: "row" }, [
        h("label", { class: "checkbox-line" }, [checkboxInput(() => sheet.armor.lightArmor, (v) => (sheet.armor.lightArmor = v)), "Лёгкие доспехи"]),
        h("label", { class: "checkbox-line" }, [checkboxInput(() => sheet.armor.mediumArmor, (v) => (sheet.armor.mediumArmor = v)), "Средние доспехи"]),
        h("label", { class: "checkbox-line" }, [checkboxInput(() => sheet.armor.heavyArmor, (v) => (sheet.armor.heavyArmor = v)), "Тяжёлые доспехи"]),
        h("label", { class: "checkbox-line" }, [checkboxInput(() => sheet.armor.shield, (v) => (sheet.armor.shield = v)), "Щит"]),
      ]),
      h("div", { class: "row" }, [
        h("label", { class: "checkbox-line" }, [checkboxInput(() => sheet.armor.simpleWeapons, (v) => (sheet.armor.simpleWeapons = v)), "Простое оружие"]),
        h("label", { class: "checkbox-line" }, [checkboxInput(() => sheet.armor.martialWeapons, (v) => (sheet.armor.martialWeapons = v)), "Воинское оружие"]),
      ]),
      field("Другое оружие", textInput(() => sheet.armor.otherWeapons, (v) => (sheet.armor.otherWeapons = v))),
      field("Владение инструментами и языками", textareaInput(() => sheet.toolsLanguages, (v) => (sheet.toolsLanguages = v), { rows: 2 })),
      field("Прочие владения (текстом)", textareaInput(() => sheet.proficiencyNotes, (v) => (sheet.proficiencyNotes = v), { rows: 3 })),
    ])
  );

  // ---- ресурсы (очки чародейства, ярость, ки и т.п.) ----
  const resourcesSection = h("div", { class: "section" }, [h("h3", { text: "Ресурсы" })]);
  const resourcesTableWrap = h("div", {});
  resourcesSection.appendChild(resourcesTableWrap);
  function renderResources() {
    resourcesTableWrap.innerHTML = "";
    const table = h("table", { class: "dyn-table" }, [
      h("thead", {}, [h("tr", {}, [h("th", { text: "Название" }), h("th", { text: "Сейчас" }), h("th", { text: "Максимум" }), h("th", { text: "Восстановление" }), readOnly ? null : h("th", {})])]),
    ]);
    const tbody = h("tbody", {});
    sheet.resources.forEach((row, i) => {
      tbody.appendChild(
        h("tr", {}, [
          h("td", {}, [textInput(() => row.name, (v) => (row.name = v))]),
          h("td", {}, [numberInput(() => row.current, (v) => (row.current = v), { min: 0, style: "width:64px" })]),
          h("td", {}, [numberInput(() => row.max, (v) => (row.max = v), { min: 0, style: "width:64px" })]),
          h("td", {}, [textInput(() => row.recovery, (v) => (row.recovery = v), { placeholder: "коротк. отдых" })]),
          readOnly ? null : h("td", {}, [h("button", { type: "button", class: "row-del", html: icon("close", { size: 11 }), onclick: () => { sheet.resources.splice(i, 1); scheduleSave(); renderResources(); } })]),
        ])
      );
    });
    table.appendChild(tbody);
    resourcesTableWrap.appendChild(table);
    if (!readOnly) {
      resourcesTableWrap.appendChild(
        h("button", {
          type: "button",
          class: "add-row-btn",
          text: "+ строка",
          onclick: () => {
            sheet.resources.push({ name: "", current: 0, max: 0, recovery: "" });
            scheduleSave();
            renderResources();
          },
        })
      );
    }
  }
  renderResources();
  combatCol.appendChild(resourcesSection);

  // ---- оружие ----
  const weaponsSection = h("div", { class: "section" }, [h("h3", { text: "Оружие и боевые заговоры" })]);
  const weaponsTableWrap = h("div", {});
  weaponsSection.appendChild(weaponsTableWrap);
  function renderWeapons() {
    weaponsTableWrap.innerHTML = "";
    const table = h("table", { class: "dyn-table" }, [
      h("thead", {}, [h("tr", {}, [h("th", { text: "Название" }), h("th", { text: "Бонус/Сложность" }), h("th", { text: "Урон/Вид" }), h("th", { text: "Заметки" }), readOnly ? null : h("th", {})])]),
    ]);
    const tbody = h("tbody", {});
    sheet.weapons.forEach((row, i) => {
      const bonusInput = textInput(() => row.bonus, (v) => (row.bonus = v), { placeholder: "+5" });
      const rollWrap = h("span", {});
      const refreshRoll = () => {
        rollWrap.innerHTML = "";
        const b = parseFlatBonus(row.bonus);
        if (b !== null) {
          const btn = rollBtn(() => "1d20" + fmtMod(b), row.name || "Атака");
          if (btn) rollWrap.appendChild(btn);
        }
      };
      bonusInput.addEventListener("input", refreshRoll);
      refreshRoll();
      const bonusCell = h("td", {}, [bonusInput, rollWrap]);
      tbody.appendChild(
        h("tr", {}, [
          h("td", {}, [textInput(() => row.name, (v) => (row.name = v))]),
          bonusCell,
          h("td", {}, [textInput(() => row.damage, (v) => (row.damage = v))]),
          h("td", {}, [textInput(() => row.notes, (v) => (row.notes = v))]),
          readOnly ? null : h("td", {}, [h("button", { type: "button", class: "row-del", html: icon("close", { size: 11 }), onclick: () => { sheet.weapons.splice(i, 1); scheduleSave(); renderWeapons(); } })]),
        ])
      );
    });
    table.appendChild(tbody);
    weaponsTableWrap.appendChild(table);
    if (!readOnly) {
      weaponsTableWrap.appendChild(
        h("button", {
          type: "button",
          class: "add-row-btn",
          text: "+ строка",
          onclick: () => {
            sheet.weapons.push({ name: "", bonus: "", damage: "", notes: "" });
            scheduleSave();
            renderWeapons();
          },
        })
      );
    }
  }
  renderWeapons();

  // isClassic() — вёрстка бланка 2014 держит снаряжение и личные качества
  // на этой же вкладке, ближе к бумажному page 1 (см. renderTab2/renderTab4
  // ниже — там для 2014, наоборот, этих секций нет).
  const textsCol = h("div", { class: "col" }, [
    weaponsSection,
    ...(isClassic() ? [equipmentSection()] : []),
    h("div", { class: "section" }, [h("h3", { text: "Видовые черты" }), textareaInput(() => sheet.traits, (v) => (sheet.traits = v), { rows: 4 })]),
    h("div", { class: "section" }, [h("h3", { text: "Умения и способности" }), textareaInput(() => sheet.features, (v) => (sheet.features = v), { rows: 8 })]),
    h("div", { class: "section" }, [h("h3", { text: "Атаки и заклинания" }), textareaInput(() => sheet.attacksSpells, (v) => (sheet.attacksSpells = v), { rows: 4 })]),
    h("div", { class: "section" }, [h("h3", { text: "Черты" }), textareaInput(() => sheet.feats, (v) => (sheet.feats = v), { rows: 4 })]),
    ...(isClassic() ? [h("div", { class: "section" }, [h("h3", { text: "Черты характера, идеалы, привязанности, слабости" }), ...personalityFields()])] : []),
  ]);

  root.appendChild(h("div", { class: "grid-cols" }, [abilitiesCol, combatCol, textsCol]));
}

function profToggleBool(get, set) {
  const btn = h("button", { type: "button", class: "prof-toggle" });
  const render = () => btn.setAttribute("data-state", get() ? "1" : "0");
  render();
  if (readOnly) btn.disabled = true;
  else
    btn.addEventListener("click", () => {
      set(!get());
      render();
      scheduleSave();
      refreshComputed();
    });
  return btn;
}

// 0 нет владения / 1 владение / 2 экспертиза (кольцо/точка/ромб)
function profToggleTri(get, set) {
  const btn = h("button", { type: "button", class: "prof-toggle" });
  const render = () => {
    const st = get();
    btn.setAttribute("data-state", String(st));
    btn.textContent = st === 2 ? "◆" : "";
  };
  render();
  if (readOnly) btn.disabled = true;
  else
    btn.addEventListener("click", () => {
      set((get() + 1) % 3);
      render();
      scheduleSave();
      refreshComputed();
    });
  return btn;
}

function bulbRow(count, get, set, isFail) {
  const wrap = h("div", { class: "bulb-row" });
  const render = () => {
    wrap.innerHTML = "";
    const val = get();
    for (let i = 0; i < count; i++) {
      const filled = i < val;
      wrap.appendChild(
        h("button", {
          type: "button",
          class: "bulb" + (filled ? " filled" + (isFail ? " fail" : "") : ""),
          title: String(i + 1),
          onclick: readOnly
            ? undefined
            : () => {
                // Клик по заполненной крайней лампе гасит её, иначе заполняет по эту включительно.
                set(val > i ? i : i + 1);
                scheduleSave();
                render();
              },
        })
      );
    }
  };
  render();
  return wrap;
}

// ==================== tab 2: портрет и т.д. ====================

function renderTab2() {
  const root = document.getElementById("tab2");
  root.innerHTML = "";
  const portrait = character.avatarUrl
    ? h("img", { class: "portrait-img", src: character.avatarUrl })
    : h("div", { class: "portrait-placeholder", text: "нет аватара" });
  const physicalSection = h("div", { class: "section" }, [
    h("h3", { text: "Данные персонажа" }),
    h("div", { class: "row" }, [
      field("Возраст", textInput(() => sheet.physical.age, (v) => (sheet.physical.age = v))),
      field("Рост", textInput(() => sheet.physical.height, (v) => (sheet.physical.height = v))),
      field("Вес", textInput(() => sheet.physical.weight, (v) => (sheet.physical.weight = v))),
    ]),
    h("div", { class: "row" }, [
      field("Глаза", textInput(() => sheet.physical.eyes, (v) => (sheet.physical.eyes = v))),
      field("Кожа", textInput(() => sheet.physical.skin, (v) => (sheet.physical.skin = v))),
      field("Волосы", textInput(() => sheet.physical.hair, (v) => (sheet.physical.hair = v))),
    ]),
  ]);
  // backstorySection — история персонажа (нарратив), только для бланка 2014:
  // у 2024 то же самое поле (sheet.background) уже показывается на вкладке
  // "Заклинания" вместе с личными качествами (см. renderTab4). Без этого у
  // классических персонажей sheet.background нигде не отображался бы вовсе.
  const backstorySection = isClassic()
    ? h("div", { class: "section" }, [h("h3", { text: "Предыстория" }), textareaInput(() => sheet.background, (v) => (sheet.background = v), { rows: 6 })])
    : null;

  root.appendChild(
    h("div", { class: "grid-cols" }, [
      h("div", { class: "col" }, [
        h("div", { class: "section" }, [
          h("h3", { text: "Портрет" }),
          portrait,
          h("div", {
            style: "margin-top:6px;color:var(--text-dim);font-size:11px;",
            // Сам аватар редактируется не здесь, а в списке персонажей —
            // разном для игрока и ДМ (у ДМ нет "Мои персонажи").
            text: isAdminView ? "Меняется в панели «Персонажи» → ✎." : "Меняется в «Мои персонажи» → аватар/токен-арт.",
          }),
        ]),
        physicalSection,
        backstorySection,
        h("div", { class: "section" }, [h("h3", { text: "Цели и задачи" }), textareaInput(() => sheet.goals, (v) => (sheet.goals = v), { rows: 6 })]),
      ]),
      h("div", { class: "col" }, [
        h("div", { class: "section" }, [h("h3", { text: "Союзники и организации" }), textareaInput(() => sheet.allies, (v) => (sheet.allies = v), { rows: 8 })]),
        h("div", { class: "section" }, [h("h3", { text: "Дополнительные способности и умения" }), textareaInput(() => sheet.additionalFeatures, (v) => (sheet.additionalFeatures = v), { rows: 6 })]),
        h("div", { class: "section" }, [h("h3", { text: "Сокровища" }), textareaInput(() => sheet.treasure, (v) => (sheet.treasure = v), { rows: 6 })]),
      ]),
    ])
  );
}

// ==================== tab 3: заметки ====================

function renderTab3() {
  const root = document.getElementById("tab3");
  root.innerHTML = "";
  const grid = h("div", { class: "notes-grid" });
  for (let i = 0; i < 6; i++) {
    grid.appendChild(
      h("div", { class: "section" }, [
        h("h3", { text: "Заметки " + (i + 1) }),
        textareaInput(() => sheet.notes[i], (v) => (sheet.notes[i] = v), { rows: 8 }),
      ])
    );
  }
  root.appendChild(grid);
}

// ==================== tab 4: заклинания ====================

const SPELL_ABILITY_OPTIONS = [
  { value: "", label: "Нет" },
  { value: "int", label: "Интеллект" },
  { value: "wis", label: "Мудрость" },
  { value: "cha", label: "Харизма" },
];

function selectInput(get, set, options) {
  const sel = h("select", {});
  for (const o of options) sel.appendChild(h("option", { value: o.value, text: o.label }));
  sel.value = get() || "";
  if (readOnly) sel.disabled = true;
  else
    sel.addEventListener("change", () => {
      set(sel.value);
      scheduleSave();
      refreshComputed();
    });
  return sel;
}

function renderTab4() {
  const root = document.getElementById("tab4");
  root.innerHTML = "";

  const spellSection = h("div", { class: "section" }, [
    h("h3", { text: "Заклинательная статистика" }),
    h("div", { class: "row" }, [
      field("Характеристика", selectInput(() => sheet.spellcasting.ability, (v) => (sheet.spellcasting.ability = v), SPELL_ABILITY_OPTIONS)),
      field("Модификатор", computed("", () => fmtMod(spellAbilityMod(sheet)))),
      field("СЛ спасброска", computed("", () => (spellSaveDC(sheet) === null ? "—" : String(spellSaveDC(sheet))))),
      field(
        "Бонус атаки",
        computed(
          "",
          () => (spellAtkBonus(sheet) === null ? "—" : fmtMod(spellAtkBonus(sheet))),
          rollBtn(() => "1d20" + fmtMod(spellAtkBonus(sheet) || 0), "Атака заклинанием")
        )
      ),
    ]),
    h("div", { class: "row" }, [
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((lvl) =>
        field(
          "Ячейки " + lvl + "-го ур.",
          textInput(() => sheet.spellcasting.slotsByLevel[lvl - 1], (v) => (sheet.spellcasting.slotsByLevel[lvl - 1] = v), { placeholder: "0" })
        )
      ),
    ]),
  ]);

  const spellsTableSection = h("div", { class: "section" }, [h("h3", { text: "Заговоры и подготовленные заклинания" })]);
  const spellsWrap = h("div", {});
  spellsTableSection.appendChild(spellsWrap);
  function renderSpells() {
    spellsWrap.innerHTML = "";
    const table = h("table", { class: "dyn-table" }, [
      h("thead", {}, [
        h("tr", {}, [
          h("th", { text: "Ур." }),
          h("th", { text: "Название" }),
          h("th", { text: "Время" }),
          h("th", { text: "Дистанция" }),
          h("th", { text: "К" }),
          h("th", { text: "Р" }),
          h("th", { text: "М" }),
          h("th", { text: "Заметки" }),
          readOnly ? null : h("th", {}),
        ]),
      ]),
    ]);
    const tbody = h("tbody", {});
    sheet.preparedSpells.forEach((row, i) => {
      tbody.appendChild(
        h("tr", {}, [
          h("td", {}, [numberInput(() => row.level, (v) => (row.level = Math.max(0, Math.min(9, v))), { min: 0, max: 9, style: "width:48px" })]),
          h("td", {}, [textInput(() => row.name, (v) => (row.name = v))]),
          h("td", {}, [textInput(() => row.castTime, (v) => (row.castTime = v), { style: "width:70px" })]),
          h("td", {}, [textInput(() => row.range, (v) => (row.range = v), { style: "width:70px" })]),
          h("td", {}, [checkboxInput(() => row.concentration, (v) => (row.concentration = v))]),
          h("td", {}, [checkboxInput(() => row.ritual, (v) => (row.ritual = v))]),
          h("td", {}, [checkboxInput(() => row.material, (v) => (row.material = v))]),
          h("td", {}, [textInput(() => row.notes, (v) => (row.notes = v))]),
          readOnly ? null : h("td", {}, [h("button", { type: "button", class: "row-del", html: icon("close", { size: 11 }), onclick: () => { sheet.preparedSpells.splice(i, 1); scheduleSave(); renderSpells(); } })]),
        ])
      );
    });
    table.appendChild(tbody);
    spellsWrap.appendChild(table);
    if (!readOnly) {
      spellsWrap.appendChild(
        h("button", {
          type: "button",
          class: "add-row-btn",
          text: "+ строка",
          onclick: () => {
            sheet.preparedSpells.push({ level: 0, name: "", castTime: "", range: "", concentration: false, ritual: false, material: false, notes: "" });
            scheduleSave();
            renderSpells();
          },
        })
      );
    }
  }
  renderSpells();

  const miscSection = h("div", { class: "section" }, [
    h("h3", { text: "Размер, грузоподъёмность, прыжки" }),
    h("div", { class: "row" }, [
      field("Размер", textInput(() => sheet.size, (v) => (sheet.size = v), { placeholder: "Средний" })),
      field("Грузоподъёмность", computed("", () => carryCapacity(sheet) + " фунт.")),
      field("Прыжок в высоту", computed("", () => highJumpFt(sheet) + " фут.")),
      field("Прыжок в длину", computed("", () => longJumpFt(sheet) + " фут.")),
    ]),
  ]);

  const appearanceSection = h("div", { class: "section" }, [h("h3", { text: "Внешность" }), textareaInput(() => sheet.appearance, (v) => (sheet.appearance = v), { rows: 4 })]);
  // backgroundSection — только для бланка 2024: история персонажа вместе с
  // личными качествами (черты характера/идеалы/привязанности/слабости) и
  // мировоззрением. У классического бланка 2014 то же самое содержимое —
  // на других вкладках (личные качества на "Лист" — renderTab1, история
  // персонажа на "Портрет" — renderTab2, см. комментарии там), тут для него
  // рендерить нечего.
  const backgroundSection = isClassic()
    ? null
    : h("div", { class: "section" }, [
        h("h3", { text: "Предыстория и личные качества" }),
        textareaInput(() => sheet.background, (v) => (sheet.background = v), { rows: 5 }),
        ...personalityFields(),
      ]);
  const attunementSection = h("div", { class: "section" }, [h("h3", { text: "Настройка на магические предметы" })]);
  const attunementTableWrap = h("div", {});
  attunementSection.appendChild(attunementTableWrap);
  function renderAttunement() {
    attunementTableWrap.innerHTML = "";
    const table = h("table", { class: "dyn-table" }, [
      h("thead", {}, [h("tr", {}, [h("th", { text: "Предмет" }), h("th", { text: "Настроен" }), readOnly ? null : h("th", {})])]),
    ]);
    const tbody = h("tbody", {});
    sheet.attunementItems.forEach((row, i) => {
      tbody.appendChild(
        h("tr", {}, [
          h("td", {}, [textInput(() => row.name, (v) => (row.name = v))]),
          h("td", {}, [checkboxInput(() => row.attuned, (v) => (row.attuned = v))]),
          readOnly ? null : h("td", {}, [h("button", { type: "button", class: "row-del", html: icon("close", { size: 11 }), onclick: () => { sheet.attunementItems.splice(i, 1); scheduleSave(); renderAttunement(); } })]),
        ])
      );
    });
    table.appendChild(tbody);
    attunementTableWrap.appendChild(table);
    if (!readOnly) {
      attunementTableWrap.appendChild(
        h("button", {
          type: "button",
          class: "add-row-btn",
          text: "+ строка",
          onclick: () => {
            sheet.attunementItems.push({ name: "", attuned: false });
            scheduleSave();
            renderAttunement();
          },
        })
      );
    }
  }
  renderAttunement();
  const coinsSection = h("div", { class: "section" }, [
    h("h3", { text: "Монеты" }),
    h("div", { class: "row" }, [
      field("ММ (медь)", numberInput(() => sheet.coins.cp, (v) => (sheet.coins.cp = v), { min: 0 })),
      field("СМ (серебро)", numberInput(() => sheet.coins.sp, (v) => (sheet.coins.sp = v), { min: 0 })),
      field("ЗМ (золото)", numberInput(() => sheet.coins.gp, (v) => (sheet.coins.gp = v), { min: 0 })),
      field("ЭМ (электрум)", numberInput(() => sheet.coins.ep, (v) => (sheet.coins.ep = v), { min: 0 })),
      field("ПМ (платина)", numberInput(() => sheet.coins.pp, (v) => (sheet.coins.pp = v), { min: 0 })),
    ]),
  ]);

  root.appendChild(
    h("div", { class: "grid-cols" }, [
      h("div", { class: "col" }, [spellSection, spellsTableSection, miscSection]),
      // equipmentSection() — только 2024 (см. её же на вкладке "Лист" для
      // isClassic(), в renderTab1 выше).
      h("div", { class: "col" }, [appearanceSection, backgroundSection, ...(isClassic() ? [] : [equipmentSection()])]),
      h("div", { class: "col" }, [attunementSection, coinsSection]),
    ])
  );
}

// ==================== tab 5: инвентарь ====================
//
// В отличие от остального листа, инвентарь НЕ часть sheet/scheduleSave —
// своя sub-collection (см. api.js: fetchCharacterInventory и соседи), у неё
// собственные точечные запросы (см. internal/domain/character_sheet.go и
// repository.CharacterRepository про причину: инвентарь может писать не
// только сам игрок — ДМ через хаб, сервер при луте трупа — полная
// перезапись sheet_json по debounce-автосейву листа не должна откатывать
// только что выданный лут устаревшей копией). Доступна только владельцу
// (см. isAdminView ниже — у ДМ, открывшего ЧУЖОЙ лист, эндпоинты инвентаря
// вернут 404: они авторизуются по сессии текущего аккаунта, а не персонажа).
//
// Игрок НЕ может сам добавить себе предмет из каталога — только то, что
// выдал ДМ (хаб лута) или что удалось забрать с трупа (см. loot-take-modal.js,
// оба пути пишут через AddInventoryEntry в обход этого сервиса). Отсюда же
// правки количества в этой вкладке — только уменьшение (потратил/выбросил),
// см. qtyInput ниже.
let inventory = [];

function totalWeight() {
  const w = inventory.reduce((sum, e) => sum + (e.weightLb || 0) * (e.quantity || 0), 0);
  return Math.round(w * 100) / 100;
}

async function loadInventory() {
  try {
    inventory = await fetchCharacterInventory(charId);
  } catch {
    inventory = [];
  }
  // Карточки каталога нужны только ради Item.Modifiers надетых вещей (см.
  // activeModifiers) — тянем их вместе с инвентарём и одним запросом, а не
  // по одной на запись. Не загрузились — лист просто работает без учёта
  // экипировки, как до появления изменений.
  try {
    const items = await fetchItems();
    itemCatalog = new Map(items.map((it) => [it.id, it]));
  } catch {
    itemCatalog = new Map();
  }
  renderTab5();
  if (mode === "view") renderView();
}

function saveInventoryEntry(e, patch) {
  if ("equipped" in patch && patch.equipped !== e.equipped) {
    // Надеть/снять может расщепить стопку (надел одну штуку из трёх — в
    // инвентаре появляется отдельная надетая запись на 1 и обычная на 2) или
    // слить её обратно с такой же соседней записью (см.
    // internal/service/characters.go: UpdateInventoryItem), поэтому id и
    // количества строк после запроса могут не совпадать с тем, что было в
    // памяти — правим не локально, а перечитываем инвентарь целиком.
    updateCharacterInventoryItem(charId, e.id, e.quantity, patch.equipped, e.notes)
      .then(loadInventory)
      .catch((err) => showAlert("Не удалось сохранить: " + err.message));
    return;
  }
  Object.assign(e, patch);
  updateCharacterInventoryItem(charId, e.id, e.quantity, e.equipped, e.notes).catch((err) => showAlert("Не удалось сохранить: " + err.message));
}

function removeInventoryEntry(id) {
  deleteCharacterInventoryItem(charId, id)
    .then(() => {
      inventory = inventory.filter((e) => e.id !== id);
      renderTab5();
      if (mode === "view") renderView();
    })
    .catch((err) => showAlert("Не удалось удалить: " + err.message));
}

function renderTab5() {
  const root = document.getElementById("tab5");
  root.innerHTML = "";

  const listSection = h("div", { class: "section" }, [
    h("h3", { text: "Инвентарь" }),
    h("p", { class: "inv-total-weight" }, ["Общий вес: ", h("b", { text: String(totalWeight()) }), " фнт."]),
  ]);

  const table = h("table", { class: "dyn-table" }, [
    h("thead", {}, [
      h("tr", {}, [
        h("th", {}),
        h("th", { text: "Название" }),
        h("th", { text: "Вес/шт" }),
        h("th", { text: "Кол-во" }),
        h("th", { text: "Надето" }),
        h("th", { text: "Заметка" }),
        h("th", {}),
      ]),
    ]),
  ]);
  const tbody = h("tbody", {});
  for (const e of inventory) {
    const avatar = h("div", { class: "inv-avatar" });
    if (e.imageUrl) avatar.style.backgroundImage = `url("${e.imageUrl}")`;

    // max = текущее количество — игрок может только потратить/выбросить
    // часть стопки, не приписать себе лишнее (см. комментарий у `let inventory`).
    const qtyInput = h("input", { type: "number", min: "0", max: String(e.quantity), value: String(e.quantity) });
    qtyInput.addEventListener("change", () => {
      const q = parseInt(qtyInput.value, 10);
      const clamped = Number.isFinite(q) ? Math.min(Math.max(q, 0), e.quantity) : e.quantity;
      // 0 — предмет потрачен весь, запись удаляется целиком (см. сервер:
      // UpdateInventoryItem), а не остаётся строкой "×0".
      if (clamped === 0) {
        removeInventoryEntry(e.id);
        return;
      }
      saveInventoryEntry(e, { quantity: clamped });
      renderTab5();
    });

    const equippedInput = h("input", { type: "checkbox" });
    equippedInput.checked = !!e.equipped;
    equippedInput.addEventListener("change", () => saveInventoryEntry(e, { equipped: equippedInput.checked }));

    const notesInput = h("input", { type: "text", value: e.notes || "", placeholder: "заметка" });
    notesInput.addEventListener("change", () => saveInventoryEntry(e, { notes: notesInput.value }));

    const delBtn = h("button", {
      type: "button",
      class: "row-del",
      html: icon("close", { size: 11 }),
      onclick: () => removeInventoryEntry(e.id),
    });

    const nameBtn = h("button", {
      type: "button",
      class: "inv-name-btn",
      title: "Открыть карточку предмета",
      text: e.name,
      onclick: (ev) => openItemPeek(e, ev.currentTarget),
    });

    tbody.appendChild(
      h("tr", {}, [
        h("td", {}, [avatar]),
        h("td", {}, [nameBtn]),
        h("td", { text: (e.weightLb || 0) + " фнт" }),
        h("td", {}, [qtyInput]),
        h("td", {}, [equippedInput]),
        h("td", {}, [notesInput]),
        h("td", {}, [delBtn]),
      ])
    );
  }
  table.appendChild(tbody);
  listSection.appendChild(table);

  root.append(listSection);
}

// ==================== режим чтения ====================
//
// Лист открывается СНАЧАЛА здесь, и только кнопка "Редактировать" в шапке
// пускает в бланк с полями ввода (renderTab1..5 выше). Причина — разные
// задачи: бланк заполняют раз в несколько уровней, а читают его каждый ход,
// и за столом с него нужны не поля ввода, а крупные числа и большие цели
// для клика.
//
// Что режим чтения УМЕЕТ менять (всё, что расходуется по ходу боя, — иначе
// пришлось бы прыгать в правку за каждой потраченной ячейкой): ХП и
// временные ХП, опыт, монеты, спасброски от смерти, истощение,
// вдохновение, ячейки заклинаний, ресурсы класса, количество/надетость
// предметов инвентаря. Всё остальное (характеристики, владения, тексты
// способностей, состав оружия и заклинаний) — только для чтения.
//
// Формулы PHB (модификаторы, бонусы навыков/спасбросков, СЛ заклинаний,
// пассивное восприятие) те же самые, что и в бланке — считаются теми же
// функциями rules-блока в начале файла, отдельной копии правил тут нет.

// mode — "view" (по умолчанию при каждом открытии листа) | "edit".
// Осознанно НЕ запоминается между открытиями: лист всегда открывается на
// чтение, правка — явное действие.
let mode = "view";

// vRefresh — точечные обновления чисел режима чтения (ХП, опыт, счётчики
// ресурсов): пересобирать весь экран на каждый клик по лампочке — терять
// прокрутку и фокус в поле быстрого ввода. Список живёт ровно одну
// отрисовку — renderView() очищает его первым делом.
let vRefresh = [];
function refreshView() {
  for (const fn of vRefresh) fn();
}

// Разбор "быстрого ввода" ("+5"/"-5"/"17") переехал в общий hp-bar.js —
// тем же полем и с теми же правилами правит хиты ДМ в трекере инициативы
// (combat-panel.js), и расходиться они не должны.
//
// quickInput — узкое поле быстрого ввода (см. parseQuickValue). Значение
// применяется по Enter или потере фокуса и поле сразу очищается: это не
// "поле со значением", а команда — текущее число всегда видно рядом крупно.
function quickInput(getCurrent, apply, opts) {
  const inp = h(
    "input",
    Object.assign(
      {
        type: "text",
        inputmode: "numeric",
        autocomplete: "off",
        placeholder: "+5",
        title: "«+5» — прибавить, «-5» — отнять, «17» — поставить ровно",
      },
      opts || {}
    )
  );
  function commit() {
    const parsed = parseQuickValue(inp.value, getCurrent());
    inp.value = "";
    if (!parsed) return;
    apply(parsed);
    scheduleSave();
    refreshView();
  }
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
      inp.blur();
    } else if (e.key === "Escape") {
      inp.value = "";
      inp.blur();
    }
  });
  // Enter выше уже вызвал commit и снял фокус — сюда долетит второй раз, но
  // поле к этому моменту пустое и parseQuickValue вернёт null.
  inp.addEventListener("blur", commit);
  return inp;
}

function stepBtn(label, cls, onclick) {
  return h("button", { type: "button", class: cls, text: label, onclick });
}

// vPips — ряд "лампочек" расходуемого ресурса: заполненная = ещё есть,
// погасшая = потрачена. Клик работает в обе стороны той же логикой, что
// лампы бланка (см. bulbRow): по заполненной крайней — гасит по неё
// включительно, по погасшей — зажигает по неё включительно.
function vPips(total, getFilled, setFilled, opts) {
  const o = opts || {};
  const wrap = h("div", { class: "v-pips" });
  const render = () => {
    wrap.innerHTML = "";
    const filled = getFilled();
    for (let i = 0; i < total; i++) {
      const isFilled = i < filled;
      wrap.appendChild(
        h("button", {
          type: "button",
          class: "v-pip" + (isFilled ? "" : " spent") + (o.tone ? " tone-" + o.tone : "") + (o.round ? " round" : ""),
          title: o.title || String(i + 1),
          onclick: () => {
            setFilled(filled > i ? i : i + 1);
            scheduleSave();
            render();
            refreshView();
          },
        })
      );
    }
  };
  render();
  return wrap;
}

// parseSlots — колонка ячеек заклинаний хранится свободным текстом
// ("4" или "4/2" — всего/использовано, см. domain.SpellcastingInfo). Пипсы
// показываем, только если строка разбирается; всё остальное ("2 + 1 от
// подкласса" и прочая ручная запись) остаётся текстом как есть.
function parseSlots(raw) {
  const t = String(raw || "").trim();
  if (!t) return null;
  const both = /^(\d+)\s*\/\s*(\d+)$/.exec(t);
  if (both) {
    const total = parseInt(both[1], 10);
    return { total, used: Math.min(parseInt(both[2], 10), total) };
  }
  const one = /^(\d+)$/.exec(t);
  if (one) return { total: parseInt(one[1], 10), used: 0 };
  return null;
}
function formatSlots(total, used) {
  return used > 0 ? `${total}/${used}` : String(total);
}

// vText — блок свободного текста листа с кликабельными формулами внутри
// (см. inline-rolls.js): "1к8+3" в описании способности бросается кликом,
// как в карточке монстра. Пустой текст секции не создаёт вовсе.
function vText(title, value, opts) {
  const text = String(value || "").trim();
  if (!text) return null;
  const body = h("div", { class: "v-text", text });
  enhanceRolls(body, sendRoll);
  const o = opts || {};
  return h("details", { class: "v-fold v-card", open: o.open !== false }, [h("summary", { text: title }), body]);
}

function vCard(title, children, note) {
  const kids = [].concat(children).filter(Boolean);
  if (!kids.length) return null;
  return h("div", { class: "v-card" }, [
    h("div", { class: "v-card-head" }, [h("span", { text: title }), note ? h("span", { class: "v-card-note", text: note }) : null]),
    ...kids,
  ]);
}

// vTile — плитка производного числа. formula задан — плитка кликабельна и
// кидает кубик (инициатива, атака заклинанием); иначе просто число.
function vTile(label, compute, formula, rollLabel, hint) {
  const value = h("b", { text: compute() });
  // hint — «из чего сложилось число» (см. modifierHint): пересчитывается
  // вместе со значением, иначе после смены экипировки подсказка врала бы.
  const applyHint = (node) => {
    if (!hint) return node;
    const set = () => {
      const t = hint();
      if (t) node.title = t;
      else node.removeAttribute("title");
    };
    set();
    vRefresh.push(set);
    return node;
  };
  vRefresh.push(() => (value.textContent = compute()));
  const inner = [value, h("span", { text: label })];
  if (!formula) return applyHint(h("div", { class: "v-tile" }, inner));
  return h("button", { type: "button", class: "v-tile", title: "Бросить: " + rollLabel, onclick: () => sendRoll(formula(), rollLabel) }, inner);
}

// ---------- шапка ----------

function vHero() {
  const isVideoAvatar = /\.(mp4|webm|m4v)(\?|#|$)/i.test(character.avatarUrl || "");
  const avatar =
    character.avatarUrl && !isVideoAvatar
      ? h("img", { class: "v-hero-avatar", src: character.avatarUrl, alt: "" })
      : h("div", { class: "v-hero-avatar", text: (character.name || "?").trim().charAt(0).toUpperCase() });

  const bits = [];
  const cls = [sheet.info.class, sheet.info.subclass].filter(Boolean).join(" · ");
  if (cls) bits.push(cls);
  bits.push((sheet.info.level || 1) + " ур.");
  const kind = isClassic() ? sheet.info.race : sheet.info.species;
  if (kind) bits.push(kind);
  if (sheet.info.background) bits.push(sheet.info.background);
  if (sheet.alignment) bits.push(sheet.alignment);

  const xpValue = h("b", { text: String(sheet.info.xp || 0) });
  vRefresh.push(() => (xpValue.textContent = String(sheet.info.xp || 0)));

  return h("div", { class: "v-card" }, [
    h("div", { class: "v-hero" }, [
      avatar,
      h("div", { class: "v-hero-main" }, [
        h("div", { class: "v-hero-name", text: character.name || "—" }),
        h("div", { class: "v-hero-sub", text: bits.join(" · ") }),
      ]),
    ]),
    h("div", { class: "v-quick", style: "margin-top:10px;" }, [
      h("span", { class: "v-track-name" }, [h("small", { text: "Опыт" }), xpValue]),
      stepBtn("−100", "minus", () => bumpXp(-100)),
      quickInput(
        () => sheet.info.xp || 0,
        (r) => (sheet.info.xp = Math.max(0, r.value)),
        { placeholder: "+250", style: "flex:0 1 74px;" }
      ),
      stepBtn("+100", "plus", () => bumpXp(100)),
    ]),
  ]);
}

function bumpXp(delta) {
  sheet.info.xp = Math.max(0, (sheet.info.xp || 0) + delta);
  scheduleSave();
  refreshView();
}

// ---------- ХП ----------

// clampHp — текущие ХП живут в 0..максимум: "в минус" бланк всё равно не
// умеет (для этого есть отдельный флаг "Умирает", см. domain.CombatStats),
// а перелечиться выше максимума нельзя по правилам. Максимум не заполнен
// (0) — не зажимаем сверху вообще, лист ещё не дозаполнен.
function clampHp(v) {
  // Потолок — эффективный максимум (см. effectiveHPMax): «максимум хитов
  // вдвое» от истощения или «+10 к максимуму» от заклинания меняют именно
  // его, а поле в бланке остаётся базой, как и у КЗ.
  const max = effectiveHPMax(sheet);
  return Math.max(0, max > 0 ? Math.min(max, v) : v);
}

// applyHp — урон, введённый ДЕЛЬТОЙ ("-7", кнопка −5), сначала съедает
// временные ХП и только остатком — текущие: за столом иначе этот вычет
// каждый раз делают в уме. Лечение и прямая установка числа ("17")
// временных не трогают.
function applyHp(r) {
  if (r.delta !== null && r.delta < 0) {
    let damage = -r.delta;
    const temp = sheet.combat.hpTemp || 0;
    const fromTemp = Math.min(temp, damage);
    if (fromTemp > 0) sheet.combat.hpTemp = temp - fromTemp;
    damage -= fromTemp;
    sheet.combat.hpCurrent = clampHp((sheet.combat.hpCurrent || 0) - damage);
    return;
  }
  sheet.combat.hpCurrent = clampHp(r.value);
}

function bumpHp(delta) {
  applyHp({ delta, value: (sheet.combat.hpCurrent || 0) + delta });
  scheduleSave();
  refreshView();
}

function vHpCard() {
  const cur = h("span", { class: "v-hp-big" });
  const max = h("span", { class: "v-hp-max" });
  const temp = h("span", { class: "v-hp-temp" });
  const fill = h("i", {});
  // preview — значение, за которым полоска идёт ПОКА ЕЁ ТЯНУТ: в бланк оно
  // ещё не записано (и не сохранено), но полоска и число обязаны идти за
  // пальцем, иначе жест не читается.
  let preview = null;
  const update = () => {
    const c = preview === null ? sheet.combat.hpCurrent || 0 : preview;
    const m = effectiveHPMax(sheet);
    const t = sheet.combat.hpTemp || 0;
    cur.textContent = String(c);
    max.textContent = "/ " + (m || "—");
    temp.textContent = t ? "+" + t + " врем." : "";
    temp.style.display = t ? "" : "none";
    const ratios = hpFillRatios({ current: c, temp: t, max: m });
    fill.style.width = (ratios.hp * 100).toFixed(1) + "%";
    fill.style.background = hpColor(ratios.hp);
    cur.style.color = m > 0 && c === 0 ? "#d9534f" : "";
  };
  vRefresh.push(update);
  update();

  // Полоску можно потянуть — тот же жест, что у ДМ в трекере инициативы
  // (см. hp-bar.js): "поставить примерно столько". Вниз это урон дельтой,
  // так что временные хиты съедаются первыми — как при вводе "-N" в поле
  // ниже (см. applyHp).
  const bar = h("div", { class: "v-bar", title: "Потяни, чтобы выставить хиты" }, [fill]);
  attachHpDrag(bar, {
    getState: () => ({ current: sheet.combat.hpCurrent || 0, max: effectiveHPMax(sheet) }),
    onPreview: (value) => {
      preview = value;
      update();
    },
    onCommit: (value) => {
      preview = null;
      applyHp({ delta: value - (sheet.combat.hpCurrent || 0), value });
      scheduleSave();
      refreshView();
    },
  });

  const hitDice = String(sheet.combat.hitDiceCurrent || sheet.combat.hitDiceTotal || "").trim();
  const hitDiceEl = hitDice
    ? h("div", { class: "v-track", style: "border-top:1px solid var(--border);margin-top:8px;" }, [
        h("span", { class: "v-track-name" }, [h("small", { text: "Кости хитов" }), h("span", { text: hitDice })]),
      ])
    : null;
  if (hitDiceEl) enhanceRolls(hitDiceEl, sendRoll);

  return h("div", { class: "v-card" }, [
    h("div", { class: "v-hp-row" }, [cur, max, temp]),
    bar,
    h("div", { class: "v-quick", title: "Урон сначала списывается с временных ХП" }, [
      stepBtn("−5", "minus", () => bumpHp(-5)),
      stepBtn("−1", "minus", () => bumpHp(-1)),
      quickInput(() => sheet.combat.hpCurrent || 0, applyHp),
      stepBtn("+1", "plus", () => bumpHp(1)),
      stepBtn("+5", "plus", () => bumpHp(5)),
    ]),
    h("div", { class: "v-quick", style: "margin-top:6px;" }, [
      h("span", { class: "v-track-name", text: "Временные ХП", style: "font-size:11px;color:var(--text-dim);" }),
      quickInput(
        () => sheet.combat.hpTemp || 0,
        (r) => (sheet.combat.hpTemp = Math.max(0, r.value)),
        { placeholder: "+0", style: "flex:0 1 66px;" }
      ),
    ]),
    hitDiceEl,
  ]);
}

// ---------- боевые плитки ----------

function vTilesCard() {
  const tiles = [
    // КЗ/Скорость показывают ЭФФЕКТИВНОЕ значение — с учётом надетой
    // экипировки и висящих состояний (см. activeModifiers); в подсказке
    // видно, из чего оно сложилось. Правится по-прежнему база: в режиме
    // правки поле «КЗ (AC)» — это именно она.
    vTile("КЗ", () => String(effectiveAC(sheet)), null, null, () => modifierHint(TARGET_AC, sheet.combat.ac || 0)),
    vTile("Инициатива", () => fmtMod(abilityMod(abilityScore(sheet, "dex"))), () => "1d20" + fmtMod(abilityMod(abilityScore(sheet, "dex"))), "Инициатива"),
    vTile("Скорость", () => String(effectiveSpeed(sheet)), null, null, () => modifierHint(TARGET_SPEED, sheet.combat.speed || 0)),
    vTile("Пасс. вниман.", () => String(passivePerception(sheet))),
    vTile("Владение", () => fmtMod(profBonus(sheet.info.level))),
  ];
  if (sheet.combat.darkvision) tiles.push(vTile("Тёмн. зрение", () => sheet.combat.darkvision + " ф."));
  return vCard("Бой", h("div", { class: "v-tiles" }, tiles));
}

// ---------- состояние ----------

function vStateCard() {
  const inspBtn = h("button", {
    type: "button",
    class: "v-tile",
    title: "Героическое вдохновение — клик переключает",
    onclick: () => {
      sheet.combat.inspiration = !sheet.combat.inspiration;
      scheduleSave();
      renderView();
    },
  });
  inspBtn.appendChild(h("b", { html: icon("bulb", { size: 16 }) }));
  inspBtn.appendChild(h("span", { text: "Вдохновение" }));
  inspBtn.style.color = sheet.combat.inspiration ? "var(--gold)" : "var(--text-dim)";

  const dyingBtn = h("button", {
    type: "button",
    class: "v-tile",
    title: "Умирает / без сознания — клик переключает",
    onclick: () => {
      sheet.combat.isDying = !sheet.combat.isDying;
      scheduleSave();
      renderView();
    },
  });
  dyingBtn.appendChild(h("b", { html: icon("moon", { size: 16 }) }));
  dyingBtn.appendChild(h("span", { text: "При смерти" }));
  dyingBtn.style.color = sheet.combat.isDying ? "#d9534f" : "var(--text-dim)";

  const conditions = String(sheet.combat.conditions || "").trim();

  return vCard("Состояние", [
    h("div", { class: "v-track" }, [
      h("span", { class: "v-track-name" }, [h("small", { text: "Спасбр. от смерти — успехи" })]),
      vPips(3, () => sheet.combat.deathSaveSuccess || 0, (v) => (sheet.combat.deathSaveSuccess = v), { tone: "good", round: true }),
    ]),
    h("div", { class: "v-track" }, [
      h("span", { class: "v-track-name" }, [h("small", { text: "провалы" })]),
      vPips(3, () => sheet.combat.deathSaveFail || 0, (v) => (sheet.combat.deathSaveFail = v), { tone: "danger", round: true }),
    ]),
    h("div", { class: "v-track" }, [
      h("span", { class: "v-track-name" }, [h("small", { text: "Истощение" })]),
      vPips(6, () => sheet.combat.exhaustion || 0, (v) => (sheet.combat.exhaustion = v), { tone: "danger" }),
    ]),
    h("div", { class: "v-tiles", style: "margin-top:6px;" }, [inspBtn, dyingBtn]),
    liveStatusesHost(),
    conditions ? h("div", { class: "v-text", style: "margin-top:8px;", text: conditions }) : null,
  ]);
}

// liveStatusesHost/renderLiveStatuses — блок наложенных состояний (см.
// domain.AppliedStatus). Только для чтения: свободнотекстовое поле
// «Состояния» бланка (sheet.combat.conditions, строкой ниже) осталось как
// было — это заметка игрока, а метки в этом блоке живут на токене/бойце и
// приходят с сервера (см. connectRollSocket). Своей истины лист не держит —
// тот же принцип, что у трекера инициативы.
function liveStatusesHost() {
  liveStatusesEl = h("div", { class: "v-track", style: "margin-top:8px;display:block;" });
  renderLiveStatuses();
  return liveStatusesEl;
}

function renderLiveStatuses() {
  if (!liveStatusesEl) return;
  liveStatusesEl.innerHTML = "";
  if (liveStatuses.length === 0) return;
  liveStatusesEl.appendChild(h("small", { text: "Наложено" }));
  liveStatusesEl.appendChild(renderStatusChips(liveStatuses));
}

// ---------- характеристики и навыки ----------

function vAbilitiesCard() {
  const grid = h("div", { class: "v-abils" });
  for (const a of ABILITIES) {
    const check = () => "1d20" + fmtMod(abilityMod(abilityScore(sheet, a.key)));
    const save = () => "1d20" + fmtMod(saveBonus(sheet, a.key));
    grid.appendChild(
      h("div", { class: "v-abil" }, [
        h("div", { class: "v-abil-name", text: a.label }),
        h("button", {
          type: "button",
          class: "v-abil-mod",
          text: fmtMod(abilityMod(abilityScore(sheet, a.key))),
          title: "Проверка: " + a.label,
          onclick: () => sendRoll(check(), "Проверка — " + a.label),
        }),
        h("div", { class: "v-abil-score", text: String(abilityScore(sheet, a.key) || 10), title: modifierHint(ABILITY_TARGETS[a.key], sheet.abilities[a.key] || 10) }),
        h("button", {
          type: "button",
          class: "v-abil-save" + (sheet.saveProf[a.key] ? " prof" : ""),
          title: "Спасбросок: " + a.label,
          onclick: () => sendRoll(save(), "Спасбросок — " + a.label),
        }, [h("span", { class: "v-dot" + (sheet.saveProf[a.key] ? " p1" : "") }), h("span", { text: "сп. " + fmtMod(saveBonus(sheet, a.key)) })]),
      ])
    );
  }
  return vCard("Характеристики", grid, "клик — бросок");
}

function vSkillsCard() {
  const grid = h("div", { class: "v-skills" });
  for (const s of SKILLS) {
    const state = sheet.skillProf[s.key] || 0;
    grid.appendChild(
      h("button", {
        type: "button",
        class: "v-skill" + (state ? " prof" : ""),
        title: (state === 2 ? "Экспертиза" : state === 1 ? "Владение" : "Без владения") + " · бросок",
        onclick: () => sendRoll("1d20" + fmtMod(skillBonus(sheet, s)), s.label),
      }, [
        h("span", { class: "v-dot" + (state ? " p" + state : "") }),
        h("span", { class: "v-skill-name", text: s.label }),
        h("span", { class: "v-skill-val", text: fmtMod(skillBonus(sheet, s)) }),
      ])
    );
  }
  return vCard("Навыки", grid, "клик — бросок");
}

// ---------- атаки ----------

function vAttacksCard() {
  const rows = [];
  for (const w of sheet.weapons) {
    const name = String(w.name || "").trim();
    const damage = String(w.damage || "").trim();
    const bonusText = String(w.bonus || "").trim();
    if (!name && !damage && !bonusText) continue;
    const flat = parseFlatBonus(bonusText);
    // Числовой бонус ("+5") — кнопка броска атаки; "СЛ 13" и прочий текст
    // броском персонажа не является (это спасбросок цели), показываем как есть.
    const hit =
      flat !== null
        ? h("button", {
            type: "button",
            class: "v-atk-hit",
            text: fmtMod(flat),
            title: "Атака: " + (name || "оружие"),
            onclick: () => sendRoll("1d20" + fmtMod(flat), name || "Атака"),
          })
        : bonusText
          ? h("span", { class: "v-atk-hit", text: bonusText })
          : null;
    const dmg = damage ? h("span", { class: "v-atk-dmg", text: damage }) : null;
    if (dmg) enhanceRolls(dmg, sendRoll);
    rows.push(
      h("div", { class: "v-atk" }, [
        h("span", { class: "v-atk-name" }, [h("span", { text: name || "—" }), w.notes ? h("small", { text: w.notes }) : null]),
        hit,
        dmg,
      ])
    );
  }
  return vCard("Атаки", rows, rows.length ? "клик — бросок" : null);
}

// ---------- ресурсы и ячейки ----------

function vResourcesCard() {
  const rows = [];
  for (const r of sheet.resources) {
    const name = String(r.name || "").trim();
    const max = r.max || 0;
    if (!name && !max) continue;
    const count = h("span", { class: "v-track-count" });
    const update = () => (count.textContent = (r.current || 0) + " / " + max);
    vRefresh.push(update);
    update();
    // До 10 делений — лампочки (в бою кликают по ним); больше — только
    // ±1 и поле быстрого ввода, ряд из 30 лампочек нечитаем.
    const control =
      max > 0 && max <= 10
        ? vPips(max, () => Math.min(r.current || 0, max), (v) => (r.current = v))
        : h("div", { class: "v-quick" }, [
            stepBtn("−1", "minus", () => {
              r.current = Math.max(0, (r.current || 0) - 1);
              scheduleSave();
              refreshView();
            }),
            quickInput(
              () => r.current || 0,
              (q) => (r.current = Math.max(0, max > 0 ? Math.min(max, q.value) : q.value)),
              { placeholder: "+1", style: "flex:0 1 60px;" }
            ),
            stepBtn("+1", "plus", () => {
              r.current = max > 0 ? Math.min(max, (r.current || 0) + 1) : (r.current || 0) + 1;
              scheduleSave();
              refreshView();
            }),
          ]);
    rows.push(
      h("div", { class: "v-track" }, [
        h("span", { class: "v-track-name" }, [h("span", { text: name || "Ресурс" }), r.recovery ? h("small", { text: r.recovery }) : null]),
        count,
        control,
      ])
    );
  }
  return vCard("Ресурсы", rows);
}

function vSlotsCard() {
  const rows = [];
  sheet.spellcasting.slotsByLevel.forEach((raw, i) => {
    const parsed = parseSlots(raw);
    const text = String(raw || "").trim();
    if (!parsed && !text) return;
    const lvl = i + 1;
    const control = parsed
      ? vPips(
          parsed.total,
          () => {
            const p = parseSlots(sheet.spellcasting.slotsByLevel[i]) || { total: 0, used: 0 };
            return p.total - p.used;
          },
          (available) => {
            const p = parseSlots(sheet.spellcasting.slotsByLevel[i]) || { total: 0, used: 0 };
            sheet.spellcasting.slotsByLevel[i] = formatSlots(p.total, p.total - available);
          }
        )
      : h("span", { class: "v-track-count", text });
    const count = h("span", { class: "v-track-count" });
    if (parsed) {
      const update = () => {
        const p = parseSlots(sheet.spellcasting.slotsByLevel[i]) || { total: 0, used: 0 };
        count.textContent = p.total - p.used + " / " + p.total;
      };
      vRefresh.push(update);
      update();
    }
    rows.push(h("div", { class: "v-track" }, [h("span", { class: "v-track-name", text: lvl + "-й ур." }), parsed ? count : null, control]));
  });
  return vCard("Ячейки заклинаний", rows, rows.length ? "клик — потратить/вернуть" : null);
}

// ---------- заклинания ----------

function vSpellsCard() {
  const kids = [];
  if (sheet.spellcasting.ability) {
    kids.push(
      h("div", { class: "v-tiles", style: "margin-bottom:8px;" }, [
        vTile("Модификатор", () => fmtMod(spellAbilityMod(sheet))),
        vTile("СЛ спасбр.", () => String(spellSaveDC(sheet) ?? "—")),
        vTile("Атака", () => fmtMod(spellAtkBonus(sheet) || 0), () => "1d20" + fmtMod(spellAtkBonus(sheet) || 0), "Атака заклинанием"),
      ])
    );
  }
  const byLevel = new Map();
  for (const s of sheet.preparedSpells) {
    const name = String(s.name || "").trim();
    if (!name) continue;
    const lvl = s.level || 0;
    if (!byLevel.has(lvl)) byLevel.set(lvl, []);
    byLevel.get(lvl).push(s);
  }
  for (const lvl of [...byLevel.keys()].sort((a, b) => a - b)) {
    kids.push(h("div", { class: "v-spell-lvl", text: lvl === 0 ? "Заговоры" : lvl + "-й уровень" }));
    for (const s of byLevel.get(lvl)) {
      const meta = [s.castTime, s.range].filter(Boolean).join(" · ");
      const row = h("div", { class: "v-spell" }, [
        h("span", { class: "v-spell-name", text: s.name }),
        s.concentration ? h("span", { class: "v-tag c", text: "К" }) : null,
        s.ritual ? h("span", { class: "v-tag", text: "Р" }) : null,
        s.material ? h("span", { class: "v-tag", text: "М" }) : null,
        meta ? h("span", { class: "v-spell-meta", text: meta }) : null,
        s.notes ? h("span", { class: "v-spell-meta", text: s.notes }) : null,
      ]);
      enhanceRolls(row, sendRoll);
      kids.push(row);
    }
  }
  return vCard("Заклинания", kids);
}

// ---------- деньги, настройка, инвентарь ----------

const COIN_FIELDS = [
  { key: "pp", label: "ПМ" },
  { key: "gp", label: "ЗМ" },
  { key: "ep", label: "ЭМ" },
  { key: "sp", label: "СМ" },
  { key: "cp", label: "ММ" },
];

function vMoneyCard() {
  const grid = h("div", { class: "v-money" });
  for (const c of COIN_FIELDS) {
    const value = h("b", { text: String(sheet.coins[c.key] || 0) });
    vRefresh.push(() => (value.textContent = String(sheet.coins[c.key] || 0)));
    const cell = h("div", { class: "v-money-cell" }, [value, h("span", { text: c.label })]);
    cell.appendChild(
      quickInput(
        () => sheet.coins[c.key] || 0,
        (r) => (sheet.coins[c.key] = Math.max(0, r.value)),
        { placeholder: "+0", style: "width:100%;margin-top:4px;font-size:11px;padding:3px 2px;" }
      )
    );
    grid.appendChild(cell);
  }
  // Кошелёк показываем всегда, даже из пяти нулей: игроку нужно место, куда
  // вписать первую добычу, не переключаясь в режим правки.
  return vCard("Монеты", grid);
}

function vAttunementCard() {
  const rows = sheet.attunementItems
    .filter((a) => String(a.name || "").trim())
    .map((a) =>
      h("div", { class: "v-inv" }, [
        h("span", { class: "v-inv-name", text: a.name }),
        h("span", { class: "v-tag" + (a.attuned ? " c" : ""), text: a.attuned ? "настроен" : "нет" }),
      ])
    );
  return vCard("Настройка на предметы", rows);
}

// ==================== карточка предмета из инвентаря ====================
//
// Инвентарь хранит только id/имя/вес/кол-во (см. domain.InventoryEntry) —
// сами характеристики предмета лежат в общей библиотеке (domain.Item) и уже
// подтянуты целиком в itemCatalog (см. loadInventory, ради модификаторов
// надетых вещей). Здесь та же карточка используется ещё раз, чтобы её можно
// было посмотреть из инвентаря — в двух видах:
//   - openItemPeek  — мини-окно рядом с предметом, только самое важное;
//   - showItemCard  — полноценное модальное окно с описанием целиком, тот же
//     "read-режим", что и в pages/itembook.js (readHeader/readInfoGrid/
//     renderReadView), скопирован сюда по той же схеме, что используют
//     spellbook.js/bestiary.js — свой набор функций на страницу, без общего
//     модуля.
function itemLineIf(label, value) {
  const v = (value ?? "").toString().trim();
  if (!v) return null;
  return h("div", { class: "ib-line" }, [h("strong", { text: label + " " }), v]);
}

function itemAttunementText(it) {
  if (!it.requiresAttunement) return "";
  return it.attunementNote ? `требуется настройка (${it.attunementNote})` : "требуется настройка";
}

function itemReadInfoGrid(it) {
  const wrap = h("div", { class: "ib-info" });
  const add = (label, value) => {
    const line = itemLineIf(label, value);
    if (line) wrap.appendChild(line);
  };
  add("Настройка:", itemAttunementText(it));
  add("Стоимость:", it.cost);
  add("Вес:", it.weight || (it.weightLb ? it.weightLb + " фнт" : ""));
  add("Активация:", it.activation);
  add("Урон:", it.damage);
  add("Класс доспеха:", it.armorClass);
  add("Свойства:", it.properties);
  add("Заряды:", it.charges);
  return wrap;
}

function itemReadHeader(it) {
  const portrait = it.imageUrl ? h("img", { class: "ib-portrait", src: it.imageUrl }) : null;
  const subtitleBits = [it.type, it.rarity].filter(Boolean).join(", ");
  const pills = [...(it.source ? [it.source] : []), ...(it.tags || [])].map((t) => h("span", { class: "ib-tag-pill", text: t }));
  const text = h("div", { class: "ib-header-text" }, [
    h("h2", { class: "ib-name", text: it.name || "Без имени" }),
    h("div", { class: "ib-subtitle", text: subtitleBits }),
    pills.length ? h("div", { class: "ib-tags" }, pills) : null,
  ]);
  return portrait ? h("div", { class: "ib-header" }, [portrait, text]) : text;
}

// showItemCard — вариант 2, "полноценное модальное окно": тот же bt-modal,
// что и у showAlert/showConfirm (см. modal.js), с телом целиком под карточку
// предмета вместо строки текста. cancelLabel: "" — как у showAlert, кнопка
// в подвале только закрывает, а не подтверждает что-либо.
function showItemCard(it) {
  openModal({
    title: it.name || "Предмет",
    okLabel: "Закрыть",
    cancelLabel: "",
    buildBody: (body) => {
      body.appendChild(itemReadHeader(it));
      body.appendChild(h("div", { class: "ib-hr" }));
      const info = itemReadInfoGrid(it);
      body.appendChild(info);
      enhanceRolls(info, sendRoll);
      const desc = (it.description || "").trim();
      if (desc) {
        body.appendChild(h("div", { class: "ib-hr" }));
        const prose = h("div", { class: "ib-prose" });
        prose.innerHTML = renderNoteHtml(it.description);
        enhanceRolls(prose, sendRoll);
        wireCatalogLinks(prose);
        body.appendChild(h("div", { class: "ib-block" }, [h("h3", { class: "ib-section-title", text: "Описание" }), prose]));
      }
      return null;
    },
    onOk: () => undefined,
    onCancel: () => undefined,
  });
}

// stripMarkup — грубая чистка markdown/HTML для превью в мини-окне: там нет
// места (и смысла) рендерить разметку целиком, только пара строк текста
// (обрезаются визуально, см. .item-peek-desc line-clamp в character-sheet.html).
function stripMarkup(text) {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

let itemPeekEl = null;
let itemPeekEntryId = null;

function closeItemPeek() {
  if (!itemPeekEl) return;
  itemPeekEl.remove();
  itemPeekEl = null;
  itemPeekEntryId = null;
  document.removeEventListener("mousedown", onItemPeekOutside, true);
  document.removeEventListener("keydown", onItemPeekKey, true);
  window.removeEventListener("scroll", closeItemPeek, true);
  window.removeEventListener("resize", closeItemPeek);
}

function onItemPeekOutside(ev) {
  if (itemPeekEl && !itemPeekEl.contains(ev.target)) closeItemPeek();
}

function onItemPeekKey(ev) {
  if (ev.key === "Escape") closeItemPeek();
}

function positionItemPeek(el, anchorEl) {
  const margin = 8;
  const r = anchorEl.getBoundingClientRect();
  const width = Math.min(300, window.innerWidth - margin * 2);
  el.style.width = width + "px";
  el.style.left = Math.min(Math.max(r.left, margin), window.innerWidth - width - margin) + "px";
  el.style.top = r.bottom + 6 + "px";
  // Высоту знаем только после вставки в DOM — если снизу не влезает, окно
  // переносится над предметом вместо того, чтобы вылезти за край экрана.
  const boxHeight = el.getBoundingClientRect().height;
  if (r.bottom + 6 + boxHeight > window.innerHeight - margin) {
    el.style.top = Math.max(margin, r.top - 6 - boxHeight) + "px";
  }
}

// openItemPeek — вариант 1, "мини-окно рядом с предметом": повторный клик по
// уже открытому предмету закрывает его же (тоггл), клик по другому —
// перерисовывает на новом месте. Нет карточки в библиотеке (itemId пуст —
// запись добавлена вручную, либо предмет с тех пор удалён из каталога, см.
// domain.InventoryEntry.ItemID) — показываем то, что есть в самой записи
// инвентаря, без кнопки "Открыть карточку" (открывать нечего).
function openItemPeek(entry, anchorEl) {
  if (itemPeekEl && itemPeekEntryId === entry.id) {
    closeItemPeek();
    return;
  }
  closeItemPeek();

  const it = entry.itemId ? itemCatalog.get(entry.itemId) : null;
  const children = [
    h("div", { class: "item-peek-head" }, [
      h("b", { text: entry.name }),
      h("button", { type: "button", class: "item-peek-close", html: icon("close", { size: 11 }), title: "Закрыть", onclick: closeItemPeek }),
    ]),
  ];
  if (it) {
    const sub = [it.type, it.rarity].filter(Boolean).join(", ");
    if (sub) children.push(h("div", { class: "item-peek-sub", text: sub }));
    children.push(itemReadInfoGrid(it));
    const desc = (it.description || "").trim();
    if (desc) children.push(h("p", { class: "item-peek-desc", text: stripMarkup(desc) }));
    children.push(
      h("div", { class: "item-peek-foot" }, [
        h("button", {
          type: "button",
          text: "Открыть карточку",
          onclick: () => {
            closeItemPeek();
            showItemCard(it);
          },
        }),
      ])
    );
  } else {
    children.push(h("div", { class: "item-peek-sub", text: "Предмета нет в библиотеке — правлен вручную" }));
    if (entry.notes) children.push(h("p", { class: "item-peek-desc", text: entry.notes }));
  }

  itemPeekEl = h("div", { class: "item-peek" }, children);
  document.body.appendChild(itemPeekEl);
  itemPeekEntryId = entry.id;
  positionItemPeek(itemPeekEl, anchorEl);

  // Подписка отложена на следующий тик — иначе тот же клик, что открыл окно
  // (mousedown на кнопке-триггере), тут же поймает себя как "клик мимо" и
  // закроет только что созданное окно.
  setTimeout(() => {
    document.addEventListener("mousedown", onItemPeekOutside, true);
    document.addEventListener("keydown", onItemPeekKey, true);
    window.addEventListener("scroll", closeItemPeek, true);
    window.addEventListener("resize", closeItemPeek);
  }, 0);
}

function vInventoryCard() {
  // У ДМ, открывшего ЧУЖОЙ лист, эндпоинты инвентаря отдают 404 (см.
  // renderTab5) — секции просто нет, как и вкладки.
  if (isAdminView || !inventory.length) return null;
  const rows = inventory.map((e) => {
    const qty = h("span", { class: "v-track-count", text: "×" + (e.quantity || 0) });
    const eq = h("button", {
      type: "button",
      class: "v-inv-eq" + (e.equipped ? " on" : ""),
      title: e.equipped ? "Надето — снять" : "Надеть",
      html: icon("check", { size: 12 }),
      onclick: () => saveInventoryEntry(e, { equipped: !e.equipped }),
    });
    return h("div", { class: "v-inv" }, [
      h(
        "button",
        { type: "button", class: "v-inv-name", title: "Открыть карточку предмета", onclick: (ev) => openItemPeek(e, ev.currentTarget) },
        [h("span", { text: e.name }), e.weightLb ? h("small", { text: " · " + e.weightLb + " фнт" }) : null]
      ),
      qty,
      // Только "потратить" — набрать себе лишнего игрок не может (см.
      // комментарий у `let inventory`), пополнение только через лут/ДМ.
      h("button", {
        type: "button",
        class: "v-inv-eq",
        title: "Потратить одну штуку",
        html: icon("minus", { size: 12 }),
        onclick: () => {
          const next = Math.max(0, (e.quantity || 0) - 1);
          // 0 — предмет потрачен весь, запись удаляется целиком (см.
          // removeInventoryEntry), а не остаётся строкой "×0".
          if (next === 0) {
            removeInventoryEntry(e.id);
            return;
          }
          saveInventoryEntry(e, { quantity: next });
          renderView();
        },
      }),
      eq,
    ]);
  });
  return vCard("Инвентарь", rows, totalWeight() + " фнт");
}

// ---------- сборка ----------

function renderView() {
  const root = document.getElementById("viewPanel");
  vRefresh = [];
  root.innerHTML = "";

  // Порядок карточек — под УЗКУЮ колонку (боковой док, см. sheet-dock.js): при
  // одной колонке они лягут сверху вниз ровно в этом порядке, и первым должно
  // идти то, к чему тянутся чаще всего за ход (ХП → состояние → расходники →
  // характеристики/навыки/атаки). Три колонки — это уже широкое плавающее
  // окно, где всё видно разом.
  const col1 = h("div", { class: "v-stack" }, [vHpCard(), vTilesCard(), vStateCard(), vResourcesCard(), vSlotsCard()]);
  const col2 = h("div", { class: "v-stack" }, [vAbilitiesCard(), vSkillsCard(), vAttacksCard(), vSpellsCard()]);
  // Тексты бланка — справочная часть: открытыми держим только те два блока,
  // куда реально смотрят посреди боя, остальное свёрнуто, чтобы лист не
  // превращался в простыню.
  const col3 = h("div", { class: "v-stack" }, [
    vInventoryCard(),
    vMoneyCard(),
    vAttunementCard(),
    vText("Умения и способности", sheet.features),
    vText("Видовые черты", sheet.traits),
    vText("Черты", sheet.feats, { open: false }),
    vText("Атаки и заклинания", sheet.attacksSpells, { open: false }),
    vText("Снаряжение", sheet.equipment, { open: false }),
    vText("Владения, инструменты и языки", [sheet.toolsLanguages, sheet.proficiencyNotes].filter(Boolean).join("\n"), { open: false }),
    vText("Внешность", sheet.appearance, { open: false }),
    vText("Предыстория", sheet.background, { open: false }),
    vText("Черты характера", sheet.personalityTraits, { open: false }),
    vText("Идеалы", sheet.ideals, { open: false }),
    vText("Привязанности", sheet.bonds, { open: false }),
    vText("Слабости", sheet.flaws, { open: false }),
    vText("Цели и задачи", sheet.goals, { open: false }),
    vText("Союзники и организации", sheet.allies, { open: false }),
    vText("Дополнительные способности", sheet.additionalFeatures, { open: false }),
    vText("Сокровища", sheet.treasure, { open: false }),
    vText("Заметки", sheet.notes.filter((n) => String(n || "").trim()).join("\n\n"), { open: false }),
  ]);

  root.appendChild(h("div", { class: "v-stack" }, [vHero(), h("div", { class: "v-cols" }, [col1, col2, col3])]));
}

// setMode — переключение "чтение ⇄ правка". Обе стороны пересобираются от
// нуля: в режиме чтения меняются ХП/ячейки/ресурсы, в правке — всё
// остальное, и вернувшись обратно надо видеть свежие числа, а не то, что
// было отрисовано при загрузке.
function setMode(next) {
  mode = next;
  document.body.classList.toggle("mode-view", mode === "view");
  document.getElementById("viewPanel").classList.toggle("active", mode === "view");
  const btn = document.getElementById("modeBtn");
  const isView = mode === "view";
  btn.innerHTML = icon(isView ? "pencil" : "eye", { size: 13 }) + "<span>" + (isView ? "Редактировать" : "Готово") + "</span>";
  btn.title = isView ? "Открыть бланк для правки" : "Вернуться к режиму чтения";
  if (isView) renderView();
  else renderEditTabs();
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
  if (readOnly) return;
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 700);
}

// saveNow — сохранить немедленно, без debounce. Для разовых крупных правок
// (импорт LSS): ждать 700мс незачем, а если окно закроют раньше — правка
// терялась (fetch дебаунса умирает вместе с iframe, см. beaconFlush ниже).
async function saveNow() {
  if (readOnly) return;
  clearTimeout(saveTimer);
  dirty = true;
  await doSave();
}

// saveInFlight — промис текущей записи на сервер (null, когда её нет).
// beaconFlush ждёт именно его: dirty сбрасывается в начале doSave, так что
// без этого закрытие окна в момент «уже шлём» убило бы запрос.
let saveInFlight = null;

async function doSave() {
  if (!dirty || readOnly) return;
  dirty = false;
  setSaveStatus("saving");
  const p = isPregenAdmin
    ? // Полная перезапись пре-гена — имя/аватар/метку модуля возвращаем как
      // есть, правится только лист (имя/аватар заготовки — в панели ДМ).
      updateAdminPregen(pregenEditId, {
        name: character.name,
        avatarUrl: character.avatarUrl || "",
        foundryModuleId: character.source || "",
        sheet,
      })
    : isAdminView
      ? updateAdminCharacterSheet(charId, sheet)
      : updateCharacterSheet(charId, sheet);
  saveInFlight = p;
  try {
    await p;
    setSaveStatus("saved");
  } catch (err) {
    dirty = true;
    setSaveStatus("error", err.message);
  } finally {
    if (saveInFlight === p) saveInFlight = null;
  }
}

window.addEventListener("beforeunload", () => {
  if (dirty && !readOnly) {
    // best-effort — большинство браузеров не ждут async в beforeunload,
    // но debounce всего 700мс, так что почти всегда уже сохранено к этому моменту.
    doSave();
  }
});

// beaconFlush — floating-window.js зовёт это ПЕРЕД удалением iframe (см.
// flushIframe там же). Удаление iframe не показывает beforeunload и убивает
// его fetch на полпути, поэтому debounce-сейв (700мс) терялся, если лист
// закрыть сразу после правки — заметнее всего на импорте LSS. Здесь ждём
// завершения записи по-настоящему.
window.beaconFlush = async () => {
  clearTimeout(saveTimer);
  if (dirty && !readOnly) await doSave();
  if (saveInFlight) await saveInFlight.catch(() => {});
};

// ==================== dice rolls ====================

function connectRollSocket() {
  // /ws/player требует роль "player" (см. internal/api/ws/routes.go) — ДМ
  // туда просто не пустят, поэтому в режиме ДМ бросок идёт через /ws/dm
  // (авторизован ролью admin из той же cookie сессии). Сервер разрешает DM
  // отправлять roll_dice как и все остальные типы сообщений (authorize) и
  // подписывает бросок именем ПЕРСОНАЖА этого листа, раз sendRoll шлёт его
  // characterId (room.go: handleRollDice/rollerName) — здесь важен только
  // сам roll_result, остальной трафик DM-сокета (снапшот сцены и т.п.)
  // молча игнорируется.
  // Своя подвальная лента лога — только у листа, вынесенного в настоящее
  // отдельное окно/вкладку. Внутри стола (боковой док sheet-dock.js или
  // плавающее окно floating-window.js — то есть iframe) приходит ТОТ ЖЕ
  // roll_result, что и в плашку стола (бросок ретранслируется всей комнате,
  // см. internal/service/room.go: relayRoll), и два лога в паре сантиметров
  // друг от друга дублировали бы строку — поэтому там rollLog остаётся null.
  if (!rollLog && !isEmbedded()) {
    rollLog = createRollLog(document.getElementById("rollLogWrap"), { layout: "strip" });
  }
  // Сокет с переподключением — см. web/src/ws-reconnect.js. Листу это нужнее
  // прочих окон: им же приезжают хиты, правленные ДМ в трекере, и лут из
  // хаба. После обрыва цифры на бланке молча расходились бы с тем, что
  // видит стол, до перезагрузки страницы.
  rollWS = openSocket(isAdminView ? "/ws/dm" : "/ws/player", {
    onMessage: (data) => {
    if (data.type === "roll_result") rollLog?.push(data);
    // Наложенные состояния этого персонажа (см. domain.AppliedStatus)
    // приезжают тем же сокетом в combat_state — сервер уже свёл их с токена
    // бойца (см. room_statuses.go: statusesOf) и вырезал скрытые от игрока.
    // Лист их только ПОКАЗЫВАЕТ: вешает и снимает метки ДМ (палитра в меню
    // токена или в трекере), собственного поля в бланке у них нет — иначе
    // получилось бы два источника истины. Если персонажа нет в инициативе,
    // список просто пустой: метка на токене вне боя сюда не долетает.
    if (data.type === "combat_state") {
      const mine = (data.combatants || []).find((c) => c.characterId === charId);
      liveStatuses = (mine && mine.statuses) || [];
      renderLiveStatuses();
      // Метки несут изменения (см. domain.AppliedStatus.Modifiers) — от них
      // зависят КЗ, скорость и всё, что считается от характеристик, поэтому
      // пересчитываем числа режима чтения, а не только строку чипов.
      if (mode === "view") refreshView();
    }
    // Хиты, изменённые ДМ в трекере инициативы: сервер пишет их в лист сам
    // (см. internal/service/room_character_hp.go) и присылает сюда, чтобы
    // цифра на экране игрока поменялась в момент удара, а не после
    // перезагрузки страницы. Кладём их в СВОЮ копию листа — иначе
    // ближайший автосейв бланка (debounce 700мс, см. scheduleSave) увёз бы
    // на сервер старые хиты и откатил правку ДМ.
    // Инвентарь пополняется не только с этого окна (хаб ДМа/труп на
    // player.html, см. service.Room: handleHubTakeItem/handleLootTakeItem) —
    // без этого сигнала новый лут появлялся бы только после перезагрузки
    // страницы с открытым бланком.
    if (data.type === "character_inventory" && data.characterId === charId) {
      loadInventory();
    }
    if (data.type === "character_hp" && data.characterId === charId && sheet) {
      sheet.combat.hpCurrent = data.hpCurrent;
      sheet.combat.hpTemp = data.hpTemp;
      sheet.combat.hpMax = data.hpMax;
      // В режиме правки перерисовывать нельзя: под курсором живые поля
      // ввода, и подмена разметки съела бы недописанное. Данные уже
      // обновлены, а увидит их бланк при следующем переключении режима.
      if (mode === "view") refreshView();
    }
    },
  });
}

function sendRoll(formula, label) {
  if (!rollWS) return;
  // characterId — сервер сам подставит имя ПЕРСОНАЖА в общий лог вместо
  // логина игрока/роли "ДМ" сокета (см. room.go: handleRollDice/rollerName),
  // раз бросок сделан именно с его листа. Так лог всегда называет того, кто
  // за столом реально кидал кубик — даже когда открыто несколько листов
  // подряд или ДМ бросает за чужого персонажа.
  rollWS.send({ type: "roll_dice", formula, label, characterId: charId });
}

// isEmbedded — лист открыт ВНУТРИ страницы стола: боковым доком
// (sheet-dock.js) или плавающим окном (floating-window.js), то есть в
// iframe, а не отдельной вкладкой/окном браузера.
function isEmbedded() {
  return window.parent !== window;
}

// ==================== boot ====================

function switchTab(n) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === String(n)));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
  document.getElementById("tab" + n).classList.add("active");
}
document.querySelectorAll(".tab-btn").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
document.getElementById("modeBtn").onclick = () => setMode(mode === "view" ? "edit" : "view");
document.getElementById("closeBtn").onclick = () => {
  // По умолчанию лист открывается ВНУТРИ dm.html/player.html как плавающее
  // окно (см. web/src/floating-window.js) — это iframe, а не отдельная
  // вкладка, и window.close() у iframe молча ничего не делает. Родитель
  // слушает это сообщение и закрывает плавающее окно сам. Если же лист
  // вынесли кнопкой 🗗 в настоящее окно браузера (window.parent === window),
  // ведём себя как раньше.
  if (isEmbedded()) {
    // Родитель сам дёрнет beaconFlush перед удалением iframe (floating-window.js).
    window.parent.postMessage({ type: "beacon:closeFloatingWindow" }, location.origin);
  } else {
    window.beaconFlush().finally(() => window.close());
  }
};

function currentId() {
  return new URLSearchParams(location.search).get("id");
}

// pregenId — режим предпросмотра «готового персонажа» из пула мира БЕЗ
// захвата (character-sheet.html?pregen=<id>, см. internal/domain/pregen.go).
// Лист открывается только на чтение: у пре-гена ещё нет записи characters,
// сохранять и бросать кубы не за кого.
function currentPregenId() {
  return new URLSearchParams(location.search).get("pregen");
}

(async function boot() {
  me = await fetchMe();
  if (!me || (!isPlayer(me.role) && !isGM(me.role))) {
    location.href = "/";
    return;
  }

  const pregenId = currentPregenId();
  if (pregenId) {
    try {
      character = await fetchPregen(pregenId);
    } catch (err) {
      document.getElementById("loadingHint").textContent = "Не удалось загрузить готового персонажа: " + err.message;
      return;
    }
    sheet = normalizeSheet(character.sheet);
    references = await fetchReferences().catch(() => []);

    // ДМ открыл заготовку из пула — полноценная правка листа (шаблон
    // скопируется игроку при «Назначить»). Инвентарь и броски заготовке
    // недоступны — записи characters ещё нет.
    if (isGM(me.role)) {
      isPregenAdmin = true;
      pregenEditId = pregenId;
      document.getElementById("charTitle").textContent = character.name;
      document.getElementById("charSub").textContent = "заготовка из пула — ещё не назначена игроку";
      const banner = document.getElementById("readonlyBanner");
      banner.textContent = "Заготовка «Готовые персонажи». Заполни лист заранее — при назначении игроку он скопируется ему.";
      banner.classList.add("shown");
      const tab5Btn = document.querySelector('.tab-btn[data-tab="5"]');
      if (tab5Btn) tab5Btn.style.display = "none";
      setMode("view");
      document.getElementById("loadingHint").style.display = "none";
      document.getElementById("app").classList.add("ready");
      return;
    }

    readOnly = true;
    document.getElementById("charTitle").textContent = character.name;
    document.getElementById("charSub").textContent = "готовый персонаж приключения";
    const banner = document.getElementById("readonlyBanner");
    banner.textContent = "Предпросмотр — этого персонажа ещё никто не взял. Полноценно откроется после «Взять» / назначения ДМ.";
    banner.classList.add("shown");
    // Правка и инвентарь пре-гену недоступны — прячем переключатель режима,
    // статус автосохранения и вкладку инвентаря.
    document.getElementById("modeBtn").style.display = "none";
    saveStatusEl.style.display = "none";
    const tab5Btn = document.querySelector('.tab-btn[data-tab="5"]');
    if (tab5Btn) tab5Btn.style.display = "none";

    setMode("view");
    document.getElementById("loadingHint").style.display = "none";
    document.getElementById("app").classList.add("ready");
    return;
  }

  charId = currentId();
  if (!charId) {
    document.getElementById("loadingHint").textContent = "Не указан id персонажа (?id=...).";
    return;
  }
  isAdminView = isGM(me.role);
  try {
    character = isAdminView ? await fetchAdminCharacter(charId) : await fetchCharacter(charId);
  } catch (err) {
    document.getElementById("loadingHint").textContent = "Не удалось загрузить лист: " + err.message;
    return;
  }
  sheet = normalizeSheet(character.sheet);
  // Справочник (классы/архетипы/происхождения/виды, см. domain.Reference) —
  // источник подсказок для полей "Класс"/"Подкласс"/"Вид"/"Предыстория"
  // (см. suggestInput/classSubclassFields выше). Отсутствие/ошибка запроса
  // не должна ронять открытие листа — тогда поля просто останутся обычным
  // текстовым вводом без подсказок.
  references = await fetchReferences().catch(() => []);

  document.getElementById("charTitle").textContent = character.name;
  document.getElementById("charSub").textContent = isAdminView && character.accountUsername ? "игрок: " + character.accountUsername : "";
  // Баннер больше не значит "только для чтения" (ДМ тоже редактирует) —
  // просто предупреждает, чей это лист, чтобы не перепутать со своим.
  document.getElementById("readonlyBanner").classList.toggle("shown", isAdminView);

  // Лист всегда открывается на ЧТЕНИЕ (см. setMode/renderView) — бланк с
  // полями ввода собирается только при первом переходе в правку.
  setMode("view");

  // Инвентарь — только у владельца (см. комментарий renderTab5 выше): у ДМ,
  // открывшего чужой лист, эндпоинты инвентаря вернули бы 404 (авторизация
  // по сессии текущего аккаунта), поэтому вкладку в режиме ДМ просто прячем,
  // а не показываем пустой/ошибающийся список.
  const tab5Btn = document.querySelector('.tab-btn[data-tab="5"]');
  if (isAdminView) {
    if (tab5Btn) tab5Btn.style.display = "none";
  } else {
    loadInventory();
  }

  document.getElementById("loadingHint").style.display = "none";
  document.getElementById("app").classList.add("ready");

  // Бросок кубов с листа — и у владельца, и у ДМ (см. connectRollSocket:
  // разные WS-эндпоинты под роль).
  connectRollSocket();
})();
