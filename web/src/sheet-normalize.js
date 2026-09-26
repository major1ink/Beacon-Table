// sheet-normalize.js — лист персонажа в том виде, с которым работают бланк
// (pages/character-sheet.js) и импорт LSS (lss-import.js): сервер отдаёт
// domain.CharacterSheet, где пустые списки приходят null, а у старых листов
// нет полей, заведённых позже. normalizeSheet дозаполняет их дефолтами прямо
// в переданном объекте. Отдельно от страницы, чтобы импорт можно было
// проверить тем же путём без DOM (см. test/import-golden.test.js).

const ABILITY_KEYS = ["str", "dex", "con", "int", "wis", "cha"];

export function normalizeSheet(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
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
  s.notes = Array.isArray(s.notes) && s.notes.length === 6 ? s.notes : ["", "", "", "", "", ""];
  s.spellcasting = s.spellcasting || {};
  s.spellcasting.ability = s.spellcasting.ability || "";
  s.spellcasting.slotsByLevel =
    Array.isArray(s.spellcasting.slotsByLevel) && s.spellcasting.slotsByLevel.length === 9
      ? s.spellcasting.slotsByLevel
      : ["", "", "", "", "", "", "", "", ""];
  s.preparedSpells = Array.isArray(s.preparedSpells) ? s.preparedSpells : [];
  // Деньги — словарь «ключ валюты → сумма» (domain.Coins): какие валюты,
  // решает система мира, поэтому ключи не выбрасываем и не дописываем —
  // только приводим суммы к целым не меньше нуля.
  s.coins = s.coins && typeof s.coins === "object" && !Array.isArray(s.coins) ? s.coins : {};
  for (const k of Object.keys(s.coins)) s.coins[k] = Math.max(0, parseInt(s.coins[k], 10) || 0);
  // personalityTraits/ideals/bonds/flaws — показываются на обеих системах
  // (см. renderTab1/renderTab4 ниже), просто в разных местах листа;
  // race/species — только 2014/2024 соответственно, у "чужой" системы
  // остаются пустой строкой, ничего не отображающей.
  s.personalityTraits = s.personalityTraits || "";
  s.ideals = s.ideals || "";
  s.bonds = s.bonds || "";
  s.flaws = s.flaws || "";
  s.info.race = s.info.race || "";
  s.info.species = s.info.species || "";
  s.info.playerName = s.info.playerName || "";
  s.physical = s.physical || {};
  for (const k of ["age", "height", "weight", "eyes", "skin", "hair"]) s.physical[k] = s.physical[k] || "";
  s.traits = s.traits || "";
  s.proficiencyNotes = s.proficiencyNotes || "";
  s.combat.darkvision = s.combat.darkvision || 0;
  s.combat.isDying = !!s.combat.isDying;
  s.resources = Array.isArray(s.resources) ? s.resources : [];
  // attunementItems — заменяет прежние безымянные 3 чекбокса (см.
  // internal/domain/character_sheet.go: AttunementItems); дополняем как
  // минимум до 3 строк при первой загрузке, чтобы сохранить привычный UX
  // "3 слота", но список динамический — можно добавлять/удалять строки.
  s.attunementItems = Array.isArray(s.attunementItems) ? s.attunementItems.slice() : [];
  while (s.attunementItems.length < 3) s.attunementItems.push({ name: "", attuned: false });
  return s;
}
