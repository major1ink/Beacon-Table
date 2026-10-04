// Прежние правила D&D для каталога, медальона и подписи существа — эталон, с
// которым тесты сверяют схемы карточек на всём каталоге из репозитория модулей.
export const SCHOOLS = [
  { ru: "Ограждение", glyph: "shield", color: "#4a8ef0" },
  { ru: "Вызов", glyph: "scroll", color: "#f59f00" },
  { ru: "Прорицание", glyph: "eye", color: "#e3a008" },
  { ru: "Очарование", glyph: "heart", color: "#d6336c" },
  { ru: "Воплощение", glyph: "flame", color: "#e8590c" },
  { ru: "Иллюзия", glyph: "sparkle", color: "#a371f7" },
  { ru: "Некромантия", glyph: "skull", color: "#7fbf7f" },
  { ru: "Преобразование", glyph: "swap", color: "#20c997" },
];

const lower = (text) => String(text || "").trim().toLowerCase();

export const schoolInfo = (text) => SCHOOLS.find((s) => s.ru.toLowerCase() === lower(text)) || null;

const RARITY = [
  { ru: "обычный", color: "#9aa0a6" },
  { ru: "необычный", color: "#3fb950" },
  { ru: "редкий", color: "#4a8ef0" },
  { ru: "очень редкий", color: "#a371f7" },
  { ru: "легендарный", color: "#e3a008" },
  { ru: "артефакт", color: "#d9534f" },
  { ru: "разное", color: "" },
];

export const rarityKey = lower;
export const rarityColor = (text) => (RARITY.find((r) => r.ru === lower(text)) || { color: "" }).color;

const REFERENCE_KINDS = [
  { key: "класс", glyph: "sword", color: "#c9a24a" },
  { key: "архетип", glyph: "sword", color: "#c9a24a" },
  { key: "вид", glyph: "feather", color: "#3fb950" },
  { key: "черта вида", glyph: "feather", color: "#3fb950" },
  { key: "происхождение", glyph: "scroll", color: "#a371f7" },
  { key: "черта", glyph: "sparkle", color: "#4a8ef0" },
  { key: "черта класса", glyph: "sparkle", color: "#4a8ef0" },
];

export const kindKey = lower;
export const kindInfo = (text) => REFERENCE_KINDS.find((k) => k.key === lower(text)) || null;
export const kindLabel = (text) => {
  const k = lower(text);
  return k ? k.charAt(0).toUpperCase() + k.slice(1) : "";
};

const ITEM_TYPE_RULES = [
  { category: "Оружие", test: /оружие/i },
  { category: "Доспехи", test: /доспех|броня|щит/i },
  { category: "Кольца", test: /кольцо/i },
  { category: "Жезлы", test: /жезл|посох|палочк/i },
  { category: "Чудесные предметы", test: /чудесн/i },
  { category: "Инструменты", test: /инструмент/i },
];

export function classifyItemType(typeText) {
  const t = (typeText || "").trim();
  if (t) for (const rule of ITEM_TYPE_RULES) if (rule.test.test(t)) return rule.category;
  return "Безделушки";
}

export function classifyReferenceKind(kind) {
  const k = lower(kind);
  if (k === "класс" || k === "архетип") return "class";
  if (k === "вид") return "species";
  if (k === "происхождение") return "background";
  return "trait";
}

const ITEM_GLYPH_RULES = [
  [/щит|доспех|кольчуг|латы|броня|кожан/i, "shield"],
  [/лук|арбалет|праща/i, "bow"],
  [/меч|топор|кинжал|копь|молот|булав|дубин|оружи|клинок|сабл|рапир|глеф|алебард/i, "sword"],
  [/зель|эликсир|яд|масло|флакон|расходн/i, "flask"],
  [/свит|книг|том|манускрипт/i, "scroll"],
  [/жезл|палоч|посох/i, "wand"],
  [/кольц|амулет|ожерель|перст|талисман/i, "ring"],
  [/монет|сокровищ|драгоцен|самоцвет/i, "coin"],
];

export function itemGlyphName(item) {
  const t = String((item && item.type) || "");
  for (const [re, name] of ITEM_GLYPH_RULES) if (re.test(t)) return name;
  return "box";
}

export const ABILITIES = [
  { key: "str", label: "Сил" },
  { key: "dex", label: "Лов" },
  { key: "con", label: "Тел" },
  { key: "int", label: "Инт" },
  { key: "wis", label: "Мдр" },
  { key: "cha", label: "Хар" },
];

export const abilityMod = (score) => Math.floor(((score || 0) - 10) / 2);
export const fmtMod = (n) => (n >= 0 ? "+" + n : "−" + Math.abs(n));

export function crColor(cr) {
  const t = String(cr || "").trim();
  if (!t) return "";
  let n;
  if (t.includes("/")) {
    const [a, b] = t.split("/").map(Number);
    n = a / (b || 1);
  } else n = parseFloat(t.replace(",", "."));
  if (!Number.isFinite(n)) return "";
  if (n < 1) return "#9aa0a6";
  if (n < 5) return "#3fb950";
  if (n < 11) return "#4a8ef0";
  if (n < 17) return "#a371f7";
  return "#e3a008";
}

const TYPE_RULES = [
  [/нежить|скелет|зомби|призрак|вампир/i, "skull"],
  [/дракон/i, "dragon"],
  [/зверь|животн|чудовищ/i, "paw"],
  [/исчадие|демон|дьявол|бес/i, "horns"],
  [/растен|дерев/i, "tree"],
  [/аберрац|слизь/i, "eye"],
  [/фея|небожител|элементал/i, "sparkle"],
  [/конструкт|голем/i, "box"],
  [/гуманоид|великан/i, "hood"],
];

export function monsterGlyphName(monster) {
  const t = String((monster && monster.type) || "");
  for (const [re, name] of TYPE_RULES) if (re.test(t)) return name;
  return "hood";
}
