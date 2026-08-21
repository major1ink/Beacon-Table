// condition-import.test.js — разбор документов ActiveEffect из Foundry VTT
// в карточки состояний (см. web/src/condition-import.js) и вытаскивание
// «что накладывает заклинание» из его effects[] (web/src/spell-import.js:
// mapFoundrySpellStatuses).
//
// Фикстуры — урезанные, но структурно настоящие куски экспорта Foundry
// dnd5e: у эффекта statuses[] с кодом состояния, duration в секундах (так
// приходит «1 минута» у заклинаний), changes[] с режимами ACTIVE_EFFECT_MODES
// и flags.core.overlay.
import test from "node:test";
import assert from "node:assert/strict";

const { mapFoundryConditionBatch, mapFoundryEffect, describeChanges, effectRounds } = await import(
  "../src/condition-import.js"
);
const { mapFoundrySpellStatuses } = await import("../src/spell-import.js");
const { foundryStatusToSlug, conditionName } = await import("../src/foundry-conditions.js");

// Экспорт заклинания «Удержание личности» из dnd5e: сам предмет плюс
// вложенный ActiveEffect, который и вешает состояние.
const holdPersonSpell = {
  name: "Hold Person",
  type: "spell",
  system: { level: 2, school: "enc", duration: { value: 1, units: "minute" } },
  effects: [
    {
      name: "Paralyzed (failed save)",
      img: "icons/svg/paralysis.svg",
      statuses: ["paralyzed"],
      duration: { seconds: 60 },
      changes: [],
      flags: { core: {} },
    },
  ],
};

test("effects[] заклинания превращаются в список накладываемых состояний", () => {
  const refs = mapFoundrySpellStatuses(holdPersonSpell);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].slug, "paralyzed");
  assert.equal(refs[0].name, "Паралич");
  // 60 секунд = 10 раундов по 6 секунд — так же считает и сама Foundry.
  assert.equal(refs[0].rounds, 10);
  // Имя эффекта несёт условие применения — сохраняем его заметкой.
  assert.equal(refs[0].note, "Paralyzed (failed save)");
});

test("у заклинания без effects[] список пустой, а не падение", () => {
  assert.deepEqual(mapFoundrySpellStatuses({ name: "Magic Missile", type: "spell" }), []);
  assert.deepEqual(mapFoundrySpellStatuses(null), []);
});

test("эффект внутри предмета даёт карточку состояния", () => {
  const cards = mapFoundryConditionBatch(holdPersonSpell);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].slug, "paralyzed");
  assert.equal(cards[0].defaultRounds, 10);
  // Путь к иконке Foundry ведёт внутрь её установки — подставляем свой глиф,
  // а исходный путь оставляем следом в тегах.
  assert.equal(cards[0].icon, "⚡");
  assert.ok(cards[0].tags.includes("foundry:paralysis.svg"));
});

test("одиночный ActiveEffect: overlay, changes[] в модификаторы, коды ядра Foundry", () => {
  const raw = {
    name: "Blinded",
    img: "icons/svg/blind.svg",
    statuses: ["blind"], // код ядра Foundry, не dnd5e
    duration: { rounds: 3 },
    description: "<p>&nbsp;</p><p>Не видит.</p>",
    changes: [
      { key: "system.attributes.ac.bonus", mode: 2, value: "-2" },
      { key: "system.attributes.movement.walk", mode: 5, value: "0" },
    ],
    flags: { core: { overlay: true } },
  };
  const card = mapFoundryEffect(raw);
  assert.equal(card.slug, "blinded", "код ядра blind должен свестись к нашему blinded");
  assert.equal(card.defaultRounds, 3);
  assert.equal(card.overlay, true);
  assert.equal(card.description, "<p>Не видит.</p>", "пустая обёртка вычищена");
  // Оба изменения ложатся на наши цели, значит становятся применяемыми
  // модификаторами, а не текстом (см. condition-import.js: mapFoundryChanges).
  assert.deepEqual(
    card.modifiers.map((x) => `${x.target}/${x.mode}/${x.value}`),
    ["ac/add/-2", "speed/set/0"]
  );
  assert.equal(card.mechanics, "", "текстового остатка тут быть не должно — всё разобрано в числа");
});

test("массив документов: дубли по slug схлопываются", () => {
  const cards = mapFoundryConditionBatch([
    { name: "Prone", statuses: ["prone"], duration: {} },
    { name: "Ничком", statuses: ["prone"], duration: {} },
    { name: "Frightened", statuses: ["fear"], duration: {} },
  ]);
  assert.deepEqual(
    cards.map((c) => c.slug),
    ["prone", "frightened"]
  );
});

test("незнакомый код состояния не теряется", () => {
  assert.equal(foundryStatusToSlug("bleeding"), "bleeding");
  // Незнакомому slug'у имени в словаре нет — отдаём сам slug, чтобы карточка
  // не осталась безымянной.
  assert.equal(conditionName("что-то-своё"), "");
  assert.equal(conditionName("supercharged"), "supercharged");
  // UUID-подобная форма ("dnd5e.prone") сводится к последнему сегменту.
  assert.equal(foundryStatusToSlug("dnd5e.prone"), "prone");
});

test("длительность: rounds важнее секунд, отсутствие даёт 0", () => {
  assert.equal(effectRounds({ rounds: 2, seconds: 600 }), 2);
  assert.equal(effectRounds({ seconds: 60 }), 10);
  assert.equal(effectRounds({}), 0);
  assert.equal(effectRounds(undefined), 0);
});

test("пустой changes[] не даёт мусорного текста", () => {
  assert.equal(describeChanges([]), "");
  assert.equal(describeChanges(undefined), "");
});
