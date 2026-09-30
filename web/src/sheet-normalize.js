// sheet-normalize.js — лист персонажа в том виде, с которым работает страница
// листа (pages/character-sheet.js): сервер отдаёт domain.CharacterSheet, где
// пустые списки приходят null, а у старых листов нет полей, заведённых
// позже. normalizeSheet дозаполняет их прямо в переданном объекте — только
// общие поля ядра (хиты, деньги, ресурсы, заметки); поля игровой системы
// лист по схеме читает как есть, отсутствующее число берёт из default схемы.
// Отдельно от страницы, чтобы это можно было проверить без DOM (см.
// test/import-golden.test.js).

export function normalizeSheet(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  s.combat = s.combat || {};
  s.notes = Array.isArray(s.notes) && s.notes.length === 6 ? s.notes : ["", "", "", "", "", ""];
  // Деньги — словарь «ключ валюты → сумма» (domain.Coins): какие валюты,
  // решает система мира, поэтому ключи не выбрасываем и не дописываем —
  // только приводим суммы к целым не меньше нуля.
  s.coins = s.coins && typeof s.coins === "object" && !Array.isArray(s.coins) ? s.coins : {};
  for (const k of Object.keys(s.coins)) s.coins[k] = Math.max(0, parseInt(s.coins[k], 10) || 0);
  s.resources = Array.isArray(s.resources) ? s.resources : [];
  return s;
}
