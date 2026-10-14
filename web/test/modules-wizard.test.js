import test from "node:test";
import assert from "node:assert/strict";

import { needsSystem } from "../src/modules-wizard.js";

test("контенту нужна система, пока она не установлена", () => {
  const sys = { id: "dnd5e-2024", done: false };
  const srd = { id: "dnd5e-2024-srd", requires: [{ id: "dnd5e-2024" }] };
  assert.equal(needsSystem(srd, [sys, srd]), true);
  assert.equal(needsSystem(srd, [{ ...sys, done: true }, srd]), false);
  assert.equal(needsSystem(srd, [srd]), false);
  assert.equal(needsSystem({ id: "x" }, [sys]), false);
});
