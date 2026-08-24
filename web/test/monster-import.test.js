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
