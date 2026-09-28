// Формулы схем (schema-formula.js). Основа — общие случаи, которые гоняет и
// сервер (internal/formula/testdata/cases.json, internal/schema/testdata/
// eval-cases.json): так две реализации языка не расходятся.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  FormulaError,
  MAX_LEN,
  applyInput,
  compileSchema,
  createEvaluator,
  diceRoll,
  evaluate,
  parse,
} from "../src/schema-formula.js";

const readJSON = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const shared = readJSON("../../internal/formula/testdata/cases.json");
const evalCases = readJSON("../../internal/schema/testdata/eval-cases.json").cases;

const varsResolver = (vars) => (name) => {
  if (vars && Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
  throw new FormulaError("not_number", 0, name);
};

function run(fn) {
  try {
    return { result: fn(), error: null };
  } catch (e) {
    if (!(e instanceof FormulaError)) throw e;
    return { result: null, error: e };
  }
}

function checkError(c, error) {
  assert.ok(error, `${c.src}: ждали ошибку ${c.error}`);
  assert.equal(error.code, c.error, `${c.src}: ${error.message}`);
  if (c.pos) assert.equal(error.pos, c.pos, `${c.src}: место ошибки`);
}

test("общие случаи: выражения", () => {
  for (const c of shared.expr) {
    const { result, error } = run(() => evaluate(parse(c.src), varsResolver(c.vars)));
    if (c.error) checkError(c, error);
    else assert.equal(result, c.value, `${c.src}${error ? ": " + error.message : ""}`);
  }
});

test("общие случаи: броски", () => {
  for (const c of shared.dice) {
    const { result, error } = run(() => diceRoll(parse(c.src, true), varsResolver(c.vars)));
    if (c.error) {
      checkError(c, error);
      continue;
    }
    assert.ok(!error, `${c.src}: ${error && error.message}`);
    assert.deepEqual(result, { formula: c.roll, dice: c.dice, const: c.const }, c.src);
  }
});

test("общие случаи: поля схемы", () => {
  for (const c of evalCases) {
    const compiled = c.schema ? compileSchema(c.schema) : null;
    const ev = createEvaluator(compiled, c.data, c.mods);
    for (const [id, want] of Object.entries(c.values || {})) {
      const r = ev.value(id);
      assert.equal(r.value, want, `${c.name}: ${id}${r.error ? " — " + r.error.message : ""}`);
    }
    for (const [id, want] of Object.entries(c.errors || {})) {
      const r = ev.value(id);
      assert.equal(r.error && r.error.code, want, `${c.name}: ${id} = ${r.value}`);
    }
    for (const r of c.rolls || []) {
      const got = ev.dice(r.src);
      if (r.error) assert.equal(got.error && got.error.code, r.error, `${c.name}: ${r.src}`);
      else assert.equal(got.formula, r.roll, `${c.name}: ${r.src}${got.error ? " — " + got.error.message : ""}`);
    }
    for (const rv of c.rowValues || []) {
      const row = ev.row(rv.table, rv.row);
      for (const [id, want] of Object.entries(rv.values || {})) {
        const r = row.value(id);
        assert.equal(r.value, want, `${c.name}: строка ${rv.row}, ${id}${r.error ? " — " + r.error.message : ""}`);
      }
      for (const [id, want] of Object.entries(rv.errors || {})) {
        assert.equal(row.value(id).error?.code, want, `${c.name}: строка ${rv.row}, ${id}`);
      }
      for (const r of rv.rolls || []) {
        assert.equal(row.dice(r.col).formula, r.roll, `${c.name}: строка ${rv.row}, бросок ${r.col}`);
      }
    }
    if (compiled) {
      const first = compiled.errors[0];
      assert.equal(first ? first.error.code : "", c.static || "", `${c.name}: проверка формул`);
    }
  }
});

test("формула длиннее предела", () => {
  assert.equal(run(() => parse("1+".repeat(MAX_LEN / 2) + "1")).error.code, "too_long");
  assert.equal(run(() => parse("1+".repeat(MAX_LEN / 2 - 1) + "1")).error, null);
});

test("ссылки формулы и тексты ошибок", () => {
  assert.deepEqual(parse("@a + @stat.сила * @a + @combat.hpMax").refs, ["a", "stat.сила", "combat.hpMax"]);
  assert.equal(run(() => parse("flor(2)")).error.message, "неизвестная функция «flor» (символ 1)");
  assert.equal(run(() => parse("1 +")).error.message, "формула оборвалась (символ 4)");
});

test("ввод в числовое поле как выражение", () => {
  assert.deepEqual(applyInput(20, "-5"), { value: 15, error: null });
  assert.deepEqual(applyInput(20, "+3"), { value: 23, error: null });
  assert.deepEqual(applyInput(20, "12"), { value: 12, error: null });
  assert.deepEqual(applyInput(20, "=12"), { value: 12, error: null });
  assert.deepEqual(applyInput(20, "=-4"), { value: -4, error: null });
  assert.deepEqual(applyInput(20, "12 - 3"), { value: 9, error: null });
  assert.deepEqual(applyInput(20, "-2 * 3"), { value: 14, error: null });
  assert.deepEqual(applyInput("7", "+1"), { value: 8, error: null });
  assert.equal(applyInput(20, "-").error.code, "syntax");
  assert.equal(applyInput(20, "").error.code, "syntax");
  assert.equal(applyInput(20, "@hp").error.code, "not_number");
  assert.deepEqual(applyInput(20, "-@dmg", (n) => (n === "dmg" ? 6 : 0)), { value: 14, error: null });
});

test("встроенные схемы «Своей системы» разбираются без ошибок", () => {
  for (const kind of ["sheet", "monster", "spell", "item", "reference"]) {
    const schema = readJSON(`../../internal/schema/builtin/${kind}.json`);
    assert.deepEqual(compileSchema(schema).errors, [], kind);
  }
});

test("лист: бросок из поля с формулой, которую вписал человек", () => {
  const schema = readJSON("../../internal/schema/builtin/sheet.json");
  const sheet = {
    initiative: "1к20 + @stat.ловкость",
    stats: [{ name: "Ловкость", value: 3 }],
    rolls: [{ name: "Меч", formula: "1d8 + @stat.ловкость" }],
  };
  const mods = [{ target: "stat.ловкость", mode: "add", value: "1" }];
  const ev = createEvaluator(compileSchema(schema), sheet, mods);
  assert.equal(ev.rollField("initiative").formula, "1d20+4");
  assert.equal(ev.row("rolls", 0).dice("formula").formula, "1d8+4");
  assert.equal(ev.rollField("stats").error.code, "not_number");
});

test("значения запоминаются, но цикл не зависит от порядка", () => {
  const schema = {
    fields: {
      a: { type: "computed", formula: "@b", label: "a" },
      b: { type: "computed", formula: "@a", label: "b" },
      c: { type: "computed", formula: "@b", label: "c" },
    },
  };
  for (const order of [["a", "b", "c"], ["c", "b", "a"], ["b", "c", "a"]]) {
    const ev = createEvaluator(compileSchema(schema), {}, []);
    const got = Object.fromEntries(order.map((id) => [id, ev.value(id).error?.code]));
    assert.deepEqual(got, { a: "cycle", b: "cycle", c: "ref_error" }, order.join());
  }
});

test("ссылка не достаёт свойства прототипа", () => {
  const ev = createEvaluator(null, {}, []);
  assert.equal(ev.dice("1d20 + @constructor").formula, "1d20");
  assert.equal(ev.dice("1d20 + @__proto__.x").formula, "1d20");
});
