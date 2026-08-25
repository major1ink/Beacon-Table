// token-hit-test.test.js — регрессия на "токен залип и не двигается".
//
// История: игрок наводил свой токен на клетку, где уже стоял монстр, токен
// света или ассет карты, — и после этого сдвинуть его с места было
// невозможно, пока ДМ не убирал то, на что он наступил. Причина была не в
// стенах и не в лимите скорости, а ровно в одной строке хит-теста:
// geometry.tokenAt возвращала ПЕРВЫЙ токен в порядке обхода объекта, то
// есть самый нижний в стопке (layers/tokens.js добавляет вьюхи в том же
// порядке). Клик по своему токену попадал в чужой объект под ним, драг не
// начинался вовсе (см. interaction.js — игрок тащит только свои токены), и
// со стороны это выглядело как зависание.
//
// Тест держит обе половины лечения: приоритет "своего" над "чужим" в
// стопке (opts.prefer/opts.filter) и порядок "кто нарисован выше" вместо
// "кто первый попался".
import test from "node:test";
import assert from "node:assert/strict";
import { tokenAt, noteMarkerAt } from "../src/geometry.js";

// Все три объекта стоят РОВНО в одной точке — это и есть спорный случай:
// игрок довёл своего персонажа на клетку с монстром и фонарём.
const stacked = {
  monster: { id: "monster", x: 100, y: 100, size: 24 },
  lamp: { id: "lamp", x: 100, y: 100, size: 12, lightOnly: true },
  mine: { id: "mine", x: 100, y: 100, size: 24, ownerId: "player-1" },
};

test("свой токен достаётся из-под монстра и токена света", () => {
  const hit = tokenAt(100, 100, stacked, { filter: (t) => t.ownerId === "player-1" });
  assert.equal(hit, "mine");
});

test("без фильтра выигрывает верхний по отрисовке, а не первый в объекте", () => {
  // "mine" добавлен последним, значит нарисован поверх остальных — по нему
  // клик и должен попадать, когда все трое равноправны.
  assert.equal(tokenAt(100, 100, stacked), "mine");
});

test("prefer перебивает порядок отрисовки", () => {
  // Режим настройки освещения: фонарь лежит под монстром, но достать мышью
  // надо именно его (см. interaction.js: dmTokenAt).
  const hit = tokenAt(100, 100, stacked, { prefer: (t) => !!t.lightOnly });
  assert.equal(hit, "lamp");
});

test("filter прячет токены света вне режима освещения", () => {
  const onlyLamp = { lamp: stacked.lamp };
  assert.equal(tokenAt(100, 100, onlyLamp, { filter: (t) => !t.lightOnly }), null);
});

test("запертый токен не попадает под мышь, но остаётся в сцене", () => {
  const scene = { locked: { id: "locked", x: 100, y: 100, size: 24, locked: true } };
  assert.equal(tokenAt(100, 100, scene, { filter: (t) => !t.locked }), null);
  assert.equal(tokenAt(100, 100, scene), "locked");
});

test("промах мимо всех радиусов по-прежнему даёт null", () => {
  assert.equal(tokenAt(400, 400, stacked), null);
});

test("труп с добычей находится из-под стоящего на нём токена", () => {
  const scene = {
    corpse: { id: "corpse", x: 50, y: 50, size: 24, dead: true, loot: [{ id: "e1" }] },
    looter: { id: "looter", x: 50, y: 50, size: 24, ownerId: "player-1" },
  };
  const hit = tokenAt(50, 50, scene, { filter: (t) => t.dead && Array.isArray(t.loot) && t.loot.length > 0 });
  assert.equal(hit, "corpse");
});

test("значок заметки: верхний выигрывает, запертый пропускается", () => {
  const markers = {
    under: { id: "under", x: 10, y: 10, size: 32 },
    over: { id: "over", x: 10, y: 10, size: 32 },
  };
  assert.equal(noteMarkerAt(10, 10, markers), "over");
  assert.equal(noteMarkerAt(10, 10, { one: { id: "one", x: 10, y: 10, size: 32, locked: true } }, 16, (m) => !m.locked), null);
});
