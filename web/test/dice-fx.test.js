// dice-fx.js: грани и кому показывать. Анимация требует DOM — не тут.
import test from "node:test";
import assert from "node:assert/strict";

import { dieFaces, shouldPlay } from "../src/dice-fx.js";

test("грани совпадают с тем, что пришло в лог, по членам формулы", () => {
  const faces = dieFaces("2d6+1d20+3", [4, 1, 20]);
  assert.deepEqual(
    faces.map((f) => [f.sides, f.text]),
    [
      [6, "4"],
      [6, "1"],
      [20, "20"],
    ],
  );
  assert.equal(faces[2].crit, true);
  assert.equal(dieFaces("1d20", [1])[0].fumble, true);
});

test("d100 — пара d10: десятки и единицы", () => {
  assert.deepEqual(
    dieFaces("1d100", [47]).map((f) => f.text),
    ["40", "7"],
  );
  assert.deepEqual(
    dieFaces("1d100", [100]).map((f) => f.text),
    ["00", "0"],
  );
  assert.deepEqual(
    dieFaces("1d100", [5]).map((f) => f.text),
    ["00", "5"],
  );
});

test("неразобранная формула — значения как есть, без граней", () => {
  assert.deepEqual(
    dieFaces("что-то", [3, 5]).map((f) => [f.sides, f.text]),
    [
      [0, "3"],
      [0, "5"],
    ],
  );
});

test("анимацию видят все, кому пришёл бросок; броски сервера — никто", () => {
  assert.equal(
    shouldPlay({ fromRole: "player", fromId: "acc-1", rolls: [7] }),
    true,
  );
  assert.equal(shouldPlay({ fromRole: "dm", rolls: [7] }), true);
  assert.equal(shouldPlay({ rolls: [7] }), false);
  assert.equal(
    shouldPlay({ fromRole: "dm", rolls: [] }),
    false,
    "модификатор без кости крутить нечего",
  );
});
