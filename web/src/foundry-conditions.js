// foundry-conditions.js — единственный на весь фронт словарь «код состояния
// у Foundry → наш slug + русское имя» (см. internal/domain/condition.go:
// Slug). Раньше эта таблица жила копией внутри monster-import.js (для
// строки «Иммунитет к состояниям»); теперь она нужна сразу трём импортёрам
// и палитре, поэтому вынесена сюда — как и в остальных модулях импорта,
// это чистые данные и чистые функции, сервер про формат Foundry по-прежнему
// не знает ничего.
//
// Откуда коды. У системы dnd5e в Foundry состояния лежат в
// CONFIG.DND5E.conditionTypes и CONFIG.DND5E.statusEffects, а в документах
// (ActiveEffect) приходят массивом statuses: ["prone"]. У ядра Foundry
// (CONFIG.statusEffects, «generic»-набор, который видно в HUD токена, если
// система не переопределила его) часть кодов другая: "blind" вместо
// "blinded", "fear" вместо "frightened" и т.п. Принимаем оба набора —
// импорт не должен зависеть от того, из какого места Foundry человек нажал
// «Export Data».

// FOUNDRY_ALIASES — коды, которые НЕ совпадают с нашим slug'ом один в один.
// Всё, что здесь не перечислено, используется как есть (наши slug'и
// каталога «из коробки» намеренно взяты равными кодам dnd5e —
// cmd/beacon-table/systemdata/conditions/<system>/<slug>.json).
const FOUNDRY_ALIASES = {
  // ядро Foundry (generic-набор)
  blind: "blinded",
  deaf: "deafened",
  fear: "frightened",
  paralysis: "paralyzed",
  restrain: "restrained",
  stun: "stunned",
  sleep: "unconscious", // «спит» у ядра — отдельная иконка, по эффекту ближайшее к беспамятству
  poison: "poisoned",
  disease: "diseased",
  curse: "cursed",
  silence: "silenced",
  fly: "flying",
  hover: "hovering",
  burrow: "burrowing",
  target: "marked",
  eye: "marked",
  // dnd5e — служебные статусы вне списка официальных состояний
  concentration: "concentrating",
  hidden: "hiding",
  hide: "hiding",
};

// CONDITION_RU — slug → русское название СТРОЧНОЙ буквы. Строчной, потому
// что исторически (и до сих пор) эта таблица используется для склейки
// строки «Иммунитет к состояниям: ослепление, испуг, отравление» в импорте
// статблока (см. monster-import.js) — там название стоит в середине
// перечисления, а не в начале предложения. Для заголовка карточки есть
// conditionName() ниже.
export const CONDITION_RU = {
  blinded: "ослепление",
  charmed: "очарование",
  deafened: "глухота",
  exhaustion: "истощение",
  frightened: "испуг",
  grappled: "схват",
  incapacitated: "недееспособность",
  invisible: "невидимость",
  paralyzed: "паралич",
  petrified: "окаменение",
  poisoned: "отравление",
  prone: "положение ничком",
  restrained: "опутанность",
  stunned: "ошеломление",
  unconscious: "беспамятство",
  surprised: "застигнут врасплох",
  // служебные метки и «околосостояния» из набора dnd5e/ядра — их нет в
  // списке официальных состояний, но в экспортах они встречаются
  concentrating: "концентрация",
  dodging: "уклонение",
  hiding: "скрытность",
  marked: "помечен",
  dead: "мёртв",
  stable: "стабилизирован",
  bleeding: "кровотечение",
  burning: "горение",
  cursed: "проклятие",
  diseased: "болезнь",
  silenced: "немота",
  transformed: "превращение",
  ethereal: "эфирность",
  flying: "полёт",
  hovering: "парение",
  burrowing: "закапывание",
  sleeping: "сон",
};

// foundryStatusToSlug — код состояния из документа Foundry → наш slug.
// Незнакомый код НЕ выбрасывается, а нормализуется и возвращается как есть:
// метка всё равно повесится (сервер соберёт снимок из одного slug'а, см.
// room_statuses.go: snapshotStatus), а ДМ потом заведёт карточку в
// конструкторе — тот же принцип «незнакомое значение не теряем молча», что
// и у остальных импортёров.
export function foundryStatusToSlug(code) {
  const raw = String(code || "").trim();
  if (!raw) return "";
  // Иногда статус приезжает как UUID/ключ вида "dnd5e.prone" или
  // "Compendium.dnd5e.rules.JournalEntry.xxx.JournalEntryPage.yyy" — берём
  // последний осмысленный сегмент, если он похож на код.
  const tail = raw.includes(".") ? raw.split(".").pop() : raw;
  const key = tail.trim().toLowerCase();
  const aliased = Object.prototype.hasOwnProperty.call(FOUNDRY_ALIASES, key) ? FOUNDRY_ALIASES[key] : key;
  return normalizeSlug(aliased);
}

// normalizeSlug — та же нормализация, что и на сервере (см.
// service.NormalizeConditionSlug): нижний регистр, пробелы/подчёркивания в
// дефис, остальное вырезано. Дублируется намеренно, чтобы клиент показывал
// ровно тот slug, который сервер потом и запишет, — а не тот, что «почти»
// совпадает.
export function normalizeSlug(slug) {
  return String(slug || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_.]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// conditionName — читаемое имя по slug'у, С ЗАГЛАВНОЙ буквы («Ослепление»).
// Для незнакомого slug'а возвращает сам slug — лучше «bleeding» в карточке,
// чем пустое место.
export function conditionName(slug) {
  const key = normalizeSlug(slug);
  const ru = CONDITION_RU[key];
  if (!ru) return key;
  return ru.charAt(0).toUpperCase() + ru.slice(1);
}

// DEFAULT_ICONS — глиф по умолчанию для импортированного состояния, у
// которого в библиотеке ещё нет карточки (см. condition-import.js). Совпадает
// с иконками каталога «из коробки», чтобы импортированная копия выглядела
// так же, как встроенная.
export const DEFAULT_ICONS = {
  blinded: "🙈",
  charmed: "💗",
  deafened: "🙉",
  exhaustion: "🪫",
  frightened: "😱",
  grappled: "🤼",
  incapacitated: "🚫",
  invisible: "👻",
  paralyzed: "⚡",
  petrified: "🗿",
  poisoned: "🤢",
  prone: "🛌",
  restrained: "🕸️",
  stunned: "💫",
  unconscious: "😵",
  surprised: "❗",
  concentrating: "🧠",
  dodging: "💨",
  hiding: "🫥",
  marked: "🎯",
  dead: "💀",
  stable: "🩹",
  bleeding: "🩸",
  burning: "🔥",
  cursed: "🌚",
  diseased: "🦠",
  silenced: "🤐",
  transformed: "🦎",
  ethereal: "🌫️",
  flying: "🕊️",
  hovering: "🎈",
  burrowing: "⛏️",
  sleeping: "💤",
};

export function defaultIcon(slug) {
  return DEFAULT_ICONS[normalizeSlug(slug)] || "❔";
}
