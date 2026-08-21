// catalog.js — список одной категории компендиума (см. compendium-menu.js),
// открывается как floating window (см. openFloatingWindow) поверх канваса
// dm.html/player.html, с параметрами через query string: type
// (creatures|spells|items|reference), system (0|1 — какой корень дерева:
// Beacon Table/Пользовательские), role (dm|player — только для виджета
// "добавить заклинание"), kind (для reference) / category (для items),
// title (заголовок окна).
//
// Функционально — перенос renderBestiaryRows/renderSpellRows/renderItemRows/
// renderReferenceRows и их refresh*/create*/delete*/импорт-обработчиков из
// dm.js/player.js в одну параметризованную страницу вместо четырёх копий.
//
// Эта страница живёт в iframe (см. floating-window.js), поэтому НЕ может
// звать openFloatingWindow напрямую (это функция топ-документа) — открытие
// карточки записи просит топ-документ сделать это через postMessage
// "beacon:openFloatingWindow" (слушатель — в dm.js/player.js). Обратный путь
// (обновить список после правки карточки в открытом из него окне) идёт через
// floating-window.js: postToOpenWindows("catalog-", ...) — топ-документ
// форвардит "beacon:*Saved" сюда же.
import { fetchMe } from "../api.js";
import { icon } from "../icons.js";
import {
  fetchBestiary, createMonster, updateMonster, deleteMonster, fetchMonster,
  fetchSpells, createSpell, updateSpell, deleteSpell,
  fetchItems, createItem, updateItem, deleteItem,
  fetchReferences, createReference, updateReference, deleteReference,
  fetchConditions, createCondition, updateCondition, deleteCondition,
  fetchAdminCharacters, fetchAdminCharacter, updateAdminCharacterSheet,
  fetchCharacters, fetchCharacter, updateCharacterSheet,
} from "../api.js";
import { mapFoundryMonsterJson } from "../monster-import.js";
import { mapFoundrySpellJson } from "../spell-import.js";
import { mapFoundryItemJson } from "../item-import.js";
import { mapFoundryReferenceBatch } from "../reference-import.js";
import { mapFoundryConditionBatch } from "../condition-import.js";
import { classifyItemType, classifyReferenceKind } from "../compendium-taxonomy.js";

const qs = new URLSearchParams(location.search);
const type = qs.get("type");
const systemScope = qs.get("system") === "1";
const role = qs.get("role") === "dm" ? "dm" : "player";
const kind = qs.get("kind") || "";
const category = qs.get("category") || "";
const title = qs.get("title") || "Компендиум";

function spellLevelLabel(lvl) {
  return lvl ? lvl + "-й круг" : "Заговор";
}

// ==================== per-type конфигурация ====================

let spellTargets = { characters: [], monsters: [] };

async function addSpellToTarget(spell, kind2, id) {
  if (kind2 === "character") {
    const c = await fetchAdminCharacter(id);
    const sheet = c.sheet;
    sheet.preparedSpells = Array.isArray(sheet.preparedSpells) ? sheet.preparedSpells : [];
    sheet.preparedSpells.push({
      level: spell.level || 0, name: spell.name, castTime: spell.castTime || "", range: spell.range || "",
      concentration: !!spell.concentration, ritual: !!spell.ritual, material: !!spell.material, notes: "",
    });
    await updateAdminCharacterSheet(id, sheet);
  } else if (kind2 === "monster") {
    const m = await fetchMonster(id);
    m.spells = Array.isArray(m.spells) ? m.spells : [];
    m.spells.push({ spellId: spell.id, name: spell.name, level: spell.level || 0 });
    await updateMonster(id, m);
  }
}

async function addSpellToMyCharacter(spell, characterId) {
  const c = await fetchCharacter(characterId);
  const sheet = c.sheet;
  sheet.preparedSpells = Array.isArray(sheet.preparedSpells) ? sheet.preparedSpells : [];
  sheet.preparedSpells.push({
    level: spell.level || 0, name: spell.name, castTime: spell.castTime || "", range: spell.range || "",
    concentration: !!spell.concentration, ritual: !!spell.ritual, material: !!spell.material, notes: "",
  });
  await updateCharacterSheet(characterId, sheet);
}

function renderSpellAddWidget(row, s) {
  const addWrap = document.createElement("div");
  addWrap.className = "catalog-target";
  const select = document.createElement("select");
  if (role === "dm") {
    select.appendChild(new Option("Добавить…", ""));
    if (spellTargets.characters.length) {
      const g = document.createElement("optgroup");
      g.label = "Персонажи";
      for (const c of spellTargets.characters) g.appendChild(new Option("🧑 " + c.name, "character:" + c.id));
      select.appendChild(g);
    }
    if (spellTargets.monsters.length) {
      const g = document.createElement("optgroup");
      g.label = "Бестиарий";
      for (const m of spellTargets.monsters) g.appendChild(new Option("🐉 " + m.name, "monster:" + m.id));
      select.appendChild(g);
    }
  } else {
    select.appendChild(new Option("Добавить моему персонажу…", ""));
    for (const c of spellTargets.characters) select.appendChild(new Option(c.name, c.id));
  }
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.innerHTML = icon("plus", { size: 13 });
  addBtn.title = role === "dm" ? "Добавить это заклинание выбранной цели" : "Добавить заклинание в лист выбранного персонажа";
  addBtn.onclick = async () => {
    if (!select.value) return;
    addBtn.disabled = true;
    try {
      if (role === "dm") {
        const [k, id] = select.value.split(":");
        if (!k || !id) return;
        await addSpellToTarget(s, k, id);
      } else {
        await addSpellToMyCharacter(s, select.value);
      }
      select.value = "";
    } catch (err) {
      alert("Не удалось добавить: " + err.message);
    } finally {
      addBtn.disabled = false;
    }
  };
  addWrap.append(select, addBtn);
  row.appendChild(addWrap);
}

const CONFIGS = {
  creatures: {
    fetchAll: fetchBestiary,
    createOne: createMonster,
    updateOne: updateMonster,
    deleteOne: deleteMonster,
    keyPrefix: "monster",
    detailUrl: (id, o) => `/bestiary.html?id=${id}` + (o && o.edit ? "&edit=1" : ""),
    mapOne: mapFoundryMonsterJson,
    avatar: true,
    searchHay: (m) => [m.name, m.type, ...(m.tags || [])],
    badge: (m) => (m.cr ? "CR " + m.cr : "—"),
    draggable: true,
    dragMime: "application/x-beacon-monster",
    createPlaceholder: "Имя нового монстра",
    emptyUser: "Своих монстров пока нет — создай первого ниже.",
    deleteConfirm: (m) => `Удалить «${m.name}» из бестиария? Это необратимо (уже расставленные токены останутся на карте, но перестанут открывать статблок).`,
    savedMessageType: "beacon:monsterSaved",
  },
  spells: {
    fetchAll: fetchSpells,
    createOne: createSpell,
    updateOne: updateSpell,
    deleteOne: deleteSpell,
    keyPrefix: "spell",
    detailUrl: (id, o) => `/spellbook.html?id=${id}` + (o && o.edit ? "&edit=1" : ""),
    mapOne: mapFoundrySpellJson,
    avatar: false,
    searchHay: (s) => [s.name, s.school, s.classes, ...(s.tags || [])],
    badge: (s) => spellLevelLabel(s.level),
    createPlaceholder: "Имя нового заклинания",
    emptyUser: "Своих заклинаний пока нет — создай или импортируй первое ниже.",
    deleteConfirm: (s) => `Удалить «${s.name}» из библиотеки?`,
    savedMessageType: "beacon:spellSaved",
    extraWidget: renderSpellAddWidget,
  },
  items: {
    fetchAll: fetchItems,
    createOne: createItem,
    updateOne: updateItem,
    deleteOne: deleteItem,
    keyPrefix: "item",
    detailUrl: (id, o) => `/itembook.html?id=${id}` + (o && o.edit ? "&edit=1" : ""),
    mapOne: mapFoundryItemJson,
    avatar: true,
    searchHay: (it) => [it.name, it.type, it.rarity, ...(it.tags || [])],
    badge: (it) => it.rarity || "",
    createPlaceholder: "Имя нового предмета",
    emptyUser: "Своих предметов пока нет — создай или импортируй первый ниже.",
    deleteConfirm: (it) => `Удалить «${it.name}» из библиотеки?`,
    savedMessageType: "beacon:itemSaved",
    extraFilter: category ? (it) => classifyItemType(it.type) === category : null,
  },
  reference: {
    fetchAll: fetchReferences,
    createOne: createReference,
    updateOne: updateReference,
    deleteOne: deleteReference,
    keyPrefix: "reference",
    detailUrl: (id, o) => `/referencebook.html?id=${id}` + (o && o.edit ? "&edit=1" : ""),
    batchMap: mapFoundryReferenceBatch,
    batchEmptyMsg: "Не удалось распознать ни одной записи справочника (нужен класс/архетип/черта Foundry VTT).",
    avatar: true,
    searchHay: (ref) => [ref.name, ref.kind, ref.parentName, ref.source, ...(ref.tags || [])],
    badge: (ref) => ref.kind || "",
    nameText: (ref) => (ref.parentName ? `${ref.name} (${ref.parentName})` : ref.name),
    createPlaceholder: "Имя новой записи",
    emptyUser: "Своих записей пока нет — создай или импортируй первую ниже.",
    deleteConfirm: (ref) => `Удалить «${ref.name}» из библиотеки?`,
    savedMessageType: "beacon:referenceSaved",
    extraFilter: kind ? (ref) => classifyReferenceKind(ref.kind) === kind : null,
  },
  conditions: {
    fetchAll: fetchConditions,
    createOne: createCondition,
    updateOne: updateCondition,
    deleteOne: deleteCondition,
    keyPrefix: "condition",
    detailUrl: (id, o) => `/conditions.html?id=${id}` + (o && o.edit ? "&edit=1" : ""),
    batchMap: mapFoundryConditionBatch,
    batchEmptyMsg: "Не удалось распознать ни одного эффекта (нужен документ ActiveEffect из Foundry VTT или предмет/существо с массивом effects).",
    // avatar+avatarText: у состояния картинка чаще всего не загружена, а
    // задан эмодзи-глиф (domain.Condition.Icon) — показываем в кружке его,
    // а не прочерк, чтобы список читался так же, как палитра.
    avatar: true,
    avatarText: (c) => c.icon || "❔",
    searchHay: (c) => [c.name, c.slug, c.source, ...(c.tags || [])],
    badge: (c) => (c.levels > 1 ? `${c.levels} ур.` : c.slug || ""),
    createPlaceholder: "Имя нового состояния",
    emptyUser: "Своих состояний пока нет — создай или импортируй первое ниже.",
    deleteConfirm: (c) => `Удалить «${c.name}» из библиотеки? Уже наложенные метки останутся висеть на токенах, но потеряют описание.`,
    savedMessageType: "beacon:conditionSaved",
  },
};
const cfg = CONFIGS[type];

// ==================== DOM ====================

const rowsEl = document.getElementById("catalogRows");
const searchEl = document.getElementById("catalogSearch");
const createForm = document.getElementById("catalogCreateForm");
const createNameInput = document.getElementById("catalogCreateName");
const importLabel = document.getElementById("catalogImportLabel");
const importFile = document.getElementById("catalogImportFile");
const importProgressEl = document.getElementById("catalogImportProgress");
const systemHintEl = document.getElementById("catalogSystemHint");

document.getElementById("catalogTitle").textContent = title;
document.title = "Beacon Table — " + title;

function openDetail(record, opts) {
  window.parent.postMessage(
    { type: "beacon:openFloatingWindow", key: cfg.keyPrefix + "-" + record.id, title: record.name, url: cfg.detailUrl(record.id, opts) },
    location.origin
  );
}

let list = [];

async function refresh() {
  try {
    list = await cfg.fetchAll();
  } catch (err) {
    rowsEl.innerHTML = `<p class="hint">Ошибка: ${err.message}</p>`;
    return;
  }
  renderRows();
}

function buildRow(x) {
  const row = document.createElement("div");
  row.className = "catalog-row";
  if (cfg.draggable) {
    row.draggable = true;
    row.title = "Перетащи на карту, чтобы поставить токен";
    row.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData(cfg.dragMime, x.id);
      e.dataTransfer.effectAllowed = "copy";
    });
  }
  if (cfg.avatar) {
    const avatar = document.createElement("div");
    avatar.className = "catalog-avatar";
    if (x.imageUrl) avatar.style.backgroundImage = `url("${x.imageUrl}")`;
    else avatar.textContent = cfg.avatarText ? cfg.avatarText(x) : "—";
    row.appendChild(avatar);
  }
  const name = document.createElement("div");
  name.className = "catalog-name";
  name.textContent = cfg.nameText ? cfg.nameText(x) : x.name;
  name.title = x.name;
  name.onclick = () => openDetail(x);
  row.appendChild(name);

  const badgeText = cfg.badge ? cfg.badge(x) : "";
  if (badgeText) {
    const badge = document.createElement("span");
    badge.className = "catalog-badge";
    badge.textContent = badgeText;
    row.appendChild(badge);
  }

  // Каталог "из коробки" (System, см. соответствующий system.go у каждого
  // репозитория) — только для чтения, та же логика для всех 4 типов.
  if (x.system) {
    const badge = document.createElement("span");
    badge.className = "catalog-sys-badge";
    badge.title = "Карточка каталога «из коробки» — только для чтения";
    badge.innerHTML = icon("lock", { size: 11 });
    badge.append(" каталог");
    row.appendChild(badge);
  } else {
    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn";
    delBtn.innerHTML = icon("trash", { size: 13 });
    delBtn.title = "Удалить из библиотеки";
    delBtn.onclick = async () => {
      if (!confirm(cfg.deleteConfirm(x))) return;
      try {
        await cfg.deleteOne(x.id);
        await refresh();
      } catch (err) {
        alert("Не удалось удалить: " + err.message);
      }
    };
    row.appendChild(delBtn);
  }

  if (cfg.extraWidget) cfg.extraWidget(row, x);
  return row;
}

function renderRows() {
  const filter = searchEl.value.trim().toLowerCase();
  rowsEl.innerHTML = "";
  let onScope = list.filter((x) => !!x.system === systemScope);
  if (cfg.extraFilter) onScope = onScope.filter(cfg.extraFilter);
  const filtered = onScope.filter((x) => {
    if (!filter) return true;
    return cfg.searchHay(x).join(" ").toLowerCase().includes(filter);
  });
  if (filtered.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = onScope.length === 0 ? (systemScope ? "Каталог «из коробки» пуст." : cfg.emptyUser) : "Ничего не найдено.";
    rowsEl.appendChild(empty);
    return;
  }
  for (const x of filtered) rowsEl.appendChild(buildRow(x));
}
searchEl.oninput = renderRows;

// ==================== создание ====================

createForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = createNameInput.value.trim();
  if (!name) return;
  try {
    const created = await cfg.createOne(name);
    createNameInput.value = "";
    await refresh();
    // ?edit=1 — пустая карточка, смотреть там всё равно не на что, сразу в редактирование.
    openDetail(created, { edit: true });
  } catch (err) {
    alert("Не удалось создать: " + err.message);
  }
});

// ==================== импорт ====================
// Каждый выбранный файл — либо один документ Foundry, либо массив документов
// (распакованный целиком пак) — оба варианта разворачиваются в общий плоский
// список раньше маппинга. Для reference маппер батчевый (архетипу нужно
// резолвить родителя по всем документам сразу, см. reference-import.js), для
// остальных — по документу за раз, внутри своего try (ошибка одного файла не
// прерывает остальные при массовом импорте).
importFile.addEventListener("change", async (e) => {
  const input = e.target;
  const files = [...input.files];
  if (!files.length) return;

  let raws = [];
  try {
    for (const file of files) {
      const parsed = JSON.parse(await file.text());
      raws.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    }
  } catch (err) {
    alert("Не удалось прочитать файл: " + err.message);
    input.value = "";
    return;
  }

  let mappedList = raws; // per-doc типы: карта лениво внутри try ниже
  if (cfg.batchMap) {
    mappedList = cfg.batchMap(raws);
    if (mappedList.length === 0) {
      alert(cfg.batchEmptyMsg);
      input.value = "";
      return;
    }
  }

  if (mappedList.length === 1) {
    try {
      const mapped = cfg.batchMap ? mappedList[0] : cfg.mapOne(mappedList[0]);
      const created = await cfg.createOne(mapped.name);
      const saved = await cfg.updateOne(created.id, Object.assign({}, created, mapped));
      await refresh();
      openDetail(saved);
    } catch (err) {
      alert("Не удалось импортировать: " + err.message);
    } finally {
      input.value = "";
    }
    return;
  }

  importProgressEl.style.display = "block";
  let ok = 0;
  const errors = [];
  for (let i = 0; i < mappedList.length; i++) {
    importProgressEl.textContent = `Импорт: ${i + 1} из ${mappedList.length}…`;
    try {
      const mapped = cfg.batchMap ? mappedList[i] : cfg.mapOne(mappedList[i]);
      const created = await cfg.createOne(mapped.name);
      await cfg.updateOne(created.id, Object.assign({}, created, mapped));
      ok++;
    } catch (err) {
      errors.push(`${(mappedList[i] && mappedList[i].name) || i}: ${err.message}`);
    }
  }
  importProgressEl.textContent = `Готово: ${ok} из ${mappedList.length} импортировано.` + (errors.length ? ` Ошибок: ${errors.length} (см. консоль браузера).` : "");
  if (errors.length) console.warn(`Ошибки массового импорта (${type}):\n` + errors.join("\n"));
  await refresh();
  input.value = "";
});

// ==================== закрыть / автообновление ====================

document.getElementById("closeBtn").onclick = () => {
  if (window.parent !== window) {
    window.parent.postMessage({ type: "beacon:closeFloatingWindow" }, location.origin);
  } else {
    window.close();
  }
};

// Форвардится сюда из dm.js/player.js: floating-window.js:postToOpenWindows —
// сама карточка (spellbook.js/itembook.js/...) шлёт "beacon:*Saved" своему
// непосредственному родителю (топ-документ), не этому iframe напрямую.
window.addEventListener("message", (e) => {
  if (e.origin !== location.origin) return;
  if (e.data && e.data.type === cfg.savedMessageType) refresh();
});

// ==================== boot ====================

(async function boot() {
  const me = await fetchMe();
  if (!me) {
    location.href = "/";
    return;
  }
  if (!cfg) {
    rowsEl.innerHTML = `<p class="hint">Неизвестный тип каталога: ${type}</p>`;
    createForm.style.display = "none";
    importLabel.style.display = "none";
    return;
  }
  if (systemScope) {
    createForm.style.display = "none";
    importLabel.style.display = "none";
    systemHintEl.style.display = "";
  }
  if (type === "spells") {
    try {
      if (role === "dm") {
        const [chars, monsters] = await Promise.all([fetchAdminCharacters(), fetchBestiary()]);
        spellTargets.characters = chars;
        spellTargets.monsters = monsters.filter((m) => !m.system);
      } else {
        spellTargets.characters = await fetchCharacters();
      }
    } catch {
      /* виджет "добавить" просто останется пустым — не критично для списка */
    }
  }
  await refresh();
})();
