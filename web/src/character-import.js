// character-import.js — перевод актёра Foundry VTT типа "character"
// (предгенерированный персонаж приключения) в наш domain.CharacterSheet
// (см. internal/domain/character_sheet.go). Используется экраном импорта
// пакета (web/src/pages/foundry-import.js): модули-приключения кладут «готовых
// персонажей» внутрь пака Adventure, и классификатор отправляет их в
// foundry.TargetPregens — пул готовых персонажей мира.
//
// Чистая функция без побочных эффектов, тем же приёмом, что monster-import.js
// / item-import.js: сервер про формат Foundry ничего не знает (философия
// «умный бланк», см. domain/character_sheet.go) — весь разбор здесь. Тексты
// (биография/черты) на этом пути сервер уже переписал (см.
// internal/foundry/links.go: RewriteDocMacros) — повторно чистить не нужно.
//
// Схема dnd5e у актёра-персонажа: system.abilities/skills/attributes как у
// npc (см. monster-import.js), плюс system.details.{xp,alignment,biography},
// system.spells.spell1..9 (ячейки), system.currency, и вложенный items[] —
// класс/подкласс/вид/предыстория (type "class"/"subclass"/"race"/"species"/
// "background"/"origin"), черты (type "feat"), оружие (type "weapon") и
// снаряжение. Всё, что не ложится в структурированные поля листа, уходит
// текстом в соответствующую графу — как в бумажном бланке.

const SKILL_KEY_BY_FOUNDRY = {
  acr: "acrobatics",
  ani: "animalHandling",
  arc: "arcana",
  ath: "athletics",
  dec: "deception",
  his: "history",
  ins: "insight",
  itm: "intimidation",
  inv: "investigation",
  med: "medicine",
  nat: "nature",
  prc: "perception",
  prf: "performance",
  per: "persuasion",
  rel: "religion",
  slt: "sleightOfHand",
  ste: "stealth",
  sur: "survival",
};

const ABILITY_KEYS = ["str", "dex", "con", "int", "wis", "cha"];

const DAMAGE_TYPE_RU = {
  acid: "кислота",
  bludgeoning: "дробящий",
  cold: "холод",
  fire: "огонь",
  force: "силовое поле",
  lightning: "электричество",
  necrotic: "некротический",
  piercing: "колющий",
  poison: "яд",
  psychic: "психическая энергия",
  radiant: "излучение",
  slashing: "рубящий",
  thunder: "звук",
};

const LANGUAGE_RU = {
  common: "Общий",
  dwarvish: "Дварфский",
  elvish: "Эльфийский",
  giant: "Великаний",
  gnomish: "Гномий",
  goblin: "Гоблинский",
  halfling: "Полуросличий",
  orc: "Орочий",
  abyssal: "Бездны",
  celestial: "Небесный",
  draconic: "Драконий",
  deep: "Глубинная речь",
  infernal: "Инфернальный",
  primordial: "Первичный",
  sylvan: "Сильван",
  undercommon: "Подземный",
  druidic: "Друидический",
  thievescant: "Воровской жаргон",
};

function abilityMod(score) {
  return Math.floor(((score || 10) - 10) / 2);
}
function fmtMod(n) {
  return n >= 0 ? "+" + n : String(n);
}
function toInt(v, fallback = 0) {
  const n = parseInt(String(v ?? "").trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

// profBonus — бонус мастерства по суммарному уровню (правило PHB). Foundry
// кладёт его в system.attributes.prof, но не всегда — падаем на расчёт.
function profBonus(sys, totalLevel) {
  const p = sys.attributes && sys.attributes.prof;
  if (typeof p === "number" && p > 0) return p;
  return Math.floor((Math.max(1, totalLevel) - 1) / 4) + 2;
}

function stripTags(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

// itemsOfType — предметы вложенного items[] заданного типа (или типов).
function itemsOfType(items, ...types) {
  const set = new Set(types);
  return (items || []).filter((i) => i && set.has(i.type));
}

// buildClassInfo — класс/подкласс/суммарный уровень из items[type=class].
// Мультикласс: имена через "/", уровень — сумма.
function buildClassInfo(items) {
  const classes = itemsOfType(items, "class");
  const subclasses = itemsOfType(items, "subclass");
  let level = 0;
  const names = [];
  for (const c of classes) {
    const lv = toInt(c.system && (c.system.levels || c.system.level), 0);
    level += lv;
    names.push(lv ? `${c.name} ${lv}` : c.name);
  }
  return {
    class: names.join(" / "),
    subclass: subclasses.map((s) => s.name).join(" / "),
    level,
  };
}

// weaponRow — строка таблицы «Оружие» листа: имя, бонус попадания (+N — по
// нему лист рисует кнопку 🎲), формула урона с типом. Оценка «как Foundry»
// (модификатор характеристики + бонус мастерства), не game engine — игрок
// сверяет глазами, как и с бумажным листом.
function weaponRow(item, sys, scores, prof) {
  const w = item.system || {};
  const props = Array.isArray(w.properties)
    ? w.properties
    : w.properties && typeof w.properties === "object"
      ? Object.keys(w.properties).filter((k) => w.properties[k])
      : [];
  const activity = (w.activities && typeof w.activities === "object" ? Object.values(w.activities) : []).find(
    (a) => a && a.type === "attack",
  );
  const at = (activity && activity.attack) || {};
  const ranged = (at.type && at.type.value === "ranged") || /rwak|rsak/.test(w.actionType || "");
  let abilityKey = at.ability || w.ability || "";
  if (!abilityKey || abilityKey === "none" || scores[abilityKey] == null) {
    if (props.includes("fin")) abilityKey = abilityMod(scores.dex) >= abilityMod(scores.str) ? "dex" : "str";
    else abilityKey = ranged ? "dex" : "str";
  }
  const mod = abilityMod(scores[abilityKey]);
  const magic = toInt(w.magicalBonus);
  const proficient = w.proficient == null ? 1 : toInt(w.proficient, 1);
  const hit = mod + magic + toInt(at.bonus) + (proficient ? prof : 0);

  // Урон: базовый кубик оружия (v4 — system.damage.base) или первая часть
  // system.damage.parts (v2/v3 — формула строкой с "@mod").
  let damage = "";
  const base = w.damage && w.damage.base;
  if (base && base.denomination) {
    const num = base.number || 1;
    const flat = mod + magic + toInt(base.bonus);
    damage = `${num}к${base.denomination}${flat ? ` ${fmtMod(flat)}` : ""}`;
    const types = (Array.isArray(base.types) ? base.types : base.type ? [base.type] : [])
      .map((t) => DAMAGE_TYPE_RU[t] || t)
      .filter(Boolean)
      .join("/");
    if (types) damage += ` ${types}`;
  } else {
    const parts = w.damage && Array.isArray(w.damage.parts) ? w.damage.parts : [];
    if (parts.length) {
      const [formula, type] = Array.isArray(parts[0]) ? parts[0] : [parts[0], ""];
      damage = String(formula || "")
        .replace(/@mod|@abilities\.\w+\.mod/g, fmtMod(mod).replace("+", ""))
        .replace(/\s*\+\s*$/, "")
        .replace(/d(\d)/gi, "к$1")
        .trim();
      const t = DAMAGE_TYPE_RU[type] || type;
      if (t) damage += ` ${t}`;
    }
  }
  return { name: item.name || "", bonus: hit ? fmtMod(hit) : "", damage: damage.trim(), notes: "" };
}

// buildSpellRows — подготовленные/известные заклинания из items[type=spell].
function buildSpellRows(items) {
  return itemsOfType(items, "spell").map((sp) => {
    const s = sp.system || {};
    const props =
      s.properties && typeof s.properties === "object"
        ? Object.keys(s.properties).filter((k) => s.properties[k])
        : Array.isArray(s.properties)
          ? s.properties
          : [];
    return {
      level: toInt(s.level, 0),
      name: sp.name || "",
      castTime: "",
      range: "",
      concentration: props.includes("concentration") || !!(s.duration && s.duration.concentration),
      ritual: props.includes("ritual"),
      material: props.includes("material") || !!(s.materials && s.materials.value),
      notes: "",
    };
  });
}

function buildLanguages(traits) {
  const l = (traits && traits.languages) || {};
  const names = (l.value || []).map((code) => LANGUAGE_RU[code] || code);
  if (l.custom) names.push(String(l.custom).replace(/;/g, ", "));
  return names.join(", ");
}

function joinFeatures(items) {
  return itemsOfType(items, "feat")
    .map((f) => {
      const desc = stripTags(f.system && f.system.description && f.system.description.value);
      return desc ? `${f.name}. ${desc}` : f.name;
    })
    .filter(Boolean)
    .join("\n\n");
}

function joinEquipment(items) {
  return itemsOfType(items, "equipment", "consumable", "tool", "loot", "container", "weapon")
    .map((it) => {
      const qty = toInt(it.system && it.system.quantity, 1);
      return qty > 1 ? `${it.name} ×${qty}` : it.name;
    })
    .filter(Boolean)
    .join(", ");
}

// mapFoundryCharacterJson — основной вход модуля. raw — уже распарсенный
// объект актёра Foundry. Бросает Error, если это не персонаж.
export function mapFoundryCharacterJson(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Файл не похож на JSON персонажа Foundry.");
  if (raw.type && raw.type !== "character") {
    throw new Error(`Это не персонаж (type: "${raw.type}").`);
  }
  const name = (raw.name || "").trim();
  if (!name) throw new Error("В данных нет имени персонажа.");

  const sys = raw.system || {};
  const items = raw.items || [];
  const abilities = sys.abilities || {};
  const details = sys.details || {};
  const attrs = sys.attributes || {};
  const traits = sys.traits || {};

  const scores = {};
  const saveProf = {};
  for (const k of ABILITY_KEYS) {
    const a = abilities[k] || {};
    scores[k] = toInt(a.value, 10);
    saveProf[k] = !!a.proficient;
  }

  const { class: className, subclass, level: classLevel } = buildClassInfo(items);
  const level = classLevel || toInt(details.level, 1) || 1;
  const prof = profBonus(sys, level);

  const skillProf = {};
  for (const [code, sk] of Object.entries(sys.skills || {})) {
    const key = SKILL_KEY_BY_FOUNDRY[code];
    if (!key || !sk) continue;
    const v = toInt(sk.value, 0);
    if (v > 0) skillProf[key] = v >= 2 ? 2 : 1;
  }

  const race = itemsOfType(items, "race", "species", "origin")[0];
  const background = itemsOfType(items, "background")[0];

  const movement = attrs.movement || {};
  const senses = attrs.senses || {};
  const hp = attrs.hp || {};
  const ac = attrs.ac || {};

  const slots = [];
  for (let lvl = 1; lvl <= 9; lvl++) {
    const slot = sys.spells && sys.spells["spell" + lvl];
    const max = slot ? toInt(slot.max ?? slot.override, 0) : 0;
    slots.push(max > 0 ? String(max) : "");
  }
  const weapons = itemsOfType(items, "weapon").map((w) => weaponRow(w, sys, scores, prof));

  const armorProf = traits.armorProf || {};
  const weaponProf = traits.weaponProf || {};
  const armorCodes = (armorProf.value || []).map(String);
  const weaponCodes = (weaponProf.value || []).map(String);

  const sheet = {
    info: {
      class: className,
      subclass,
      species: race ? race.name : "",
      background: background ? background.name : "",
      level,
      xp: toInt(details.xp && (details.xp.value ?? details.xp), 0),
      playerName: "",
    },
    abilities: scores,
    saveProf,
    skillProf,
    armor: {
      lightArmor: armorCodes.includes("lgt") || armorCodes.includes("light"),
      mediumArmor: armorCodes.includes("med") || armorCodes.includes("medium"),
      heavyArmor: armorCodes.includes("hvy") || armorCodes.includes("heavy"),
      shield: armorCodes.includes("shl") || armorCodes.includes("shield"),
      simpleWeapons: weaponCodes.includes("sim") || weaponCodes.includes("simple"),
      martialWeapons: weaponCodes.includes("mar") || weaponCodes.includes("martial"),
      otherWeapons: (weaponProf.custom || "").replace(/;/g, ", "),
    },
    toolsLanguages: buildLanguages(traits),
    combat: {
      ac: toInt(ac.value, 0) || toInt(ac.flat, 0),
      hpCurrent: toInt(hp.value, 0) || toInt(hp.max, 0),
      hpTemp: toInt(hp.temp, 0),
      hpMax: toInt(hp.max, 0),
      hitDiceTotal: level ? `${level}к?` : "",
      speed: toInt(movement.walk, 0),
      darkvision: toInt(senses.darkvision, 0),
    },
    weapons,
    features: joinFeatures(items),
    feats: "",
    spellcasting: {
      ability: (attrs.spellcasting || sys.spellcasting || "").toString(),
      slotsByLevel: slots,
    },
    preparedSpells: buildSpellRows(items),
    appearance: stripTags(details.appearance),
    background: stripTags(details.biography && details.biography.value),
    alignment: details.alignment || "",
    equipment: joinEquipment(items),
    coins: {
      cp: toInt(sys.currency && sys.currency.cp, 0),
      sp: toInt(sys.currency && sys.currency.sp, 0),
      gp: toInt(sys.currency && sys.currency.gp, 0),
      ep: toInt(sys.currency && sys.currency.ep, 0),
      pp: toInt(sys.currency && sys.currency.pp, 0),
    },
    personalityTraits: stripTags(details.trait),
    ideals: stripTags(details.ideal),
    bonds: stripTags(details.bond),
    flaws: stripTags(details.flaw),
  };

  // hitDiceTotal: если у класса известна кость хитов — соберём "3к8".
  const firstClass = itemsOfType(items, "class")[0];
  const hd = firstClass && firstClass.system && (firstClass.system.hd || firstClass.system.hitDice);
  const faces = typeof hd === "object" ? hd.denomination : hd;
  if (faces) sheet.combat.hitDiceTotal = `${level}к${String(faces).replace(/^d/i, "")}`;

  return {
    name,
    avatarUrl: raw.img || (raw.prototypeToken && raw.prototypeToken.texture && raw.prototypeToken.texture.src) || "",
    sheet,
  };
}
