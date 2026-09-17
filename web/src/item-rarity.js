// item-rarity.js — редкость предмета (domain.Item.Rarity — свободный текст)
// в одном месте: порядок для группировки в списке, русские имена для
// импорта из Foundry и цвет карточки/бейджа. Незнакомая редкость — не
// ошибка: без цвета и в конце списка.
export const RARITY = [
  { key: "common", ru: "обычный", color: "#9aa0a6" },
  { key: "uncommon", ru: "необычный", color: "#3fb950" },
  { key: "rare", ru: "редкий", color: "#4a8ef0" },
  { key: "veryRare", ru: "очень редкий", color: "#a371f7" },
  { key: "legendary", ru: "легендарный", color: "#e3a008" },
  { key: "artifact", ru: "артефакт", color: "#d9534f" },
  { key: "varies", ru: "разное", color: "" },
];

// rarityKey — текст поля, приведённый к виду для сравнения («Редкий » → «редкий»).
export function rarityKey(text) {
  return String(text || "")
    .trim()
    .toLowerCase();
}

// rarityRank — место в списке: известные по порядку, остальное в конец.
export function rarityRank(text) {
  const i = RARITY.findIndex((r) => r.ru === rarityKey(text));
  return i === -1 ? RARITY.length : i;
}

// rarityColor — цвет медальона и плашки; пусто у незнакомой.
export function rarityColor(text) {
  const r = RARITY.find((x) => x.ru === rarityKey(text));
  return r ? r.color : "";
}

// rarityFromFoundry — код dnd5e (system.rarity) → русское имя; чужой код
// остаётся как есть, чтобы не потерять.
export function rarityFromFoundry(code) {
  if (!code) return "";
  const r = RARITY.find((x) => x.key === code);
  return r ? r.ru : code;
}
