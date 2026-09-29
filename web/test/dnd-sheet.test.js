// Схемы листа D&D 2024 и 2014 (cmd/beacon-table/systemdata/schemas) считают
// то же, что считал прежний бланк: модификаторы, спасброски, навыки,
// пассивное восприятие, заклинательная статистика, грузоподъёмность.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ABILITY_TARGETS, applyModifiers } from "../src/modifiers.js";
import { compileSchema, createEvaluator } from "../src/schema-formula.js";

const load = (id) => JSON.parse(readFileSync(new URL(`../../cmd/beacon-table/systemdata/schemas/${id}/sheet.json`, import.meta.url), "utf8"));

const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"];
const SKILLS = {
  athletics: "str", acrobatics: "dex", sleightOfHand: "dex", stealth: "dex", investigation: "int", history: "int",
  arcana: "int", nature: "int", religion: "int", perception: "wis", survival: "wis", medicine: "wis",
  insight: "wis", animalHandling: "wis", performance: "cha", intimidation: "cha", deception: "cha", persuasion: "cha",
};

// Эталон — правила прежнего бланка D&D.
const mod = (score) => Math.floor(((score || 0) - 10) / 2);
const profBonus = (level) => 2 + Math.floor((Math.max(1, Math.min(20, level || 1)) - 1) / 4);
const score = (sheet, key, mods) => applyModifiers(sheet.abilities[key] || 0, ABILITY_TARGETS[key], mods);
const skill = (sheet, key, mods) => mod(score(sheet, SKILLS[key], mods)) + profBonus(sheet.info.level) * (sheet.skillProf[key] || 0);
const save = (sheet, key, mods) => mod(score(sheet, key, mods)) + (sheet.saveProf[key] ? profBonus(sheet.info.level) : 0);

function sheetOf(seed) {
  let n = seed;
  const next = (max) => {
    n = (n * 1103515245 + 12345) % 2147483648;
    return n % max;
  };
  const sheet = { info: { level: 1 + next(20) }, abilities: {}, saveProf: {}, skillProf: {}, spellcasting: { ability: ["", "int", "wis", "cha"][next(4)] } };
  for (const a of ABILITIES) {
    sheet.abilities[a] = 1 + next(30);
    sheet.saveProf[a] = next(2) === 1;
  }
  for (const s of Object.keys(SKILLS)) sheet.skillProf[s] = next(3);
  return sheet;
}

const MODS = [
  [],
  [{ target: "abilities.str", mode: "add", value: "2", period: "" }, { target: "abilities.wis", mode: "set", value: "19", period: "" }],
];

for (const id of ["dnd5e-2024", "dnd5e-2014"]) {
  test(`${id}: схема листа считает как прежний бланк`, () => {
    const compiled = compileSchema(load(id));
    assert.deepEqual(compiled.errors, []);
    for (let seed = 1; seed <= 40; seed++) {
      const sheet = sheetOf(seed);
      const mods = MODS[seed % MODS.length];
      const ev = createEvaluator(compiled, sheet, mods);
      const at = `лист ${seed}`;
      const value = (fid) => {
        const r = ev.value(fid);
        assert.equal(r.error, null, `${at}: ${fid} — ${r.error && r.error.message}`);
        return r.value;
      };
      assert.equal(value("prof"), profBonus(sheet.info.level), `${at}: бонус владения`);
      for (const a of ABILITIES) {
        assert.equal(value(a), score(sheet, a, mods), `${at}: ${a}`);
        assert.equal(value(a + "_mod"), mod(score(sheet, a, mods)), `${at}: мод. ${a}`);
      }
      const saves = ABILITIES.map((a, i) => ev.row("saves", i).value("bonus").value);
      assert.deepEqual(saves, ABILITIES.map((a) => save(sheet, a, mods)), `${at}: спасброски`);
      const skills = Object.keys(SKILLS).map((s, i) => ev.row("skills", i).value("bonus").value);
      assert.deepEqual(skills, Object.keys(SKILLS).map((s) => skill(sheet, s, mods)), `${at}: навыки`);
      assert.equal(value("passive"), 10 + skill(sheet, "perception", mods), `${at}: пассивное восприятие`);
      assert.equal(value("initiative"), mod(score(sheet, "dex", mods)), `${at}: инициатива`);
      assert.equal(value("carry"), score(sheet, "str", mods) * 15, `${at}: грузоподъёмность`);
      assert.equal(value("jump_high"), 3 + mod(score(sheet, "str", mods)), `${at}: прыжок в высоту`);
      assert.equal(value("jump_long"), score(sheet, "str", mods), `${at}: прыжок в длину`);
      const ability = sheet.spellcasting.ability;
      const spellMod = ability ? mod(score(sheet, ability, mods)) : 0;
      assert.equal(value("spell_mod"), spellMod, `${at}: модификатор заклинаний`);
      assert.equal(value("spell_dc"), 8 + profBonus(sheet.info.level) + spellMod, `${at}: СЛ`);
      assert.equal(value("spell_attack"), profBonus(sheet.info.level) + spellMod, `${at}: атака заклинанием`);
    }
  });

  test(`${id}: броски листа`, () => {
    const compiled = compileSchema(load(id));
    const sheet = sheetOf(7);
    sheet.abilities.dex = 16;
    sheet.info.level = 5;
    sheet.skillProf.stealth = 2;
    const ev = createEvaluator(compiled, sheet, []);
    assert.equal(ev.rollField("dex_mod").formula, "1d20+3");
    assert.equal(ev.rollField("initiative").formula, "1d20+3");
    const stealth = Object.keys(SKILLS).indexOf("stealth");
    assert.equal(ev.row("skills", stealth).dice("check").formula, "1d20+9");
    assert.equal(ev.row("saves", 1).dice("check").formula, "1d20+" + (3 + (sheet.saveProf.dex ? 3 : 0)));
  });
}

test("схемы 2024 и 2014 различаются подписями вида и расположением личных качеств", () => {
  const s24 = load("dnd5e-2024");
  const s14 = load("dnd5e-2014");
  assert.equal(s24.fields.species.path, "info.species");
  assert.equal(s14.fields.race.path, "info.race");
  assert.equal(s14.fields.species, undefined);
  assert.match(s14.list.subtitle, /\{race\}/);
});
