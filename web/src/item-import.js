// item-import.js — перевод одного JSON-файла экспорта предмета из Foundry
// VTT (dnd5e) в наш domain.Item (см. internal/domain/item.go). В отличие от
// заклинаний/существ, страницы предметов на 5e14.ttg.club НЕ имеют кнопки
// "Экспортировать в FvTT" (проверено на карточке "Амулет тёмного осколка" —
// там только копирование ссылки/закладка/печать/полноэкранный режим), так
// что источник файла здесь — сам Foundry (экспорт предмета из мира/
// компендиума) или сторонний модуль, а не ttg.club.
//
// Единственный реально проверенный пример на момент написания — предмет типа
// "equipment" (чудесный предмет, "Амулет тёмного осколка", прислан
// пользователем при постановке задачи): description/source/price/weight/
// rarity/attunement/activation размечены и протестированы по нему. Ветки для
// "weapon"/"consumable"/"tool"/"loot" — по документированной схеме dnd5e (те
// же имена полей, что и в остальном экспорте Foundry, см. spell-import.js/
// monster-import.js), но БЕЗ реального образца файла — если что-то не
// распознается, как обычно в этом модуле, теряться оно не должно: неизвестные
// коды берутся как есть (см. ru()).
//
// Чистая функция без побочных эффектов: сервер ничего не знает про формат
// Foundry, весь разбор — здесь, на клиенте (см. domain/item.go: комментарий
// про "умный бланк").

function ru(dict, code) {
  if (!code) return "";
  return Object.prototype.hasOwnProperty.call(dict, code) ? dict[code] : code;
}

const RARITY_RU = {
  common: "обычный",
  uncommon: "необычный",
  rare: "редкий",
  veryRare: "очень редкий",
  legendary: "легендарный",
  artifact: "артефакт",
  varies: "разное",
};

const DENOMINATION_RU = { pp: "пм.", gp: "зм.", ep: "эм.", sp: "см.", cp: "мм." };
const WEIGHT_UNIT_RU = { lb: "фунт.", kg: "кг" };

const ACTIVATION_TYPE_RU = {
  action: "действие",
  bonus: "бонусное действие",
  reaction: "реакция",
  minute: "мин.",
  hour: "ч.",
  day: "дн.",
  special: "особое (см. описание)",
  legendary: "легендарное действие",
  none: "",
};

// EQUIPMENT_TYPE_RU — подтип для type:"equipment" (system.type.value): броня
// по весовой категории + прочие слоты чудесных предметов (кольцо/жезл/посох/
// палочка/безделушка) — то, что реально проверено на образце (baseItem
// "trinket").
const EQUIPMENT_TYPE_RU = {
  light: "лёгкий доспех",
  medium: "средний доспех",
  heavy: "тяжёлый доспех",
  natural: "естественная броня",
  shield: "щит",
  clothing: "одежда",
  trinket: "чудесный предмет",
  vehicle: "снаряжение экипажа",
  ring: "кольцо",
  rod: "жезл",
  staff: "посох",
  wand: "волшебная палочка",
};

// WEAPON_CATEGORY_RU/CONSUMABLE_TYPE_RU/TOOL_TYPE_RU/LOOT_TYPE_RU — не
// проверены на реальном файле (см. комментарий в шапке), но коды стандартны
// для схемы dnd5e Foundry.
const WEAPON_CATEGORY_RU = {
  simpleM: "простое рукопашное",
  simpleR: "простое дальнобойное",
  martialM: "воинское рукопашное",
  martialR: "воинское дальнобойное",
  natural: "естественное",
  improv: "импровизированное",
  siege: "осадное",
};
const CONSUMABLE_TYPE_RU = {
  ammo: "боеприпасы",
  potion: "зелье",
  poison: "яд",
  food: "еда/питьё",
  scroll: "свиток",
  wand: "волшебная палочка (расходная)",
  rod: "жезл (расходный)",
  trinket: "безделушка",
};
const TOOL_TYPE_RU = {
  art: "художественные инструменты",
  game: "игровой набор",
  music: "музыкальный инструмент",
  disg: "маскировочный набор",
  forg: "набор фальсификатора",
  herb: "травнический набор",
  navg: "навигаторские инструменты",
  pois: "набор отравителя",
  thief: "воровские инструменты",
  vehicle: "транспортное средство",
};
const LOOT_TYPE_RU = {
  art: "предмет искусства",
  gem: "самоцвет",
  material: "материал",
  resource: "ресурс",
  treasure: "сокровище",
  trinket: "безделушка",
};

// WEAPON_PROPERTIES_RU — короткие коды v2-схемы dnd5e (fin/lgt/thr/...) и
// полные слова более новых версий (finesse/light/thrown/...) вперемешку —
// принимаем оба варианта, откуда бы ни пришёл файл.
const WEAPON_PROPERTIES_RU = {
  amm: "боеприпас", ammunition: "боеприпас",
  fin: "фехтовальное", finesse: "фехтовальное",
  fir: "огнестрельное",
  foc: "фокусировка",
  hvy: "тяжёлое", heavy: "тяжёлое",
  lgt: "лёгкое", light: "лёгкое",
  lod: "заряжаемое", loading: "заряжаемое",
  rch: "досягаемость", reach: "досягаемость",
  rel: "надёжность", reload: "перезарядка",
  ret: "возвращающееся",
  spc: "особое", special: "особое",
  thr: "метательное", thrown: "метательное",
  two: "двуручное", twoHanded: "двуручное",
  ver: "универсальное", versatile: "универсальное",
  ada: "адамантиновое",
  mgc: "магическое",
  sil: "серебряное",
  concentration: "концентрация",
};

const DAMAGE_TYPE_RU = {
  acid: "кислота", bludgeoning: "дробящий", cold: "холод", fire: "огонь", force: "силовое поле",
  lightning: "электричество", necrotic: "некротический", piercing: "колющий", poison: "яд",
  psychic: "психическая энергия", radiant: "излучение", slashing: "рубящий", thunder: "звук",
};

function buildSource(source) {
  if (!source) return "";
  if (typeof source === "string") return source;
  const book = source.book || source.custom || "";
  return book && source.page ? `${book}, стр. ${source.page}` : book;
}

function buildCost(price) {
  if (!price || !price.value) return "";
  const denom = ru(DENOMINATION_RU, price.denomination) || price.denomination || "";
  return `${price.value} ${denom}`.trim();
}

function buildWeight(weight) {
  if (!weight) return "";
  const value = typeof weight === "object" ? weight.value : weight;
  if (!value) return "";
  const unit = typeof weight === "object" ? ru(WEIGHT_UNIT_RU, weight.units) || weight.units || "" : "фунт.";
  return `${value} ${unit}`.trim();
}

// weightToLb — то же system.weight, что и buildWeight выше, но числом в
// фунтах (см. domain.Item.WeightLb — используется для суммы веса инвентаря,
// см. pages/character-sheet.js) — units:"kg" (редкая метрическая домашка)
// переводится в фунты, всё остальное (в т.ч. отсутствие units — старые
// версии схемы dnd5e хранили вес всегда в фунтах без явных единиц) берётся
// как есть.
const KG_TO_LB = 2.20462;
function weightToLb(weight) {
  if (!weight) return 0;
  const value = typeof weight === "object" ? weight.value : weight;
  if (!value || typeof value !== "number") return 0;
  const units = typeof weight === "object" ? weight.units : "";
  return units === "kg" ? Math.round(value * KG_TO_LB * 100) / 100 : value;
}

// isAttunementRequired — Foundry менял представление этого поля между
// версиями схемы dnd5e: число 0/1/2 (0 — не нужна, 1 — нужна, 2 — уже
// настроен на конкретного владельца), либо строка "NONE"/"REQUIRED"/
// "ATTUNED", либо просто bool в самодельных экспортах. Не настроенный
// предмет (0/"NONE"/false/отсутствие поля) — единственный случай false.
function isAttunementRequired(attunement) {
  if (attunement === undefined || attunement === null || attunement === "") return false;
  if (typeof attunement === "number") return attunement > 0;
  if (typeof attunement === "string") return attunement.toUpperCase() !== "NONE";
  return !!attunement;
}

// buildActivation — activation.cost (dnd5e v2/v3) переименован в
// activation.value в v4/2024 ("Activities", см. primaryActivation ниже) —
// принимаем оба имени поля.
function buildActivation(activation) {
  const a = activation || {};
  if (!a.type || a.type === "none") return "";
  const unit = ru(ACTIVATION_TYPE_RU, a.type);
  const cost = a.cost !== undefined ? a.cost : a.value;
  const n = cost && cost !== 1 ? String(cost) + " " : a.type === "action" || a.type === "bonus" || a.type === "reaction" || a.type === "legendary" ? "1 " : cost ? String(cost) + " " : "";
  let text = (n + unit).trim();
  if (a.condition) text += ` (${a.condition})`;
  return text;
}

// primaryActivation — dnd5e v4/2024 убрал system.activation с самого
// предмета — активация переехала внутрь system.activities (карта из
// нескольких активностей: атака, лечение, "перезарядка" и т.п., см.
// mapFoundryItemJson). Берём activation первой активности, у которой он
// реально задан (activation.type непуст) — этого достаточно для текстового
// поля карточки, реальный бросок/выбор нужной активности всё равно решает
// игрок вручную, как и раньше с любым другим полем этого модуля.
function primaryActivation(sys) {
  if (sys.activation) return sys.activation; // старая схема (v2/v3) — как есть
  const activities = sys.activities && typeof sys.activities === "object" ? Object.values(sys.activities) : [];
  const found = activities.find((act) => act && act.activation && act.activation.type);
  return (found && found.activation) || null;
}

// buildCharges — три схемы дожили до сегодня: v2 (system.uses =
// {value,max,per}), v3 ({value,max,recovery:[{period,type,formula}]}), v4/2024
// ("Activities", {spent,max,recovery:[...]} — value заменили на spent,
// остаток теперь max-spent, а не value напрямую). Все дают одну и ту же
// человекочитаемую строку "N из M зарядов, ...".
function buildCharges(uses) {
  if (!uses || !uses.max) return "";
  const remaining = uses.spent !== undefined ? (Number(uses.max) || 0) - (Number(uses.spent) || 0) : uses.value ?? uses.max;
  let text = `${remaining} из ${uses.max} зарядов`;
  if (Array.isArray(uses.recovery) && uses.recovery.length) {
    const r = uses.recovery[0];
    text += `, восстановление: ${r.formula || ""} (${r.period || ""})`.replace("()", "").trim();
  } else if (uses.per) {
    const PER_RU = { day: "в день", dawn: "на рассвете", dusk: "на закате", charges: "заряды", sr: "короткий отдых", lr: "продолжительный отдых" };
    text += `, восстановление: ${ru(PER_RU, uses.per) || uses.per}`;
  }
  return text;
}

function buildWeaponProperties(sys) {
  // properties — Set/массив кодов в разных версиях схемы; в JSON после
  // сериализации Set превращается в объект {code: true} — учитываем и это.
  const raw = sys.properties;
  let codes = [];
  if (Array.isArray(raw)) codes = raw;
  else if (raw && typeof raw === "object") codes = Object.keys(raw).filter((k) => raw[k]);
  if (sys.proficient === false) codes = codes; // не игровое правило — сервер не считает бонус атаки, это поле сюда не идёт
  return codes.map((c) => ru(WEAPON_PROPERTIES_RU, c)).join(", ");
}

// damagePartText — один "кубик" урона в в4/2024 виде {number,denomination,
// types,bonus} → "2к10+1 (колющий)". types — Set в источнике, после
// сериализации в JSON это либо массив, либо объект {code:true} — тот же
// приём, что buildWeaponProperties.
function damagePartText(number, denomination, types, bonus) {
  if (!number || !denomination) return "";
  let formula = `${number}к${denomination}`;
  const b = (bonus ?? "").toString().trim();
  if (b) formula += b.startsWith("-") ? b : `+${b}`;
  const typeCodes = Array.isArray(types) ? types : types && typeof types === "object" ? Object.keys(types).filter((k) => types[k]) : [];
  const typeText = typeCodes.map((t) => ru(DAMAGE_TYPE_RU, t) || t).join("/");
  return typeText ? `${formula} (${typeText})` : formula;
}

// buildDamage — dnd5e менял форму system.damage дважды: v2/v3 (см. ветку
// parts ниже — массив [formula, type], versatile — просто строка) и v4/2024
// ("Activities" — base/versatile теперь объекты {number,denomination,types,
// bonus}, сама dice-формула больше не хранится готовой строкой). Обе ветки
// дают одну и ту же человекочитаемую строку "N (тип); универсальное: M".
function buildDamage(damage) {
  if (!damage) return "";
  if (damage.base && typeof damage.base === "object") {
    let text = damagePartText(damage.base.number, damage.base.denomination, damage.base.types, damage.base.bonus);
    const v = damage.versatile;
    if (v && typeof v === "object" && v.number && v.denomination) {
      const vTypes = v.types && (Array.isArray(v.types) ? v.types.length : Object.keys(v.types).length) ? v.types : damage.base.types;
      const vText = damagePartText(v.number, v.denomination, vTypes, v.bonus);
      if (vText) text += (text ? "; " : "") + `универсальное: ${vText}`;
    }
    return text;
  }
  const parts = Array.isArray(damage.parts) ? damage.parts : [];
  let text = parts
    .map((p) => {
      const formula = Array.isArray(p) ? p[0] : "";
      const type = Array.isArray(p) ? p[1] : "";
      return type ? `${formula} (${ru(DAMAGE_TYPE_RU, type) || type})` : formula;
    })
    .filter(Boolean)
    .join("; ");
  if (damage.versatile && typeof damage.versatile === "string") text += (text ? "; " : "") + `универсальное: ${damage.versatile}`;
  return text;
}

// buildArmorClass — та же формула D&D 5e, что и computeAC в monster-import.js
// (лёгкая: значение + Лов, средняя: + Лов не выше 2, тяжёлая: без Лов,
// щит/прочее — плоский бонус), но здесь речь о card-описании ("14 + Лов"), а
// не о готовом числе — сервер по-прежнему ничего не считает.
function buildArmorClass(sys) {
  const armor = sys.armor || {};
  if (armor.value === null || armor.value === undefined) return "";
  const type = sys.type && sys.type.value;
  if (type === "light") return `${armor.value} + Лов`;
  if (type === "medium") return `${armor.value} + Лов (макс 2)`;
  if (type === "heavy") return `${armor.value}`;
  if (type === "shield") return `+${armor.value}`;
  return `${armor.value}`;
}

// buildType — единственная по-настоящему "разветвлённая по типу предмета"
// часть модуля: Foundry отдаёт item.type (weapon/equipment/consumable/tool/
// loot/container/...) на верхнем уровне, а конкретный подвид — уже в
// system.type.value/baseItem/weaponType в зависимости от него.
function buildType(raw, sys) {
  const t = raw.type;
  const baseItem = (sys.type && sys.type.baseItem) || "";
  if (t === "weapon") {
    const category = ru(WEAPON_CATEGORY_RU, (sys.type && sys.type.value) || sys.weaponType);
    return [category, baseItem].filter(Boolean).join(", ") || "Оружие";
  }
  if (t === "equipment") {
    const kind = ru(EQUIPMENT_TYPE_RU, sys.type && sys.type.value);
    return [kind, baseItem].filter(Boolean).join(", ") || "Снаряжение";
  }
  if (t === "consumable") {
    const kind = ru(CONSUMABLE_TYPE_RU, sys.type && sys.type.value);
    return kind || "Расходуемый предмет";
  }
  if (t === "tool") {
    const kind = ru(TOOL_TYPE_RU, sys.type && sys.type.value);
    return [kind, baseItem].filter(Boolean).join(", ") || "Инструмент";
  }
  if (t === "loot") {
    const kind = ru(LOOT_TYPE_RU, sys.type && sys.type.value);
    return kind || "Хлам/сокровище";
  }
  if (t === "container" || t === "backpack") return "Контейнер";
  // feat — не классическая черта персонажа (та живёт в библиотеке черт
  // системы, вне предметов), а "дар"/способность, которую даёт магический
  // предмет (артефакт и т.п.) — попадается в компендиумах предметов именно
  // в этом виде, поэтому предмет, а не отдельная сущность.
  if (t === "feat") return "Дар предмета";
  return t || "";
}

const KNOWN_ITEM_TYPES = new Set(["weapon", "equipment", "consumable", "tool", "loot", "container", "backpack", "feat"]);

// mapFoundryItemJson — основной вход модуля. raw — уже распарсенный
// JSON.parse() объект файла экспорта предмета. Бросает Error с понятным
// сообщением, если это явно не предмет (заклинание/существо и т.п.).
export function mapFoundryItemJson(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Файл не похож на JSON предмета.");
  if (raw.type && !KNOWN_ITEM_TYPES.has(raw.type)) {
    throw new Error(`Это не похоже на предмет (type: "${raw.type}") — нужен экспорт оружия/доспеха/чудесного предмета из Foundry VTT.`);
  }
  const name = (raw.name || "").trim();
  if (!name) throw new Error("В файле нет имени предмета.");
  const sys = raw.system || {};

  return {
    name,
    source: buildSource(sys.source),
    type: buildType(raw, sys),
    rarity: ru(RARITY_RU, sys.rarity) || sys.rarity || "",
    requiresAttunement: isAttunementRequired(sys.attunement),
    cost: buildCost(sys.price),
    weight: buildWeight(sys.weight),
    weightLb: weightToLb(sys.weight),
    activation: buildActivation(primaryActivation(sys)),
    damage: raw.type === "weapon" ? buildDamage(sys.damage) : "",
    armorClass: raw.type === "equipment" ? buildArmorClass(sys) : "",
    properties: raw.type === "weapon" ? buildWeaponProperties(sys) : "",
    charges: buildCharges(sys.uses),
    description: (sys.description && sys.description.value) || "",
  };
}
