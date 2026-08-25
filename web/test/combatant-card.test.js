// Права на карточку бойца из трекера инициативы (см. web/src/combatant-card.js):
// бестиарий — только ДМ (/api/bestiary отвечает игроку 403), чужой лист
// персонажа — только его владельцу. Проверяем именно выбор адреса, а не
// открытие окна: открытие — DOM/postMessage, здесь его нет.
import test from "node:test";
import assert from "node:assert/strict";

import { combatantCardTarget, combatantCardHint } from "../src/combatant-card.js";

const monster = { id: "c1", name: "Гоблин", monsterId: "mon-1" };
const pc = { id: "c2", name: "Кайра", characterId: "char-1", ownerId: "acc-1" };
const nameless = { id: "c3", name: "Бочка", tokenId: "tok-1" };

test("ДМ: монстр открывается статблоком бестиария", () => {
  assert.deepEqual(combatantCardTarget(monster, { isDM: true }), {
    key: "monster-mon-1",
    title: "Гоблин",
    url: "/bestiary.html?id=mon-1",
  });
});

test("ДМ: персонаж игрока открывается его листом", () => {
  assert.deepEqual(combatantCardTarget(pc, { isDM: true }), {
    key: "char-char-1",
    title: "Кайра",
    url: "/character-sheet.html?id=char-1",
  });
});

test("игроку статблок монстра не предлагается", () => {
  assert.equal(combatantCardTarget(monster, { playerId: "acc-1" }), null);
});

test("игрок открывает только СВОЕГО персонажа", () => {
  assert.ok(combatantCardTarget(pc, { playerId: "acc-1" }));
  assert.equal(combatantCardTarget(pc, { playerId: "acc-2" }), null);
});

test("TV (без роли и без playerId) не открывает ничего", () => {
  assert.equal(combatantCardTarget(pc, {}), null);
  assert.equal(combatantCardTarget(monster, {}), null);
});

test("боец без monsterId/characterId карточки не имеет ни у кого", () => {
  assert.equal(combatantCardTarget(nameless, { isDM: true }), null);
});

test("подсказка называет то, что откроется", () => {
  assert.equal(combatantCardHint(pc), "Открыть лист персонажа");
  assert.equal(combatantCardHint(monster), "Открыть статблок");
});
