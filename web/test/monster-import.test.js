// monster-import.test.js — mapFoundryMonsterJson (см. web/src/monster-import.js)
// принимает npc/character/vehicle и отказывается от всего остального; сама
// карта полей статблока покрыта используемым импортом на живых модулях, тут
// фиксируем только границу типов, которую легко случайно сузить обратно.
import test from "node:test";
import assert from "node:assert/strict";

const { mapFoundryMonsterJson } = await import("../src/monster-import.js");

test("npc/character маппятся как обычно", () => {
  const npc = mapFoundryMonsterJson({ name: "Гоблин", type: "npc", system: {} });
  assert.equal(npc.name, "Гоблин");
});

// Транспорт (vehicle) теперь тоже едет в бестиарий (см. internal/foundry/
// classify.go: actorTarget) — статблок корабля/повозки ложится в те же
// свободные текстовые поля Monster. Ability-полей у vehicle-актёра в dnd5e
// обычно нет — маппер должен молча подставить дефолты, а не упасть.
test("vehicle маппится, а не отбрасывается как неизвестный тип", () => {
  const vehicle = mapFoundryMonsterJson({ name: "Галеон", type: "vehicle", system: {} });
  assert.equal(vehicle.name, "Галеон");
  assert.equal(vehicle.abilities.str, 10); // дефолт — у vehicle нет system.abilities
});

test("group и прочие незнакомые типы актёра отклоняются", () => {
  assert.throws(() => mapFoundryMonsterJson({ name: "Отряд", type: "group", system: {} }), /не существо/);
});

// Бонус попадания и урон оружия TTG Club держит в машинных полях предмета,
// а не в тексте описания (см. weaponAttackLine в monster-import.js). Собираем
// строку статблока сами — из v4 (system.activities) и из старой схемы
// (system.actionType/damage.parts).

function goblin(items) {
  return {
    name: "Гоблин",
    type: "npc",
    system: {
      abilities: { str: { value: 8 }, dex: { value: 14 } },
      details: { cr: 0.25 }, // бонус мастерства +2
    },
    items,
  };
}

test("v4: атака оружием ближнего боя собирается из system.activities", () => {
  const m = mapFoundryMonsterJson(
    goblin([
      {
        name: "Скимитар [Scimitar]",
        type: "weapon",
        system: {
          activation: { type: "action" },
          properties: ["fin", "lgt"], // фехтовальное — бьёт Ловкостью (мод +2)
          damage: { base: { number: 1, denomination: 6, bonus: "", types: ["slashing"] } },
          activities: {
            atk: {
              type: "attack",
              attack: { ability: "", bonus: "", type: { value: "melee", classification: "weapon" } },
              damage: { includeBase: true, parts: [] },
            },
          },
        },
      },
    ])
  );
  // +2 Лов + 2 мастерство = +4; урон 1к6 + 2 (мод Лов), среднее 5
  assert.match(m.actions, /Рукопашная атака оружием: \+4 к попаданию/);
  assert.match(m.actions, /досягаемость 5 фт\./);
  assert.match(m.actions, /Попадание: 5 \(1к6 \+ 2\), рубящий/);
});

test("v4: attack.flat — бонус попадания берётся как есть, без мастерства", () => {
  const m = mapFoundryMonsterJson(
    goblin([
      {
        name: "Укус [Bite]",
        type: "weapon",
        system: {
          activation: { type: "action" },
          damage: { base: { number: 1, denomination: 8, bonus: "1", types: ["piercing"] } },
          activities: {
            atk: {
              type: "attack",
              attack: { flat: true, bonus: "6", type: { value: "melee", classification: "weapon" } },
              damage: { includeBase: true, parts: [{ number: 2, denomination: 6, bonus: "", types: ["poison"] }] },
            },
          },
        },
      },
    ])
  );
  assert.match(m.actions, /\+6 к попаданию/);
  assert.match(m.actions, /Попадание: 5 \(1к8 \+ 1\), колющий; 7 \(2к6\), яд/);
});

test("старая схема: actionType + damage.parts с @mod", () => {
  const m = mapFoundryMonsterJson({
    name: "Орк",
    type: "npc",
    system: { abilities: { str: { value: 16 } }, details: { cr: 0.5 } }, // Сил +3, мастерство +2
    items: [
      {
        name: "Секира [Greataxe]",
        type: "weapon",
        system: {
          activation: { type: "action" },
          actionType: "mwak",
          ability: "str",
          attackBonus: "",
          damage: { parts: [["1d12 + @mod", "slashing"]] },
        },
      },
    ],
  });
  assert.match(m.actions, /Рукопашная атака оружием: \+5 к попаданию/);
  assert.match(m.actions, /Попадание: 9 \(1к12 \+ 3\), рубящий/);
});

test("оружие без машинных полей атаки — строка не синтезируется", () => {
  const m = mapFoundryMonsterJson(
    goblin([
      {
        name: "Палка [Stick]",
        type: "weapon",
        system: { activation: { type: "action" }, description: { value: "<p>Просто палка.</p>" } },
      },
    ])
  );
  assert.doesNotMatch(m.actions, /к попаданию/);
  assert.match(m.actions, /Просто палка/);
});

test("не-оружие (feat) строку атаки не получает", () => {
  const m = mapFoundryMonsterJson(
    goblin([
      {
        name: "Проворное бегство [Nimble Escape]",
        type: "feat",
        system: { activation: { type: "bonus" }, description: { value: "<p>Отступление или Засада.</p>" } },
      },
    ])
  );
  assert.doesNotMatch(m.bonusActions, /к попаданию/);
});
