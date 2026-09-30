// Схема существа D&D на всём вшитом бестиарии systemdata: каталог, медальон,
// подпись и числа дают то же, что давал прежний статблок.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { abilityMod, ABILITIES, crColor, fmtMod, monsterGlyphName } from "./legacy-taxonomy.js";
import { createEvaluator, compileSchema } from "../src/schema-formula.js";
import { catalogConfig, cardSubtitle, displayValue, medallionOf, pillsOf } from "../src/schema-list.js";
import { compactStats, coreSummary, initiativeText } from "../src/schema-summary.js";

const root = new URL("../../cmd/beacon-table/systemdata/", import.meta.url);
const schema = (system) => compileSchema(JSON.parse(readFileSync(new URL(`schemas/${system}/monster.json`, root), "utf8")));

function monsters() {
  const out = [];
  for (const system of readdirSync(new URL("bestiary/", root))) {
    for (const file of readdirSync(new URL(`bestiary/${system}/`, root))) {
      if (file.endsWith(".json")) out.push(JSON.parse(readFileSync(new URL(`bestiary/${system}/${file}`, root), "utf8")));
    }
  }
  return out;
}

const CR_ORDER = ["0", "1/8", "1/4", "1/2", ...Array.from({ length: 30 }, (_, i) => String(i + 1))];
const baseType = (t) => String(t || "").replace(/\s*\(.*$/, "").replace(/^./, (c) => c.toUpperCase());

test("схемы существа D&D разбираются без ошибок", () => {
  for (const system of ["dnd5e-2014", "dnd5e-2024"]) assert.deepEqual(schema(system).errors, [], system);
});

test("существа: группы, фильтры, плашки, медальон, подпись", () => {
  const compiled = schema("dnd5e-2024");
  const cfg = catalogConfig(compiled);
  const list = monsters();
  assert.equal(list.length, 331);
  assert.deepEqual(compiled.schema.fields.cr.options.map((o) => o.value), CR_ORDER);
  for (const m of list) {
    assert.equal(cfg.groupKey(m), CR_ORDER.indexOf(m.cr), m.name);
    assert.equal(cfg.groupLabel(cfg.groupKey(m)), "ПО " + m.cr, m.name);
    assert.deepEqual(cfg.sidebar.find((s) => s.id === "cr").of(m), [m.cr], m.name);
    assert.deepEqual(cfg.sidebar.find((s) => s.id === "type").of(m), m.type ? [baseType(m.type)] : [], m.name);
    assert.deepEqual(cfg.badge(m), ["ПО " + m.cr, (m.source || "").trim()].filter(Boolean), m.name);
    assert.deepEqual(pillsOf(compiled, m).map((p) => p.text), ["ПО " + m.cr], m.name);
    assert.deepEqual(medallionOf(compiled, m), { glyph: monsterGlyphName(m), color: crColor(m.cr) }, m.name);
    assert.equal(cardSubtitle(compiled, m), [`${m.size} ${m.type}`.trim(), m.alignment, "ПО " + m.cr].filter(Boolean).join(" · "), m.name);
  }
});

test("существа: КД, хиты и модификаторы как в прежнем статблоке", () => {
  const compiled = schema("dnd5e-2014");
  for (const m of monsters()) {
    assert.equal(displayValue(compiled, m, "ac_line"), m.acNote ? `${m.ac} (${m.acNote})` : String(m.ac), m.name);
    assert.equal(displayValue(compiled, m, "hp_line"), m.hitDice ? `${m.hp} (${m.hitDice})` : String(m.hp), m.name);
    const core = coreSummary(compiled, m, []);
    assert.deepEqual([core.ac, core.hpMax, core.speed], [String(m.ac), String(m.hp), m.speed || ""], m.name);
    const ev = createEvaluator(compiled, m, []);
    for (const a of ABILITIES) {
      assert.equal(ev.value(a.key + "_mod").value, abilityMod(m.abilities[a.key]), `${m.name}: ${a.key}`);
      assert.equal(ev.rollField(a.key + "_mod").formula, "1d20" + (abilityMod(m.abilities[a.key]) ? (abilityMod(m.abilities[a.key]) > 0 ? "+" : "") + abilityMod(m.abilities[a.key]) : ""), m.name);
    }
  }
});

test("существа: инициатива по правилу D&D — Ловкость существа", () => {
  const compiled = schema("dnd5e-2024");
  const rule = { roll: "1d20 + @dex_mod" };
  for (const m of monsters()) {
    const mod = abilityMod(m.abilities.dex);
    assert.equal(initiativeText(compiled, m, rule), "1d20" + (mod ? (mod > 0 ? "+" : "") + mod : ""), m.name);
  }
});

test("существа: плитки для доски и попапа — шесть характеристик с модификаторами", () => {
  const compiled = schema("dnd5e-2024");
  for (const m of monsters()) {
    assert.deepEqual(
      compactStats(compiled, m, []).map((t) => [t.label, t.value, t.note]),
      ABILITIES.map((a) => [a.label, String(m.abilities[a.key]), fmtMod(abilityMod(m.abilities[a.key])).replace("−", "-")]),
      m.name
    );
  }
});
