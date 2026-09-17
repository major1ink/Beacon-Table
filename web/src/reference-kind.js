// reference-kind.js — виды записей справочника (domain.Reference.Kind —
// свободный текст) в одном месте: порядок в списке, глиф и цвет медальона,
// поле листа персонажа, куда запись попадает подсказкой (см.
// pages/character-sheet.js: referenceNames). Незнакомый вид — не ошибка:
// без цвета, глиф «свиток», без поля на листе.
export const REFERENCE_KINDS = [
  { key: "класс", glyph: "sword", color: "#c9a24a", sheetField: "Класс" },
  { key: "архетип", glyph: "sword", color: "#c9a24a", sheetField: "Подкласс", hasParent: true },
  { key: "вид", glyph: "feather", color: "#3fb950", sheetField: "Вид" },
  { key: "черта вида", glyph: "feather", color: "#3fb950" },
  { key: "происхождение", glyph: "scroll", color: "#a371f7", sheetField: "Предыстория" },
  { key: "черта", glyph: "sparkle", color: "#4a8ef0" },
  { key: "черта класса", glyph: "sparkle", color: "#4a8ef0" },
];

export const kindKey = (text) =>
  String(text || "")
    .trim()
    .toLowerCase();

export function kindInfo(text) {
  return REFERENCE_KINDS.find((k) => k.key === kindKey(text)) || null;
}

export function kindRank(text) {
  const i = REFERENCE_KINDS.findIndex((k) => k.key === kindKey(text));
  return i === -1 ? REFERENCE_KINDS.length : i;
}

export function kindLabel(text) {
  const k = kindKey(text);
  return k ? k.charAt(0).toUpperCase() + k.slice(1) : "";
}
