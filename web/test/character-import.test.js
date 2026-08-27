// character-import.test.js — mapFoundryCharacterJson (см.
// web/src/character-import.js): актёр Foundry type "character" →
// domain.CharacterSheet. Фиксируем перенос ключевых полей (характеристики,
// владения, HP/AC, класс/уровень, ячейки/заклинания, оружие) и границу типа.
import test from "node:test";
import assert from "node:assert/strict";

const { mapFoundryCharacterJson } = await import("../src/character-import.js");

const sampleActor = {
  name: "Шила",
  type: "character",
  img: "modules/ag/actors/shila.webp",
  system: {
    abilities: {
      str: { value: 10, proficient: 0 },
      dex: { value: 16, proficient: 1 },
      con: { value: 14, proficient: 0 },
      int: { value: 12, proficient: 0 },
      wis: { value: 13, proficient: 0 },
      cha: { value: 8, proficient: 0 },
    },
    skills: {
      ste: { value: 2, ability: "dex" },
      acr: { value: 1, ability: "dex" },
      prc: { value: 1, ability: "wis" },
    },
    attributes: {
      hp: { value: 18, max: 21, temp: 0 },
      ac: { value: 14 },
      movement: { walk: 30 },
      senses: { darkvision: 60 },
      spellcasting: "int",
    },
    details: {
      alignment: "Хаотично-нейтральный",
      xp: { value: 900 },
      biography: { value: "<p>Выросла в порту.</p>" },
      ideal: "Свобода.",
    },
    spells: { spell1: { max: 3 }, spell2: { max: 0 } },
    currency: { gp: 15, sp: 3 },
    traits: {
      languages: { value: ["common", "thievescant"] },
      armorProf: { value: ["lgt"] },
      weaponProf: { value: ["sim"] },
    },
  },
  items: [
    { type: "class", name: "Плут", system: { levels: 3, hd: { denomination: "d8" } } },
    { type: "subclass", name: "Мошенник" },
    { type: "race", name: "Полурослик" },
    { type: "background", name: "Преступник" },
    { type: "feat", name: "Скрытная атака", system: { description: { value: "<p>1к6 доп. урона.</p>" } } },
    {
      type: "weapon",
      name: "Короткий меч",
      system: {
        properties: ["fin"],
        proficient: 1,
        damage: { base: { number: 1, denomination: "6", types: ["piercing"] } },
      },
    },
    { type: "spell", name: "Волшебная рука", system: { level: 0 } },
    { type: "spell", name: "Маскировка", system: { level: 1, properties: { concentration: true } } },
    { type: "equipment", name: "Кожаный доспех", system: { quantity: 1 } },
  ],
};

test("не-персонаж отклоняется", () => {
  assert.throws(() => mapFoundryCharacterJson({ name: "Гоблин", type: "npc" }), /не персонаж/);
});

test("имя обязательно", () => {
  assert.throws(() => mapFoundryCharacterJson({ type: "character", name: "  " }), /имени/);
});

test("характеристики, владения и навыки", () => {
  const { sheet } = mapFoundryCharacterJson(sampleActor);
  assert.equal(sheet.abilities.dex, 16);
  assert.equal(sheet.saveProf.dex, true);
  assert.equal(sheet.saveProf.str, false);
  assert.equal(sheet.skillProf.stealth, 2);
  assert.equal(sheet.skillProf.acrobatics, 1);
  assert.equal(sheet.skillProf.perception, 1);
});

test("класс/подкласс/вид/предыстория/уровень/опыт", () => {
  const { name, avatarUrl, sheet } = mapFoundryCharacterJson(sampleActor);
  assert.equal(name, "Шила");
  assert.equal(avatarUrl, "modules/ag/actors/shila.webp");
  assert.equal(sheet.info.class, "Плут 3");
  assert.equal(sheet.info.subclass, "Мошенник");
  assert.equal(sheet.info.species, "Полурослик");
  assert.equal(sheet.info.background, "Преступник");
  assert.equal(sheet.info.level, 3);
  assert.equal(sheet.info.xp, 900);
  assert.equal(sheet.combat.hitDiceTotal, "3к8");
});

test("бой: HP/AC/скорость/тёмное зрение", () => {
  const { sheet } = mapFoundryCharacterJson(sampleActor);
  assert.equal(sheet.combat.hpMax, 21);
  assert.equal(sheet.combat.hpCurrent, 18);
  assert.equal(sheet.combat.ac, 14);
  assert.equal(sheet.combat.speed, 30);
  assert.equal(sheet.combat.darkvision, 60);
});

// Предген приключения из Foundry dnd5e v4: производные показатели на актёре
// пусты (hp.max/ac.value/movement.walk/senses.darkvision = null) — движок
// собирает их из вида, класса и снаряжения. Импорт обязан посчитать сам,
// иначе в листе нули (см. web/src/character-import.js: computeArmorClass и др.).
const v4Pregen = {
  name: "Нико",
  type: "character",
  system: {
    abilities: {
      str: { value: 12 },
      dex: { value: 10 },
      con: { value: 13 },
      int: { value: 10 },
      wis: { value: 15 },
      cha: { value: 8 },
    },
    attributes: {
      hp: { value: 11, max: null, temp: 0 },
      ac: { calc: "default" },
      movement: { walk: null },
      senses: { darkvision: null },
    },
    details: { xp: { value: 0 } },
  },
  items: [
    { type: "race", name: "Человек", system: { movement: { walk: 30 }, senses: { darkvision: null } } },
    { type: "class", name: "Жрец", system: { levels: 1, identifier: "cleric", hd: { denomination: "d8" } } },
    {
      type: "equipment",
      name: "Кольчужная рубаха",
      system: { equipped: true, type: { value: "medium" }, armor: { value: 13, dex: 2 } },
    },
    {
      type: "equipment",
      name: "Щит",
      system: { equipped: true, type: { value: "shield" }, armor: { value: 2 } },
    },
  ],
};

test("предген v4: КЗ/скорость/тёмное зрение/макс. ХП считаются из вида и снаряжения", () => {
  const { sheet } = mapFoundryCharacterJson(v4Pregen);
  // Кольчужная рубаха 13 + min(Лов 0, 2) + щит 2.
  assert.equal(sheet.combat.ac, 15);
  assert.equal(sheet.combat.hpMax, 11); // hp.max пуст → берём hp.value
  assert.equal(sheet.combat.hpCurrent, 11);
  assert.equal(sheet.combat.speed, 30); // от вида «Человек»
  assert.equal(sheet.combat.darkvision, 0);
});

test("предген v4: «Защита без брони» варвара и монаха без доспеха", () => {
  const base = { ...v4Pregen, items: [v4Pregen.items[0]] };
  const barb = mapFoundryCharacterJson({
    ...base,
    items: [base.items[0], { type: "class", name: "Варвар", system: { levels: 1, identifier: "barbarian", hd: { denomination: "d12" } } }],
  });
  // 10 + Лов 0 + Тел +1.
  assert.equal(barb.sheet.combat.ac, 11);
  const monk = mapFoundryCharacterJson({
    ...base,
    items: [base.items[0], { type: "class", name: "Монах", system: { levels: 1, identifier: "monk", hd: { denomination: "d8" } } }],
  });
  // 10 + Лов 0 + Мдр +2.
  assert.equal(monk.sheet.combat.ac, 12);
});

test("ячейки заклинаний и подготовленные заклинания", () => {
  const { sheet } = mapFoundryCharacterJson(sampleActor);
  assert.equal(sheet.spellcasting.ability, "int");
  assert.equal(sheet.spellcasting.slotsByLevel[0], "3");
  assert.equal(sheet.spellcasting.slotsByLevel[1], "");
  const disguise = sheet.preparedSpells.find((s) => s.name === "Маскировка");
  assert.equal(disguise.level, 1);
  assert.equal(disguise.concentration, true);
});

test("оружие: бонус попадания и урон", () => {
  const { sheet } = mapFoundryCharacterJson(sampleActor);
  const sword = sheet.weapons.find((w) => w.name === "Короткий меч");
  // Лов +3, бонус мастерства +2 (3 ур.), финес → dex. Попадание +5, урон 1к6 +3.
  assert.equal(sword.bonus, "+5");
  assert.match(sword.damage, /1к6 \+3 колющий/);
});

test("монеты, языки, снаряжение текстом", () => {
  const { sheet } = mapFoundryCharacterJson(sampleActor);
  assert.equal(sheet.coins.gp, 15);
  assert.equal(sheet.coins.sp, 3);
  assert.match(sheet.toolsLanguages, /Общий/);
  assert.match(sheet.equipment, /Кожаный доспех/);
  assert.equal(sheet.alignment, "Хаотично-нейтральный");
  assert.match(sheet.background, /Выросла в порту/);
  assert.equal(sheet.ideals, "Свобода.");
});
