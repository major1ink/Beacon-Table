// monster-import.js — перевод одного JSON-файла экспорта существа с
// https://5e14.ttg.club (кнопка карточки существа "Экспорт для FVTT") в наш
// domain.Monster (см. internal/domain/monster.go). Формат экспорта — предмет
// типа "npc" в схеме Foundry VTT dnd5e (та же схема, что и у экспорта
// заклинаний, см. spell-import.js, только "актёр" с системными полями
// характеристик/защиты вместо предмета-заклинания и вложенным массивом
// items — оружие/черты/снаряжение персонажа).
//
// Чистая функция без побочных эффектов: сервер ничего не знает про формат
// Foundry, весь разбор — здесь, на клиенте (см. domain/monster.go: комментарий
// про "умный бланк"). Значения, которых нет в словаре ниже, не теряются —
// подставляется исходный код Foundry как есть.
//
// Важная особенность формата: КД чаще всего НЕ хранится готовым числом —
// system.attributes.ac.calc бывает "natural"/"flat" (число лежит в .flat
// напрямую, как у большинства монстров с природным доспехом) или "default"
// (число нужно посчитать по надетой броне из items[], как у гуманоидов в
// доспехах/со щитом) — см. computeAC ниже, это стандартная формула D&D 5e
// (лёгкая: значение брони + Лов, средняя: + Лов не выше 2, тяжёлая: без Лов),
// не более того — не game engine, просто чтобы КД не осталось пустым 10.
//
// Способности (Traits/Actions/Бонусные/Реакции/Легендарные/Логово) в Foundry
// не размечены отдельным полем "раздел статблока" — при экспорте с TTG Club
// они приходят россыпью в items[] (type "weapon"/"feat"), и в какой раздел
// попадает предмет, определяется его system.activation.type (см. bucketFor).
// Это эвристика, не гарантия: пассивная особенность, формально дающая право
// на бонусное действие (как "Ловкий побег" гоблина), из Foundry приходит с
// activation.type "bonus" и попадёт в "Бонусные действия" вместо "Особенностей"
// — визуально это те же textarea в редакторе карточки монстра (bestiary.js),
// одна правка вручную (вырезать/вставить абзац) при необходимости.
import { CONDITION_RU } from "./foundry-conditions.js";
import { cleanFoundryText } from "./foundry-text.js";

function ru(dict, code) {
  if (!code) return "";
  return Object.prototype.hasOwnProperty.call(dict, code) ? dict[code] : code;
}

function abilityMod(score) {
  return Math.floor(((score || 10) - 10) / 2);
}
function fmtMod(n) {
  return n >= 0 ? "+" + n : String(n);
}

// crToProf — таблица "опасность → бонус мастерства" из PHB/MM (правило D&D
// 5e), Foundry не кладёт готовый бонус мастерства в экспорт NPC — он у него
// вычисляется на лету из CR тем же способом.
function crToProf(cr) {
  if (cr >= 29) return 9;
  if (cr >= 25) return 8;
  if (cr >= 21) return 7;
  if (cr >= 17) return 6;
  if (cr >= 13) return 5;
  if (cr >= 9) return 4;
  if (cr >= 5) return 3;
  return 2;
}

const CR_FRACTIONS = { 0: "0", 0.125: "1/8", 0.25: "1/4", 0.5: "1/2" };
function crLabel(cr) {
  return Object.prototype.hasOwnProperty.call(CR_FRACTIONS, cr) ? CR_FRACTIONS[cr] : String(cr);
}

const SIZE_RU = { tiny: "Крошечный", sm: "Маленький", med: "Средний", lg: "Большой", huge: "Огромный", grg: "Гигантский" };
const CREATURE_TYPE_RU = {
  aberration: "аберрация", beast: "зверь", celestial: "небожитель", construct: "конструкт",
  dragon: "дракон", elemental: "элементаль", fey: "фея", fiend: "исчадие", giant: "великан",
  humanoid: "гуманоид", monstrosity: "чудовище", ooze: "слизь", plant: "растение", undead: "нежить", swarm: "рой",
};
const ABILITY_RU = { str: "Сил", dex: "Лов", con: "Тел", int: "Инт", wis: "Мдр", cha: "Хар" };
const SKILL_RU = {
  acr: "Акробатика", ani: "Уход за животными", arc: "Магия", ath: "Атлетика", dec: "Обман",
  his: "История", ins: "Проницательность", itm: "Запугивание", inv: "Анализ", med: "Медицина",
  nat: "Природа", prc: "Восприятие", prf: "Выступление", per: "Убеждение", rel: "Религия",
  slt: "Ловкость рук", ste: "Скрытность", sur: "Выживание",
};
const DAMAGE_TYPE_RU = {
  acid: "кислота", bludgeoning: "дробящий", cold: "холод", fire: "огонь", force: "силовое поле",
  lightning: "электричество", necrotic: "некротический", piercing: "колющий", poison: "яд",
  psychic: "психическая энергия", radiant: "излучение", slashing: "рубящий", thunder: "звук",
};
// CONDITION_RU переехал в общий foundry-conditions.js: та же таблица нужна
// теперь и палитре состояний, и импорту эффектов заклинания, и импорту
// самих карточек состояний — держать четыре копии смысла нет (в отличие от
// DAMAGE_TYPE_RU выше, который остаётся локальной копией в каждом
// импортёре: там таблица — часть перевода конкретного формата, а не общий
// словарь состояний).
const LANGUAGE_RU = {
  common: "Общий", dwarvish: "Дварфский", elvish: "Эльфийский", giant: "Великаний", gnomish: "Гномий",
  goblin: "Гоблинский", halfling: "Полуросличий", orc: "Орочий", abyssal: "Бездны", celestial: "Небесный",
  draconic: "Драконий", deep: "Глубинная речь", infernal: "Инфернальный", primordial: "Первичный",
  sylvan: "Сильван", undercommon: "Подземный", druidic: "Друидический", cant: "Воровской жаргон", telepathy: "Телепатия",
};
const ENV_RU = {
  Forest: "лес", Grassland: "равнина/луг", Hill: "холмы", Underdark: "подземье", Mountain: "горы",
  Swamp: "болото", Desert: "пустыня", Coastal: "побережье", Arctic: "арктика", Urban: "город",
};

function buildSpeed(movement) {
  if (!movement) return "";
  const unit = movement.units === "mi" ? "миль" : "фт.";
  const parts = [`${movement.walk || 0} ${unit}`];
  if (movement.fly) parts.push(`полёт ${movement.fly} ${unit}${movement.hover ? " (парит)" : ""}`);
  if (movement.swim) parts.push(`плавание ${movement.swim} ${unit}`);
  if (movement.climb) parts.push(`лазание ${movement.climb} ${unit}`);
  if (movement.burrow) parts.push(`копание ${movement.burrow} ${unit}`);
  return parts.join(", ");
}

function buildSenses(sys, prof) {
  const s = (sys.attributes && sys.attributes.senses) || {};
  const unit = s.units === "mi" ? "миль" : "фт.";
  const parts = [];
  if (s.darkvision) parts.push(`тёмное зрение ${s.darkvision} ${unit}`);
  if (s.blindsight) parts.push(`слепое зрение ${s.blindsight} ${unit}`);
  if (s.tremorsense) parts.push(`чувство вибрации ${s.tremorsense} ${unit}`);
  if (s.truesight) parts.push(`истинное зрение ${s.truesight} ${unit}`);
  if (s.special) parts.push(s.special);
  const wisMod = abilityMod(sys.abilities && sys.abilities.wis && sys.abilities.wis.value);
  const prc = sys.skills && sys.skills.prc;
  parts.push(`пассивная Внимательность ${10 + wisMod + Math.floor(prof * (prc ? prc.value : 0))}`);
  return parts.join(", ");
}

function buildLanguages(traits) {
  const l = (traits && traits.languages) || {};
  const names = (l.value || []).map((code) => ru(LANGUAGE_RU, code));
  if (l.custom) names.push(l.custom);
  return names.join(", ");
}

function buildTraitList(entry, dict) {
  const names = ((entry && entry.value) || []).map((code) => ru(dict, code));
  if (entry && entry.custom) names.push(entry.custom);
  return names.join(", ");
}

function buildSaves(sys, prof) {
  const entries = [];
  for (const key of ["str", "dex", "con", "int", "wis", "cha"]) {
    const a = sys.abilities && sys.abilities[key];
    if (!a || !a.proficient) continue;
    entries.push(`${ABILITY_RU[key]} ${fmtMod(abilityMod(a.value) + Math.floor(prof * a.proficient))}`);
  }
  return entries.join(", ");
}

function buildSkills(sys, prof) {
  const entries = [];
  for (const [code, sk] of Object.entries(sys.skills || {})) {
    if (!sk || !sk.value) continue;
    const mod = abilityMod(sys.abilities && sys.abilities[sk.ability] && sys.abilities[sk.ability].value) + Math.floor(prof * sk.value);
    entries.push(`${SKILL_RU[code] || code} ${fmtMod(mod)}`);
  }
  return entries.join(", ");
}

// computeAC — см. комментарий в шапке файла: берём готовое число, если оно
// есть (calc "natural"/"flat" — большинство монстров), иначе считаем по
// надетой броне/щиту в items[] по стандартной формуле D&D 5e.
function computeAC(sys, items) {
  const acAttr = (sys.attributes && sys.attributes.ac) || {};
  if (typeof acAttr.flat === "number") return acAttr.flat;
  const dexMod = abilityMod(sys.abilities && sys.abilities.dex && sys.abilities.dex.value);
  const armorItems = (items || []).filter((i) => i.type === "equipment" && i.system && i.system.armor && i.system.equipped);
  const body = armorItems.find((i) => i.system.armor.type && i.system.armor.type !== "shield");
  const shield = armorItems.find((i) => i.system.armor.type === "shield");
  let ac;
  if (body) {
    const av = body.system.armor.value || 10;
    if (body.system.armor.type === "heavy") ac = av;
    else if (body.system.armor.type === "medium") ac = av + Math.min(dexMod, 2);
    else ac = av + dexMod; // лёгкая или неизвестный тип — не ограничиваем Лов
  } else {
    ac = 10 + dexMod;
  }
  if (shield) ac += shield.system.armor.value || 0;
  return ac;
}

function acNote(items) {
  return (items || [])
    .filter((i) => i.type === "equipment" && i.system && i.system.armor && i.system.equipped)
    .map((i) => i.name.toLowerCase())
    .join(", ");
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function itemParagraph(item) {
  const desc = cleanFoundryText(item.system && item.system.description && item.system.description.value);
  return `<p><strong>${escapeHtml(item.name)}.</strong> ${desc}</p>`;
}

// ABILITY_ITEM_TYPES — какие типы предметов Foundry вообще несут игровой
// текст способности (оружие/черты); снаряжение (доспехи/боеприпасы/зелья и
// т.п.) сюда не идёт — оно только источник КД (см. computeAC) и не
// печатается отдельным абзацем.
const ABILITY_ITEM_TYPES = new Set(["weapon", "feat"]);

// bucketFor — раздел статблока для предмета. Два предмета TTG Club всегда
// называет одинаково служебными именами (не зависящими от конкретного
// монстра) — это не эвристика по activation.type, а прямое опознавание:
// "Легендарные действия" — вступительный абзац перед списком легендарных
// действий (id уходит в LegendaryActionsIntro, не в текст действия), "Эффекты
// местности" — вводный абзац логова, печатается перед перечнем "Логово: ...".
function bucketFor(item) {
  if (item.name === "Легендарные действия") return "legendaryIntro";
  if (item.name === "Эффекты местности") return "lairIntro";
  const t = (item.system && item.system.activation && item.system.activation.type) || "";
  if (t === "action") return "actions";
  if (t === "bonus") return "bonusActions";
  if (t === "reaction") return "reactions";
  if (t === "legendary") return "legendaryActions";
  if (t === "lair") return "lairActions";
  return "traits"; // "" (пассивные особенности) и "special" (напр. "Легендарная устойчивость") — сюда же
}

function buildAbilityBlocks(items, resources) {
  const buckets = { traits: [], actions: [], bonusActions: [], reactions: [], legendaryActions: [], lairActions: [] };
  let legendaryIntro = "";
  let lairIntro = "";
  for (const item of items || []) {
    if (!ABILITY_ITEM_TYPES.has(item.type)) continue;
    const bucket = bucketFor(item);
    if (bucket === "legendaryIntro") {
      legendaryIntro = cleanFoundryText(item.system && item.system.description && item.system.description.value);
      continue;
    }
    if (bucket === "lairIntro") {
      lairIntro = cleanFoundryText(item.system && item.system.description && item.system.description.value);
      continue;
    }
    buckets[bucket].push(itemParagraph(item));
  }
  // Легендарные действия почти всегда идут с готовым вступительным абзацем
  // из items[] (см. bucketFor) — но если TTG Club его не прислал (например,
  // структура источника отличается), а счётчик легендарных действий всё
  // равно есть, подставляем стандартную формулировку PHB, чтобы поле не
  // осталось пустым при явно легендарном монстре.
  if (!legendaryIntro && resources && resources.legact && resources.legact.max > 0) {
    legendaryIntro = `Существо может совершить ${resources.legact.max} легендарных действия, выбирая из вариантов ниже. Одновременно может быть использовано только одно легендарное действие, и только в конце хода другого существа. Существо восстанавливает потраченные легендарные действия в начале своего хода.`;
  }
  const lairActionsText = [lairIntro ? `<p>${lairIntro}</p>` : "", ...buckets.lairActions].join("");
  return {
    traits: buckets.traits.join(""),
    actions: buckets.actions.join(""),
    bonusActions: buckets.bonusActions.join(""),
    reactions: buckets.reactions.join(""),
    legendaryActionsIntro: legendaryIntro,
    legendaryActions: buckets.legendaryActions.join(""),
    lairActions: lairActionsText,
  };
}

function buildTags(details) {
  const tags = [];
  if (details && details.source) tags.push(details.source);
  const env = ((details && details.environment) || "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const e of env) tags.push(ENV_RU[e] || e);
  return tags;
}

// mapFoundryMonsterJson — основной вход модуля. raw — уже распарсенный
// JSON.parse() объект файла экспорта. Бросает Error с понятным сообщением,
// если это не похоже на существо Foundry (type "npc"/"character").
export function mapFoundryMonsterJson(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Файл не похож на JSON существа.");
  // "vehicle" (транспорт) пускаем тем же маппером, что и npc/character (см.
  // internal/foundry/classify.go: actorTarget) — статблок корабля/повозки
  // ложится в те же текстовые поля Monster. Полей, специфичных для
  // транспорта (sys.abilities, CR), у него обычно нет — ниже они просто
  // остаются на дефолтах (характеристики 10, CR "0"), это ожидаемо: ДМ
  // сверяет цифры вручную, как и с остальными полями статблока.
  if (raw.type && raw.type !== "npc" && raw.type !== "character" && raw.type !== "vehicle") {
    throw new Error(`Это не существо (type: "${raw.type}") — экспортируй карточку существа с TTG Club.`);
  }
  const name = (raw.name || "").trim();
  if (!name) throw new Error("В файле нет имени существа.");
  const sys = raw.system || {};
  const items = raw.items || [];
  const abilities = sys.abilities || {};
  const details = sys.details || {};
  const cr = typeof details.cr === "number" ? details.cr : 0;
  const prof = crToProf(cr);

  const typeValue = details.type && details.type.value ? ru(CREATURE_TYPE_RU, details.type.value) : "";
  const subtype = (details.type && details.type.subtype) || "";
  const type = subtype ? `${typeValue} (${subtype})` : typeValue;

  return Object.assign(
    {
      name,
      size: ru(SIZE_RU, sys.traits && sys.traits.size),
      type,
      alignment: details.alignment || "",
      ac: computeAC(sys, items),
      acNote: acNote(items),
      hp: (sys.attributes && sys.attributes.hp && sys.attributes.hp.max) || 0,
      hitDice: (sys.attributes && sys.attributes.hp && sys.attributes.hp.formula) || "",
      speed: buildSpeed(sys.attributes && sys.attributes.movement),
      abilities: {
        str: (abilities.str && abilities.str.value) || 10,
        dex: (abilities.dex && abilities.dex.value) || 10,
        con: (abilities.con && abilities.con.value) || 10,
        int: (abilities.int && abilities.int.value) || 10,
        wis: (abilities.wis && abilities.wis.value) || 10,
        cha: (abilities.cha && abilities.cha.value) || 10,
      },
      savingThrows: buildSaves(sys, prof),
      skills: buildSkills(sys, prof),
      damageVulnerabilities: buildTraitList(sys.traits && sys.traits.dv, DAMAGE_TYPE_RU),
      damageResistances: buildTraitList(sys.traits && sys.traits.dr, DAMAGE_TYPE_RU),
      damageImmunities: buildTraitList(sys.traits && sys.traits.di, DAMAGE_TYPE_RU),
      conditionImmunities: buildTraitList(sys.traits && sys.traits.ci, CONDITION_RU),
      senses: buildSenses(sys, prof),
      languages: buildLanguages(sys.traits),
      cr: crLabel(cr),
      proficiencyBonus: prof,
      description: cleanFoundryText(details.biography && details.biography.value),
      tags: buildTags(details),
    },
    buildAbilityBlocks(items, sys.resources)
  );
}
