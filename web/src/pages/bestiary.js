// Карточка бестиария ДМ — отдельное окно, открывается из dm.html (панель
// "Бестиарий" или "📖 Статблок" в контекстном меню токена), по аналогии с
// character-sheet.js/note-window.js (тот же приём: плавающее окно =
// floating-window.js, тот же h()/textInput/... DOM-конструктор).
//
// "Умный бланк" — сервер (internal/domain/monster.go) не знает правил D&D,
// только хранит присланный JSON. Единственная посчитанная здесь на клиенте
// величина — модификатор характеристики (та же формула, что и в
// character-sheet.js: floor((score-10)/2)).
import { fetchMe, fetchMonster, createMonster, updateMonster, deleteMonster, uploadFile } from "../api.js";
import { renderNoteHtml } from "../notes/markdown.js";
import { mapFoundryMonsterJson } from "../monster-import.js";
import { enhanceRolls } from "../inline-rolls.js";
import { wireCatalogLinks } from "../catalog-links.js";
import { icon } from "../icons.js";
import { initItemPicker } from "../item-picker.js";
import { showAlert, showConfirm } from "../modal.js";

const ABILITIES = [
  { key: "str", label: "Сил" },
  { key: "dex", label: "Лов" },
  { key: "con", label: "Тел" },
  { key: "int", label: "Инт" },
  { key: "wis", label: "Муд" },
  { key: "cha", label: "Хар" },
];

function abilityMod(score) {
  return Math.floor(((score || 0) - 10) / 2);
}
function fmtMod(n) {
  return n >= 0 ? "+" + n : String(n);
}

// ==================== state ====================

let monsterId = null;
let monster = null; // объект domain.Monster целиком (сервер отдаёт camelCase — см. json-теги)
let rollWS = null;
// editMode — по умолчанию карточка открывается в чистом read-режиме (как
// статблок в Foundry), редактирование — по явному клику на ✎ (см.
// editToggleBtn ниже), тот же приём, что у заметок ДМ (note-window.js:
// editing/editToggleBtn). Пустая карточка, созданная кнопкой "+" в панели,
// открывается сразу в edit — см. boot(): ?edit=1.
let editMode = false;

function normalizeMonster(raw) {
  const m = raw && typeof raw === "object" ? raw : {};
  m.abilities = m.abilities || {};
  for (const a of ABILITIES) if (!m.abilities[a.key]) m.abilities[a.key] = 10;
  m.tags = Array.isArray(m.tags) ? m.tags : [];
  m.spells = Array.isArray(m.spells) ? m.spells : [];
  // inventory — шаблон добычи монстра (см. domain.InventoryEntry) — список
  // предметов каталога, снимаемый в Token.Loot убитого токена (см. план
  // фичи/service.Room.snapshotTokenLoot).
  m.inventory = Array.isArray(m.inventory) ? m.inventory : [];
  return m;
}

// tmpInventoryId — id для НОВОЙ строки инвентаря монстра, добавленной прямо
// тут в редакторе (сервер при сохранении карточки не проверяет уникальность
// ID записей — целиком доверяет клиенту, как и остальным полям "умного
// бланка"; настоящие устойчивые ID запись получает только при снимке в
// Token.Loot в момент смерти монстра, см. service.Room.snapshotTokenLoot).
function tmpInventoryId() {
  return "tmp-" + Math.random().toString(36).slice(2);
}

// ==================== DOM helpers (та же схема, что character-sheet.js) ====================

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
    set(parseInt(inp.value, 10) || 0);
    scheduleSave();
    refreshComputed();
  });
  return inp;
}

const computedRefs = [];
function computed(labelText, compute) {
  const span = h("span", { class: "computed" });
  computedRefs.push(() => (span.textContent = compute()));
  span.textContent = compute();
  return h("span", {}, [labelText ? h("span", { class: "computed-lbl", text: labelText }) : null, span]);
}
function refreshComputed() {
  for (const fn of computedRefs) fn();
}

function rollBtn(getFormula, label) {
  return h("button", { type: "button", class: "roll-btn", title: "Бросить " + label, html: icon("dice", { size: 12 }), onclick: () => sendRoll(getFormula(), label) });
}

// mdBlock — textarea markdown слева + живой рендер справа (тот же `marked`,
// что и заметки ДМ, см. web/src/notes/markdown.js). Без вики-ссылок — у
// статблока монстра нет смысла резолвить [[...]] на другие заметки.
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
// форма редактирования. Обе ветки просто наполняют один и тот же #app.
function renderApp() {
  const root = document.getElementById("app");
  root.innerHTML = "";
  if (editMode) renderEditView(root);
  else renderReadView(root);
}

function renderEditView(root) {
  // ---- шапка: портрет + имя/размер/тип/мировоззрение ----
  const portrait = monster.imageUrl
    ? h("img", { class: "portrait-img", src: monster.imageUrl })
    : h("div", { class: "portrait-placeholder", text: "нет арта" });
  const upload = h("input", { type: "file", accept: "image/*" });
  upload.addEventListener("change", async () => {
    const file = upload.files[0];
    if (!file) return;
    try {
      const { url } = await uploadFile(file, "tokens");
      monster.imageUrl = url;
      scheduleSave();
      renderApp();
    } catch (err) {
      showAlert("Не удалось загрузить арт: " + err.message);
    }
  });
  root.appendChild(
    h("div", { class: "section" }, [
      h("div", { class: "portrait-wrap" }, [portrait, h("div", { class: "col", style: "flex:1 1 auto;gap:6px;" }, [
        field("Имя", textInput(() => monster.name, (v) => { monster.name = v; document.getElementById("monsterTitle").textContent = v || "Без имени"; })),
        field("Токен-арт", upload),
      ])]),
      h("div", { class: "row" }, [
        field("Размер", textInput(() => monster.size, (v) => (monster.size = v), { placeholder: "Средний" })),
        field("Тип", textInput(() => monster.type, (v) => (monster.type = v), { placeholder: "гуманоид" })),
        field("Мировоззрение", textInput(() => monster.alignment, (v) => (monster.alignment = v), { placeholder: "нейтральное" })),
        field("Опасность (CR)", textInput(() => monster.cr, (v) => (monster.cr = v), { placeholder: "1/2" })),
        field("Бонус мастерства", numberInput(() => monster.proficiencyBonus, (v) => (monster.proficiencyBonus = v), { min: 0 })),
      ]),
      tagsField(),
    ])
  );

  // ---- боевые показатели ----
  root.appendChild(
    h("div", { class: "section" }, [
      h("h3", { text: "Боевые показатели" }),
      h("div", { class: "row" }, [
        field("КД (AC)", numberInput(() => monster.ac, (v) => (monster.ac = v), { min: 0 })),
        field("КД — примечание", textInput(() => monster.acNote, (v) => (monster.acNote = v), { placeholder: "природный доспех" })),
        field("Хиты (число)", numberInput(() => monster.hp, (v) => (monster.hp = v), { min: 0 })),
        field("Кость хитов", textInput(() => monster.hitDice, (v) => (monster.hitDice = v), { placeholder: "8d8+16" })),
      ]),
      field("Скорость", textInput(() => monster.speed, (v) => (monster.speed = v), { placeholder: "30 фт., полёт 60 фт." })),
    ])
  );

  // ---- характеристики ----
  const grid = h("div", { class: "ability-grid" });
  for (const a of ABILITIES) {
    const scoreGet = () => monster.abilities[a.key];
    const scoreSet = (v) => (monster.abilities[a.key] = Math.max(1, Math.min(30, v || 10)));
    grid.appendChild(
      h("div", { class: "ability-box" }, [
        h("span", { class: "ability-name", text: a.label }),
        numberInput(scoreGet, scoreSet, { min: 1, max: 30 }),
        h("div", { class: "ability-actions" }, [
          computed("", () => fmtMod(abilityMod(monster.abilities[a.key]))),
          rollBtn(() => "1d20" + fmtMod(abilityMod(monster.abilities[a.key])), a.label),
        ]),
      ])
    );
  }
  root.appendChild(h("div", { class: "section" }, [h("h3", { text: "Характеристики" }), grid]));

  // ---- спасброски / навыки / сопротивления / чувства ----
  root.appendChild(
    h("div", { class: "section" }, [
      h("h3", { text: "Спасброски, навыки, сопротивления" }),
      h("div", { class: "grid-cols" }, [
        field("Спасброски", textInput(() => monster.savingThrows, (v) => (monster.savingThrows = v), { placeholder: "Тел +7, Мдр +4" })),
        field("Навыки", textInput(() => monster.skills, (v) => (monster.skills = v), { placeholder: "Восприятие +5, Скрытность +6" })),
        field("Уязвимости к урону", textInput(() => monster.damageVulnerabilities, (v) => (monster.damageVulnerabilities = v))),
        field("Сопротивления к урону", textInput(() => monster.damageResistances, (v) => (monster.damageResistances = v))),
        field("Иммунитет к урону", textInput(() => monster.damageImmunities, (v) => (monster.damageImmunities = v))),
        field("Иммунитет к состояниям", textInput(() => monster.conditionImmunities, (v) => (monster.conditionImmunities = v))),
        field("Чувства", textInput(() => monster.senses, (v) => (monster.senses = v), { placeholder: "тёмное зрение 60 фт., Пасс. Восприятие 12" })),
        field("Языки", textInput(() => monster.languages, (v) => (monster.languages = v))),
      ]),
    ])
  );

  // ---- заклинания (ссылки на общую библиотеку — см. panel-section
  // "spells" в dm.html, добавление сюда происходит оттуда, здесь только
  // просмотр/открытие/удаление) ----
  root.appendChild(spellsSection());
  root.appendChild(invSection());

  // ---- текстовые блоки способностей ----
  root.appendChild(mdBlock("Особенности", () => monster.traits, (v) => (monster.traits = v)));
  root.appendChild(mdBlock("Действия", () => monster.actions, (v) => (monster.actions = v)));
  root.appendChild(mdBlock("Бонусные действия", () => monster.bonusActions, (v) => (monster.bonusActions = v)));
  root.appendChild(mdBlock("Реакции", () => monster.reactions, (v) => (monster.reactions = v)));
  root.appendChild(mdBlock("Вступление к легендарным действиям", () => monster.legendaryActionsIntro, (v) => (monster.legendaryActionsIntro = v), { rows: 2 }));
  root.appendChild(mdBlock("Легендарные действия", () => monster.legendaryActions, (v) => (monster.legendaryActions = v)));
  root.appendChild(mdBlock("Действия и эффекты логова", () => monster.lairActions, (v) => (monster.lairActions = v)));
  root.appendChild(mdBlock("Описание / лор", () => monster.description, (v) => (monster.description = v)));

  // ---- импорт из TTG Club ----
  root.appendChild(importSection());
}

// ==================== read-режим (по умолчанию) ====================
// Аккуратный статблок вместо формы — тот же макет, что у классического
// блока существа 5e (и у страницы ttg.club, которую разбирает
// monster-import.js: шапка/КД-ХП-скорость/характеристики/спасброски-навыки-
// чувства/способности по разделам). Никаких мутирующих контролов — только
// чтение и клики по формулам (см. web/src/inline-rolls.js).

// rollLink — кликабельное число, кидающее formula через тот же sendRoll, что
// и кнопки 🎲 в режиме редактирования (см. rollBtn выше).
function rollLink(formula, label, text) {
  const a = h("a", { class: "inline-roll", href: "#", title: "Бросить " + label, text });
  a.addEventListener("click", (e) => {
    e.preventDefault();
    sendRoll(formula, label);
  });
  return a;
}

// lineIf — строка "Метка значение", либо null, если значение пустое (read-
// режим не показывает пустые поля вообще, в отличие от формы редактирования).
function lineIf(label, value) {
  const v = (value ?? "").toString().trim();
  if (!v) return null;
  return h("div", { class: "sb-line" }, [h("strong", { text: label + " " }), v]);
}

// proseBlock — заголовок капсом + HTML-поле (то же renderNoteHtml, что и
// живой предпросмотр в mdBlock), с постобработкой кликабельных формул.
// null, если поле пустое — раздел просто не появляется.
function proseBlock(title, htmlContent) {
  if (!htmlContent || !String(htmlContent).trim()) return null;
  const body = h("div", { class: "sb-prose" });
  body.innerHTML = renderNoteHtml(htmlContent);
  enhanceRolls(body, sendRoll);
  wireCatalogLinks(body);
  return h("div", { class: "sb-block" }, [h("h3", { class: "sb-section-title", text: title }), body]);
}

function readHeader() {
  const portrait = monster.imageUrl
    ? h("img", { class: "sb-portrait", src: monster.imageUrl })
    : h("div", { class: "sb-portrait sb-portrait-placeholder" });
  const subtitle = [[monster.size, monster.type].filter(Boolean).join(" "), monster.alignment].filter(Boolean).join(", ");
  const tags = monster.tags.length
    ? h("div", { class: "sb-tags" }, monster.tags.map((t) => h("span", { class: "sb-tag-pill", text: t })))
    : null;
  return h("div", { class: "sb-header" }, [
    portrait,
    h("div", { class: "sb-header-text" }, [
      h("h2", { class: "sb-name", text: monster.name || "Без имени" }),
      subtitle ? h("div", { class: "sb-subtitle", text: subtitle }) : null,
      tags,
    ]),
  ]);
}

// readInfo — КД/ХП/скорость + спасброски/навыки/сопротивления/чувства/языки/
// опасность одним блоком, чтобы прогнать через enhanceRolls один раз (числа
// в этих строках — свободный текст ДМ/импорта, отдельный парсер под них не
// нужен, тот же общий regex справляется).
function readInfo() {
  const wrap = h("div", { class: "sb-info" });
  const acText = monster.acNote ? `${monster.ac || 0} (${monster.acNote})` : String(monster.ac || 0);
  wrap.appendChild(h("div", { class: "sb-line" }, [h("strong", { text: "Класс доспеха " }), acText]));
  const hpText = monster.hitDice ? `${monster.hp || 0} (${monster.hitDice})` : String(monster.hp || 0);
  wrap.appendChild(h("div", { class: "sb-line" }, [h("strong", { text: "Хиты " }), hpText]));
  const add = (label, value) => {
    const line = lineIf(label, value);
    if (line) wrap.appendChild(line);
  };
  add("Скорость", monster.speed);
  add("Спасброски", monster.savingThrows);
  add("Навыки", monster.skills);
  add("Уязвимости к урону", monster.damageVulnerabilities);
  add("Сопротивления к урону", monster.damageResistances);
  add("Иммунитет к урону", monster.damageImmunities);
  add("Иммунитет к состояниям", monster.conditionImmunities);
  add("Чувства", monster.senses);
  add("Языки", monster.languages);
  const crBits = [];
  if (monster.cr) crBits.push("Опасность " + monster.cr);
  if (monster.proficiencyBonus) crBits.push("Бонус мастерства " + fmtMod(monster.proficiencyBonus));
  if (crBits.length) wrap.appendChild(h("div", { class: "sb-line", text: crBits.join(" · ") }));
  return wrap;
}

function readAbilityGrid() {
  const grid = h("div", { class: "sb-ability-grid" });
  for (const a of ABILITIES) {
    const score = monster.abilities[a.key];
    const mod = abilityMod(score);
    grid.appendChild(
      h("div", { class: "sb-ability-box" }, [
        h("span", { class: "sb-ability-name", text: a.label }),
        h("span", { class: "sb-ability-score", text: String(score) }),
        rollLink("1d20" + fmtMod(mod), a.label, fmtMod(mod)),
      ])
    );
  }
  return grid;
}

function renderReadView(root) {
  root.appendChild(readHeader());
  root.appendChild(h("div", { class: "sb-hr" }));
  const info = readInfo();
  root.appendChild(info);
  enhanceRolls(info, sendRoll); // те же числа-формулы в свободном тексте (спасброски/навыки/КД/ХП...), что и в прозе ниже
  root.appendChild(h("div", { class: "sb-hr" }));
  root.appendChild(readAbilityGrid());

  const spells = spellsSection(true);
  const inv = invSection(true);
  const blocks = [
    proseBlock("Особенности", monster.traits),
    proseBlock("Действия", monster.actions),
    proseBlock("Бонусные действия", monster.bonusActions),
    proseBlock("Реакции", monster.reactions),
    // Вступление и сами действия склеиваются пустой строкой, а не через
    // <p>…</p>: после HTML-блока marked считает следующие строки его
    // продолжением и markdown в них не разбирает — названия действий так и
    // оставались текстом "**Рывок.**" вместо жирного.
    proseBlock("Легендарные действия", [monster.legendaryActionsIntro, monster.legendaryActions].filter(Boolean).join("\n\n")),
    proseBlock("Действия и эффекты логова", monster.lairActions),
    proseBlock("Описание", monster.description),
  ].filter(Boolean);
  if (spells || inv || blocks.length) root.appendChild(h("div", { class: "sb-hr" }));
  if (spells) root.appendChild(spells);
  if (inv) root.appendChild(inv);
  blocks.forEach((b) => root.appendChild(b));
}

// applyImport — общая точка для файла и вставленного текста: парсит JSON,
// мапит через mapFoundryMonsterJson (см. web/src/monster-import.js), мержит
// результат в monster (переписывает только пришедшие поля — существующие
// теги/заклинания монстра, которых импорт не касается, сохраняются) и
// перерисовывает карточку целиком, тем же приёмом, что и у карточки
// заклинания (см. web/src/pages/spellbook.js: applyImport).
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
  return h("div", { class: "section", id: "importSection" }, [
    h("h3", { text: "Импорт из TTG Club" }),
    h("p", { class: "hint" }, "На странице существа на 5e14.ttg.club нажми «Экспорт для FVTT» и сохрани JSON-файл — выбери его ниже (или вставь содержимое текстом). Поля карточки заменятся тем, что удастся разобрать из файла; уже добавленные заклинания и теги не трогаются."),
    field("Файл экспорта", fileInput),
    textarea,
    importBtn,
    msg,
  ]);
}

function spellLevelLabel(lvl) {
  return lvl ? lvl + "-й круг" : "Заговор";
}

// spellsSection — список заклинаний монстра (domain.MonsterSpellRef).
// Добавление — только из панели "Заклинания" ДМ (там виден весь стол и
// выбор целей сразу), здесь можно только посмотреть карточку и (в
// редактировании) убрать заклинание из списка — readOnly скрывает ✕, читает
// то же самое, чем пользуется read-режим (renderReadView).
function spellsSection(readOnly) {
  const list = h("div", { class: "spell-ref-list" });
  function renderList() {
    list.innerHTML = "";
    if (monster.spells.length === 0) {
      if (readOnly) return; // read-режим не занимает место под пустой список — как остальные пустые блоки
      list.appendChild(h("p", { class: "hint", text: "Заклинаний нет — добавь их из панели «Заклинания» ДМ." }));
      return;
    }
    monster.spells.forEach((ref, i) => {
      const name = h("span", { class: "spell-ref-name", text: ref.name });
      if (ref.spellId) {
        name.classList.add("clickable");
        name.title = "Открыть карточку заклинания";
        // bestiary.js уже сам живёт внутри плавающего окна (floating-window.js
        // рендерит его в iframe) — вкладывать туда ещё один плавающий менеджер
        // окон незачем, поэтому просто открываем обычной вкладкой браузера
        // (тот же приём, что popoutBtn в floating-window.js).
        name.onclick = () => window.open(`/spellbook.html?id=${ref.spellId}`, "spell-" + ref.spellId);
      }
      const row = [name, h("span", { class: "spell-ref-level", text: spellLevelLabel(ref.level) })];
      if (!readOnly) {
        row.push(h("button", { type: "button", html: icon("close", { size: 11 }), title: "Убрать из списка", onclick: () => { monster.spells.splice(i, 1); scheduleSave(); renderList(); } }));
      }
      list.appendChild(h("div", { class: "spell-ref-row" }, row));
    });
  }
  renderList();
  if (readOnly && monster.spells.length === 0) return null; // ничего показывать не нужно
  return h("div", { class: readOnly ? "sb-block" : "section" }, [h("h3", { class: readOnly ? "sb-section-title" : undefined, text: "Заклинания" }), list]);
}

// invSection — шаблон добычи монстра (domain.Monster.Inventory, см. план
// фичи). В отличие от spellsSection, добавление тут же, в редакторе (через
// item-picker.js) — не в отдельной панели ДМ, каталог предметов не тащит за
// собой того же "кому назначить"/выбора цели, что у заклинаний.
function invSection(readOnly) {
  const list = h("div", { class: "inv-ref-list" });
  function renderList() {
    list.innerHTML = "";
    if (monster.inventory.length === 0) {
      if (readOnly) return; // read-режим не занимает место под пустой список
      list.appendChild(h("p", { class: "hint", text: "Инвентарь пуст — добавь предметы из каталога ниже." }));
      return;
    }
    monster.inventory.forEach((e, i) => {
      const avatar = h("div", { class: "inv-avatar" });
      if (e.imageUrl) avatar.style.backgroundImage = `url("${e.imageUrl}")`;
      const name = h("span", { class: "spell-ref-name", text: e.name });
      const weight = h("span", { class: "spell-ref-level", text: (e.weightLb || 0) + " фнт" });
      const row = [avatar, name, weight];
      if (readOnly) {
        row.push(h("span", { class: "spell-ref-level", text: "×" + e.quantity }));
      } else {
        const qty = h("input", { type: "number", min: "0", value: String(e.quantity), style: "width:52px;" });
        qty.addEventListener("change", () => {
          e.quantity = parseInt(qty.value, 10) || 0;
          scheduleSave();
        });
        row.push(qty);
        row.push(
          h("button", {
            type: "button",
            html: icon("close", { size: 11 }),
            title: "Убрать из списка",
            onclick: () => {
              monster.inventory.splice(i, 1);
              scheduleSave();
              renderList();
            },
          })
        );
      }
      list.appendChild(h("div", { class: "spell-ref-row" }, row));
    });
  }
  renderList();
  if (readOnly && monster.inventory.length === 0) return null;

  const block = h("div", { class: readOnly ? "sb-block" : "section" }, [
    h("h3", { class: readOnly ? "sb-section-title" : undefined, text: "Инвентарь (лут)" }),
    list,
  ]);
  if (!readOnly) {
    const pickerWrap = h("div", { style: "margin-top:8px;" });
    block.appendChild(pickerWrap);
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
      },
    });
  }
  return block;
}

function tagsField() {
  const wrap = h("div", {});
  const list = h("div", { class: "tag-list" });
  function renderTags() {
    list.innerHTML = "";
    monster.tags.forEach((tag, i) => {
      list.appendChild(
        h("span", { class: "tag-pill" }, [tag, h("button", { type: "button", html: icon("close", { size: 11 }), onclick: () => { monster.tags.splice(i, 1); scheduleSave(); renderTags(); } })])
      );
    });
  }
  renderTags();
  const input = h("input", { type: "text", placeholder: "тег + Enter (биом/источник/кампания)" });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const v = input.value.trim();
    if (!v) return;
    monster.tags.push(v);
    input.value = "";
    scheduleSave();
    renderTags();
  });
  wrap.append(field("Теги", input), list);
  return wrap;
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
    monster = normalizeMonster(await updateMonster(monsterId, monster));
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
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  rollWS = new WebSocket(`${scheme}//${location.host}/ws/dm`);
  rollWS.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
    if (data.type === "roll_result") showRollResult(data);
  };
}

function sendRoll(formula, label) {
  if (!rollWS || rollWS.readyState !== WebSocket.OPEN) return;
  const fullLabel = monster && monster.name ? `${monster.name} — ${label || ""}`.trim().replace(/ —$/, "") : label;
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
  if (!me || me.role !== "admin") {
    location.href = "/";
    return;
  }
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
  if (monster.system) {
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
  renderApp();

  document.getElementById("loadingHint").style.display = "none";
  document.getElementById("app").classList.add("ready");

  connectRollSocket();
})();
