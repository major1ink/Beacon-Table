// spell-school.js — школы магии (domain.Spell.School — свободный текст) в
// одном месте: код dnd5e для импорта, русское имя, глиф и цвет медальона.
// Незнакомая школа остаётся текстом: без цвета, глиф «искра».
export const SCHOOLS = [
  { key: "abj", ru: "Ограждение", glyph: "shield", color: "#4a8ef0" },
  { key: "con", ru: "Вызов", glyph: "scroll", color: "#f59f00" },
  { key: "div", ru: "Прорицание", glyph: "eye", color: "#e3a008" },
  { key: "enc", ru: "Очарование", glyph: "heart", color: "#d6336c" },
  { key: "evo", ru: "Воплощение", glyph: "flame", color: "#e8590c" },
  { key: "ill", ru: "Иллюзия", glyph: "sparkle", color: "#a371f7" },
  { key: "nec", ru: "Некромантия", glyph: "skull", color: "#7fbf7f" },
  { key: "trs", ru: "Преобразование", glyph: "swap", color: "#20c997" },
];

export function schoolInfo(text) {
  const t = String(text || "")
    .trim()
    .toLowerCase();
  return SCHOOLS.find((s) => s.ru.toLowerCase() === t) || null;
}

export function schoolFromFoundry(code) {
  if (!code) return "";
  const s = SCHOOLS.find((x) => x.key === code);
  return s ? s.ru : code;
}
