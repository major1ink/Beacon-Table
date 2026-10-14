// lss-import.js — перевод экспорта персонажа с сайта Long Story Short (lss)
// в наш domain.CharacterSheet (см. internal/domain/character_sheet.go).
// Формат: внешний объект {jsonType:"character", data: "<JSON-строка>", ...},
// внутри data — сам лист (info/subInfo/stats/vitality/text.*/weaponsList/...),
// text.* — rich-text блоки в формате ProseMirror ({type:"doc", content:[...]})
// с сайта-редактора. Примеры файлов приложил пользователь при постановке
// задачи (Днд2024/Днд2014 — Long Story Short.json).
//
// По духу — как spell-import.js: чистый разбор без побочных эффектов и без
// знания о правилах PHB (см. "умный бланк" в domain/character_sheet.go),
// плюс applyLssImport — единственная сайд-эффектная функция модуля,
// напрямую мутирует переданный sheet (так же, как остальной
// character-sheet.js работает с sheet через геттеры/сеттеры, а не
// иммутабельно) — вводить здесь отдельную "patch + generic deep merge"
// абстракцию избыточно ради одного места использования.

// ==================== ProseMirror doc -> текст ====================

function extractText(node) {
  if (!node) return "";
  if (typeof node.text === "string") return node.text;
  if (!Array.isArray(node.content)) return "";
  const joiner = node.type === "paragraph" || node.type === "heading" || node.type === "list_item" ? "" : "\n";
  return node.content.map(extractText).join(joiner);
}

// docToText — весь документ одной строкой (параграфы через перевод строки,
// пустой параграф — пустая строка, marks вроде bold игнорируются: наши поля
// — обычные textarea, не rich text). Схлопывает 3+ переводов строки подряд.
function docToText(doc) {
  if (!doc || typeof doc !== "object") return "";
  return extractText(doc).replace(/\n{3,}/g, "\n\n").trim();
}

// docParagraphs — параграфы документа как отдельные непустые строки (для
// списков заклинаний по уровням: один параграф = одно заклинание).
function docParagraphs(doc) {
  if (!doc || !Array.isArray(doc.content)) return [];
  return doc.content
    .map(extractText)
    .map((s) => s.trim())
    .filter(Boolean);
}

function docOf(fieldWrapper) {
  return fieldWrapper && fieldWrapper.value && fieldWrapper.value.data;
}

function val(fieldWrapper) {
  return fieldWrapper && fieldWrapper.value !== undefined ? fieldWrapper.value : undefined;
}

function strVal(fieldWrapper) {
  const v = val(fieldWrapper);
  return typeof v === "string" ? v : "";
}

// ==================== парсинг файла ====================

// parseLssExport — чистая функция, бросает Error с понятным текстом на
// нераспознанном файле. Возвращает {data, edition} — data это уже
// распарсенное содержимое внутренней JSON-строки "data".
export function parseLssExport(rawText) {
  let outer;
  try {
    outer = JSON.parse(rawText);
  } catch {
    throw new Error("Не удалось разобрать JSON — проверь, что это файл экспорта листа с Long Story Short.");
  }
  if (!outer || typeof outer !== "object" || outer.jsonType !== "character" || typeof outer.data !== "string") {
    throw new Error("Файл не похож на экспорт листа персонажа с Long Story Short.");
  }
  let data;
  try {
    data = JSON.parse(outer.data);
  } catch {
    throw new Error("Не удалось разобрать содержимое листа внутри файла экспорта.");
  }
  if (!data || typeof data !== "object" || data.jsonType !== "character") {
    throw new Error("Файл не похож на экспорт листа персонажа с Long Story Short.");
  }
  return { data, edition: outer.edition || data.edition || "" };
}

// ==================== применение к листу ====================

// appendOrSet — для длинных текстовых полей: пустое целевое поле —
// подставляем как есть, непустое — дописываем снизу через разделитель,
// чтобы импорт никогда молча не стирал то, что уже написал игрок (тот же
// принцип "ничего не пропадает молча", что и в spell-import.js).
function appendOrSet(current, incoming) {
  const inc = (incoming || "").trim();
  if (!inc) return current;
  const cur = (current || "").trim();
  if (!cur) return inc;
  return cur + "\n\n---\n\n" + inc;
}

const SPELL_LEVELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

const ABILITY_KEYS = ["str", "dex", "con", "int", "wis", "cha"];

// prepareLssSheet — дозаполняет в sheet структуры бланка D&D, в которые
// пишет импорт (у листа другой системы или нового персонажа их может не
// быть), не трогая то, что уже есть. Идемпотентна.
export function prepareLssSheet(sheet) {
  const s = sheet;
  s.info = s.info || {};
  if (!s.info.level) s.info.level = 1;
  s.abilities = s.abilities || {};
  for (const key of ABILITY_KEYS) if (!s.abilities[key]) s.abilities[key] = 10;
  s.saveProf = s.saveProf || {};
  for (const key of ABILITY_KEYS) if (s.saveProf[key] === undefined) s.saveProf[key] = false;
  s.skillProf = s.skillProf || {};
  s.armor = s.armor || {};
  s.combat = s.combat || {};
  s.weapons = Array.isArray(s.weapons) ? s.weapons : [];
  s.spellcasting = s.spellcasting || {};
  s.spellcasting.ability = s.spellcasting.ability || "";
  // Ячейки заклинаний — массив из 9 строк; то, что уже записано (лист по
  // схеме пишет ячейки по номеру круга), сохраняем.
  const slots = s.spellcasting.slotsByLevel;
  s.spellcasting.slotsByLevel = Array.from({ length: 9 }, (_, i) => {
    const v = slots && typeof slots === "object" ? slots[i] : "";
    return v === undefined || v === null ? "" : v;
  });
  s.preparedSpells = Array.isArray(s.preparedSpells) ? s.preparedSpells : [];
  // Черты характера — на обеих системах, race/species — у «чужой» системы
  // остаются пустой строкой, ничего не отображающей.
  for (const key of ["personalityTraits", "ideals", "bonds", "flaws", "traits", "proficiencyNotes"]) s[key] = s[key] || "";
  for (const key of ["race", "species", "playerName"]) s.info[key] = s.info[key] || "";
  s.physical = s.physical || {};
  for (const k of ["age", "height", "weight", "eyes", "skin", "hair"]) s.physical[k] = s.physical[k] || "";
  s.combat.darkvision = s.combat.darkvision || 0;
  s.combat.isDying = !!s.combat.isDying;
  // Настройка на предметы — список строк; как минимум три, как привычные
  // «3 слота», но можно добавлять и удалять.
  s.attunementItems = Array.isArray(s.attunementItems) ? s.attunementItems.slice() : [];
  while (s.attunementItems.length < 3) s.attunementItems.push({ name: "", attuned: false });
  return s;
}

// applyLssImport — мутирует sheet (сначала prepareLssSheet). targetIsClassic — система
// ОТКРЫТОГО персонажа (sheetHasRace()), а не файла: определяет race/species и
// используется только для предупреждения о несовпадении редакции, разбор
// остальных полей от неё не зависит. Возвращает {name, warnings} для
// сообщения в UI.
export function applyLssImport(sheet, parsed, targetIsClassic) {
  prepareLssSheet(sheet);
  const data = parsed.data;
  const info = data.info || {};
  const subInfo = data.subInfo || {};
  const vitality = data.vitality || {};
  const spellsInfo = data.spellsInfo || {};
  const spells = data.spells || {};
  const text = data.text || {};
  const warnings = [];

  const wantEdition = targetIsClassic ? "2014" : "2024";
  if (parsed.edition && parsed.edition !== wantEdition) {
    warnings.push(`Файл экспортирован как D&D ${parsed.edition}, лист персонажа — D&D ${wantEdition}: часть терминологии может не совпадать.`);
  }

  // ---- info/шапка ----
  if (strVal(info.background)) sheet.info.background = strVal(info.background);
  if (strVal(info.charClass)) sheet.info.class = strVal(info.charClass);
  if (strVal(info.charSubclass)) sheet.info.subclass = strVal(info.charSubclass);
  if (strVal(info.playerName)) sheet.info.playerName = strVal(info.playerName);
  if (typeof val(info.level) === "number" && val(info.level) > 0) sheet.info.level = val(info.level);
  if (strVal(info.race)) {
    if (targetIsClassic) sheet.info.race = strVal(info.race);
    else sheet.info.species = strVal(info.race);
  }
  if (strVal(info.alignment)) sheet.alignment = strVal(info.alignment);
  const xpMatch = /\d+/.exec(strVal(info.experience));
  if (xpMatch) sheet.info.xp = parseInt(xpMatch[0], 10);

  // ---- физические данные ----
  for (const key of ["age", "height", "weight", "eyes", "skin", "hair"]) {
    const v = strVal(subInfo[key]);
    if (v) sheet.physical[key] = v;
  }

  // ---- характеристики, спасброски, владения навыками ----
  const stats = data.stats || {};
  for (const a of ["str", "dex", "con", "int", "wis", "cha"]) {
    const score = stats[a] && stats[a].score;
    if (typeof score === "number") sheet.abilities[a] = score;
  }
  const saves = data.saves || {};
  for (const a of ["str", "dex", "con", "int", "wis", "cha"]) {
    const isProf = saves[a] && saves[a].isProf;
    if (typeof isProf === "boolean") sheet.saveProf[a] = isProf;
  }
  // data.abilities — более новый/полный набор навыков: isProf проставлен
  // явно у каждого (включая непрофильные — false/0). data.skills — тот же
  // список навыков, но isProf присутствует только у отмеченных владений
  // (см. пример файла из задачи: оба объекта есть одновременно, ключи с
  // пробелом как в LSS — "sleight of hand", "animal handling" — маппим на
  // camelCase ключи SKILLS в character-sheet.js).
  const SKILL_KEY_MAP = {
    athletics: "athletics",
    acrobatics: "acrobatics",
    "sleight of hand": "sleightOfHand",
    stealth: "stealth",
    investigation: "investigation",
    history: "history",
    arcana: "arcana",
    nature: "nature",
    religion: "religion",
    perception: "perception",
    survival: "survival",
    medicine: "medicine",
    insight: "insight",
    "animal handling": "animalHandling",
    performance: "performance",
    intimidation: "intimidation",
    deception: "deception",
    persuasion: "persuasion",
  };
  const skillsSrc = Object.keys(data.abilities || {}).length ? data.abilities : data.skills;
  for (const [lssKey, sheetKey] of Object.entries(SKILL_KEY_MAP)) {
    const entry = skillsSrc && skillsSrc[lssKey];
    if (!entry || entry.isProf === undefined) continue;
    sheet.skillProf[sheetKey] = entry.isProf === true || entry.isProf === 1 ? 1 : 0;
  }

  // ---- заклинательная статистика ----
  const spellCode = spellsInfo.base && spellsInfo.base.code;
  if (spellCode) sheet.spellcasting.ability = spellCode;
  for (const key of Object.keys(spells)) {
    const m = /^slots-(\d)$/.exec(key);
    if (!m) continue;
    const lvl = parseInt(m[1], 10);
    const slotVal = val(spells[key]);
    if (lvl >= 1 && lvl <= 9 && slotVal !== undefined && slotVal !== null) {
      sheet.spellcasting.slotsByLevel[lvl - 1] = String(slotVal);
    }
  }

  // ---- боевые показатели ----
  // AC и КД на lss хранятся как value:number почти всегда, но в некоторых
  // экспортах (см. пример из задачи) ac.value — строка "14", а не число —
  // поэтому здесь и ниже парсим через parseInt вместо строгой проверки типа.
  const acVal = val(vitality.ac);
  if (acVal !== undefined) {
    const n = parseInt(acVal, 10);
    if (!Number.isNaN(n)) sheet.combat.ac = n;
  }
  const speedVal = val(vitality.speed);
  if (speedVal !== undefined) {
    const n = parseInt(speedVal, 10);
    if (!Number.isNaN(n)) sheet.combat.speed = n;
  }
  if (typeof val(vitality.darkvision) === "number") sheet.combat.darkvision = val(vitality.darkvision);
  const hpMaxVal = val(vitality["hp-max"]);
  if (hpMaxVal !== undefined) {
    const n = parseInt(hpMaxVal, 10);
    if (!Number.isNaN(n)) sheet.combat.hpMax = n;
  }
  const hpCurrentVal = val(vitality["hp-current"]);
  if (hpCurrentVal !== undefined) {
    const n = parseInt(hpCurrentVal, 10);
    if (!Number.isNaN(n)) sheet.combat.hpCurrent = n;
  }
  if (typeof vitality.isDying === "boolean") sheet.combat.isDying = vitality.isDying;
  // Кость хитов в реальных экспортах LSS — «1к8» (кириллица), в английских
  // шаблонах — «1d8»: принимаем обе.
  const hitDieMatch = /[dк](\d+)/i.exec(val(vitality["hit-die"]) || "");
  if (hitDieMatch) {
    const faces = hitDieMatch[1];
    const level = sheet.info.level || 1;
    sheet.combat.hitDiceTotal = `${level}к${faces}`;
    const current = val(vitality["hp-dice-current"]);
    sheet.combat.hitDiceCurrent = `${typeof current === "number" ? current : level}к${faces}`;
  }

  // ---- оружие / настройка (заменяют список целиком, если в файле есть данные) ----
  if (Array.isArray(data.weaponsList) && data.weaponsList.length) {
    sheet.weapons = data.weaponsList.map((w) => ({
      name: strVal(w.name),
      bonus: strVal(w.mod),
      damage: strVal(w.dmg),
      notes: "",
    }));
  }
  if (Array.isArray(data.attunementsList) && data.attunementsList.length) {
    sheet.attunementItems = data.attunementsList.map((it) => ({
      name: (it && it.value) || "",
      attuned: !!(it && it.checked),
    }));
  }

  // ---- ресурсы (в примерах пуст, best-effort на будущее) ----
  const resources = data.resources || {};
  const resourceKeys = Object.keys(resources);
  if (resourceKeys.length) {
    sheet.resources = resourceKeys.map((key) => {
      const r = resources[key] || {};
      return { name: r.name || key, current: r.value ?? r.current ?? 0, max: r.max || 0, recovery: "" };
    });
  }

  // ---- монеты ----
  const coins = data.coins || {};
  for (const key of ["cp", "sp", "gp", "ep", "pp"]) {
    if (typeof val(coins[key]) === "number") sheet.coins[key] = val(coins[key]);
  }

  // ---- длинные текстовые поля (дописываются, не затирают существующее) ----
  sheet.equipment = appendOrSet(sheet.equipment, docToText(docOf(text.equipment)));
  sheet.traits = appendOrSet(sheet.traits, docToText(docOf(text.traits)));
  sheet.proficiencyNotes = appendOrSet(sheet.proficiencyNotes, docToText(docOf(text.prof)));
  sheet.personalityTraits = appendOrSet(sheet.personalityTraits, docToText(docOf(text.personality)));
  sheet.ideals = appendOrSet(sheet.ideals, docToText(docOf(text.ideals)));
  sheet.bonds = appendOrSet(sheet.bonds, docToText(docOf(text.bonds)));
  sheet.flaws = appendOrSet(sheet.flaws, docToText(docOf(text.flaws)));
  sheet.features = appendOrSet(sheet.features, docToText(docOf(text.features)));
  sheet.background = appendOrSet(sheet.background, docToText(docOf(text.background)));
  sheet.goals = appendOrSet(sheet.goals, docToText(docOf(text.quests)));
  sheet.attacksSpells = appendOrSet(sheet.attacksSpells, docToText(docOf(text.attacks)));

  // ---- заговоры/заклинания по уровням ----
  // "spells.mode":"text" в файле экспорта — на ВНЕШНЕМ объекте (рядом с
  // "data", не внутри неё, см. parseLssExport: мы сохраняем только data и
  // edition), а data.spells — это просто ячейки "slots-N" (см. выше). Раз
  // разбирать этот флаг было бы лишним усложнением ради поля, которое мы
  // всё равно не сохраняем — просто обрабатываем любой присутствующий блок
  // text["spells-level-N"], не глядя на режим.
  for (const lvl of SPELL_LEVELS) {
    const field = text["spells-level-" + lvl];
    if (!field) continue;
    const names = docParagraphs(docOf(field));
    for (const name of names) {
      const dup = sheet.preparedSpells.some((row) => row.level === lvl && row.name.trim().toLowerCase() === name.toLowerCase());
      if (dup) continue;
      sheet.preparedSpells.push({ level: lvl, name, castTime: "", range: "", concentration: false, ritual: false, material: false, notes: "" });
    }
  }

  return { name: strVal(data.name), warnings };
}
