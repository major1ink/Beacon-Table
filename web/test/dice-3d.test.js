// dice-3d.js: нотация с заданными значениями для dice-box-threejs.
import test from "node:test";
import assert from "node:assert/strict";

import { notation3d } from "../src/dice-3d.js";

test("одинаковые типы сливаются, значения — в том же порядке", () => {
  assert.equal(notation3d("1d6+1d20+1d6+3", [4, 17, 2]), "2d6+1d20@4,2,17");
});

test("d100 — кубы десятков и единиц, нули как 100 и 10", () => {
  assert.equal(notation3d("1d100", [47]), "1d100+1d10@40,7");
  assert.equal(notation3d("1d100", [100]), "1d100+1d10@100,10");
  assert.equal(notation3d("1d100", [5]), "1d100+1d10@100,5");
  assert.equal(notation3d("1d100", [30]), "1d100+1d10@30,10");
});

test("чужие кубы и перебор — не 3D", () => {
  assert.equal(notation3d("1d7", [3]), null);
  assert.equal(notation3d("21d6", Array(21).fill(1)), null);
  assert.equal(notation3d("что-то", [3]), null);
});
