// Схемы карточек D&D (заклинание, предмет, справочник) на всём каталоге
// из репозитория модулей: каталог, медальон и категории дают то же, что давали
// прежние правила D&D.
import test from "node:test";
import assert from "node:assert/strict";

import { classifyItemType, classifyReferenceKind, itemGlyphName, kindInfo, kindKey, kindLabel, rarityColor, rarityKey, schoolInfo } from "./legacy-taxonomy.js";
import { compileSchema } from "../src/schema-formula.js";
import { cards, schemaJSON, skipNoModules } from "./modules-repo.js";
import { catalogConfig, categoriesOf, medallionOf, pillsOf } from "../src/schema-list.js";

const schema = (kind) => compileSchema(schemaJSON("dnd5e-2024", kind));

test("схемы карточек D&D разбираются без ошибок", skipNoModules, () => {
  for (const kind of ["spell", "item", "reference"]) assert.deepEqual(schema(kind).errors, [], kind);
});

test("заклинания: группы, фильтры, буквы, медальон", skipNoModules, () => {
  const compiled = schema("spell");
  const cfg = catalogConfig(compiled);
  const list = cards("spells");
  assert.ok(list.length > 300);
  const classes = (s) => String(s.classes || "").split(/[,;/]/).map((c) => c.trim()).filter(Boolean);
  for (const s of list) {
    const level = s.level || 0;
    assert.equal(cfg.groupKey(s), level, s.name);
    assert.equal(cfg.groupLabel(cfg.groupKey(s)), level ? level + "-й круг" : "Заговоры", s.name);
    assert.deepEqual(cfg.sidebar.find((x) => x.id === "classes").of(s), classes(s), s.name);
    assert.deepEqual(cfg.flags(s).map((f) => f[0]), [s.concentration && "К", s.ritual && "Р"].filter(Boolean), s.name);
    const school = schoolInfo(s.school);
    if (s.school) assert.ok(school, `неизвестная школа ${s.school}`);
    assert.deepEqual(medallionOf(compiled, s), { glyph: school ? school.glyph : "sparkle", color: school ? school.color : "" }, s.name);
    assert.deepEqual(pillsOf(compiled, s).map((p) => p.text), [s.concentration && "Концентрация", s.ritual && "Ритуал"].filter(Boolean), s.name);
  }
});

test("предметы: группы по редкости, категории меню, медальон", skipNoModules, () => {
  const compiled = schema("item");
  const cfg = catalogConfig(compiled);
  const cats = categoriesOf(compiled);
  const list = cards("items");
  assert.ok(list.length > 400);
  const optionIndex = (r) => compiled.schema.fields.rarity.options.findIndex((o) => o.value === r);
  for (const it of list) {
    if (it.rarity) assert.ok(optionIndex(it.rarity) >= 0, `неизвестная редкость ${it.rarity}`);
    assert.equal(cfg.groupKey(it), rarityKey(it.rarity) ? optionIndex(rarityKey(it.rarity)) : "", it.name);
    assert.equal(cats.find((c) => c.test(it)).label, classifyItemType(it.type), `${it.name}: ${it.type}`);
    assert.deepEqual(medallionOf(compiled, it), { glyph: itemGlyphName(it), color: rarityColor(it.rarity) }, it.name);
    assert.deepEqual(cfg.flags(it).map((f) => f[0]), it.requiresAttunement ? ["Н"] : [], it.name);
    assert.deepEqual(cfg.badge(it), [it.rarity || "", (it.source || "").trim()].filter(Boolean), it.name);
  }
});

test("справочник: группы, категории меню, медальон", skipNoModules, () => {
  const compiled = schema("reference");
  const cfg = catalogConfig(compiled);
  const cats = categoriesOf(compiled);
  const labels = { class: "Классы", species: "Виды", background: "Предыстории", trait: "Черты" };
  const list = cards("references");
  assert.ok(list.length > 200);
  for (const r of list) {
    const info = kindInfo(r.kind);
    if (r.kind) assert.ok(info, `неизвестный вид ${r.kind}`);
    assert.equal(cats.find((c) => c.test(r)).label, labels[classifyReferenceKind(r.kind)], r.name);
    assert.equal(cfg.groupLabel(cfg.groupKey(r)), kindLabel(r.kind), r.name);
    assert.deepEqual(medallionOf(compiled, r), { glyph: info ? info.glyph : "scroll", color: info ? info.color : "" }, r.name);
  }
  const order = compiled.schema.fields.kind.options.map((o) => o.value);
  assert.deepEqual(order, ["класс", "архетип", "вид", "черта вида", "происхождение", "черта", "черта класса"].map(kindKey));
});
