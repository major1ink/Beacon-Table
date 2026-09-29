// schema-formula.js — мини-язык формул схем листа и карточек (задача «Схемы
// листа и карточек»): числа, + - * /, скобки, сравнения, and/or/not,
// функции floor ceil round min max abs if и ссылки @поле. В бросках к ним
// добавляются кубы: «1d20 + @str_mod» сводится к строке, которую бросает
// сервер («1d20+3», см. internal/service/dice.go).
//
// Не JS и не eval: формула разбирается один раз в дерево и считается обходом
// дерева. Ошибка — объект FormulaError у поля, а не исключение наружу: лист
// из-за неё не падает.
//
// Зеркало на сервере — internal/formula (язык) и internal/schema/eval.go
// (поля схемы): сервер по тем же правилам считает инициативу из листа. Обе
// реализации гоняют одни и те же случаи (internal/formula/testdata/
// cases.json, internal/schema/testdata/eval-cases.json), поэтому язык
// меняется в обеих сразу, вместе с новыми случаями.
import { applyModifiers, hasModifiersFor, statKey, statTarget } from "./modifiers.js";

export const MAX_LEN = 2000;

// Пределы броска — те же, что у сервера.
const MAX_DEPTH = 64;
const MAX_DICE_COUNT = 100;
const MAX_DICE_SIDES = 1000;
const MAX_DICE_TERMS = 20;
const MAX_CONST = 99999;

// FormulaError — ошибка формулы: код (тот же, что в internal/formula),
// место (номер символа с 1; 0 — без места) и подробность.
export class FormulaError extends Error {
  constructor(code, pos = 0, detail = "") {
    super(errorText(code, detail) + (pos > 0 ? ` (символ ${pos})` : ""));
    this.code = code;
    this.pos = pos;
    this.detail = detail;
  }
}

function errorText(code, detail) {
  switch (code) {
    case "syntax":
    case "arity":
      return detail;
    case "too_long":
      return `формула длиннее ${MAX_LEN} символов`;
    case "too_deep":
      return "формула вложена слишком глубоко";
    case "unknown_func":
      return `неизвестная функция «${detail}»`;
    case "div_zero":
      return "деление на ноль";
    case "too_big":
      return "слишком большое число";
    case "dice_here":
      return "кубы можно только прибавлять и вычитать в броске";
    case "dice_count":
      return "число кубов не может быть отрицательным";
    case "dice_sides":
      return `у куба от 2 до ${MAX_DICE_SIDES} граней`;
    case "dice_limit":
      return `в броске больше ${MAX_DICE_COUNT} кубов или ${MAX_DICE_TERMS} слагаемых`;
    case "not_number":
      return `@${detail} — не число`;
    case "ref_error":
      return `ошибка в @${detail}`;
    case "cycle":
      return "цикл: " + detail;
    case "unknown_ref":
      return `неизвестная ссылка @${detail}`;
    default:
      return code;
  }
}

const syntaxErr = (pos, detail) => new FormulaError("syntax", pos, detail);

// ---------- разбор на слова ----------

const isDigit = (c) => c >= "0" && c <= "9";
const isLetter = (c) => /\p{L}/u.test(c);
const isRefChar = (c) => isLetter(c) || isDigit(c) || c === "_" || c === ".";

function lex(chars) {
  const out = [];
  const n = chars.length;
  let i = 0;
  while (i < n) {
    const c = chars[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
    } else if (isDigit(c)) {
      let j = i;
      while (j < n && isDigit(chars[j])) j++;
      if (j < n && chars[j] === ".") {
        if (j + 1 >= n || !isDigit(chars[j + 1])) throw syntaxErr(j + 1, "после точки нужна цифра");
        j++;
        while (j < n && isDigit(chars[j])) j++;
      }
      const text = chars.slice(i, j).join("");
      out.push({ kind: "num", text, num: Number(text), pos: i + 1 });
      i = j;
    } else if (c === "@") {
      let j = i + 1;
      while (j < n && isRefChar(chars[j])) j++;
      const name = chars.slice(i + 1, j).join("");
      if (!name) throw syntaxErr(i + 1, "после @ нужно имя поля");
      if (name.startsWith(".") || name.endsWith(".") || name.includes("..")) throw syntaxErr(i + 1, `неверная ссылка «@${name}»`);
      out.push({ kind: "ref", text: name, pos: i + 1 });
      i = j;
    } else if (isLetter(c) || c === "_") {
      let j = i;
      while (j < n && (isLetter(chars[j]) || chars[j] === "_")) j++;
      out.push({ kind: "ident", text: chars.slice(i, j).join(""), pos: i + 1 });
      i = j;
    } else if ("+-*/(),".includes(c)) {
      out.push({ kind: "op", text: c, pos: i + 1 });
      i++;
    } else if (c === "<" || c === ">" || c === "=" || c === "!") {
      if (i + 1 < n && chars[i + 1] === "=") {
        out.push({ kind: "op", text: c + "=", pos: i + 1 });
        i += 2;
        continue;
      }
      if (c === "=") throw syntaxErr(i + 1, "для сравнения пишите «==»");
      if (c === "!") throw syntaxErr(i + 1, "неожиданный символ «!»");
      out.push({ kind: "op", text: c, pos: i + 1 });
      i++;
    } else {
      throw syntaxErr(i + 1, `неожиданный символ «${c}»`);
    }
  }
  out.push({ kind: "eof", text: "", pos: n + 1 });
  return out;
}

// ---------- дерево ----------

// Число аргументов функции: точное, или -1 — «хотя бы один».
const ARITY = { floor: 1, ceil: 1, round: 1, abs: 1, min: -1, max: -1, if: 3 };
const CMP = new Set(["<", "<=", ">", ">=", "==", "!="]);

function parser(toks) {
  let i = 0;
  let depth = 0;
  const refs = [];
  const seen = new Set();

  const cur = () => toks[i];
  const next = () => {
    const t = toks[i];
    if (t.kind !== "eof") i++;
    return t;
  };
  const isOp = (text) => cur().kind === "op" && cur().text === text;
  const isWord = (word) => cur().kind === "ident" && cur().text.toLowerCase() === word;
  const isDice = () => isWord("d") || isWord("к");
  const enter = () => {
    depth++;
    if (depth > MAX_DEPTH) throw new FormulaError("too_deep", cur().pos);
  };
  const leave = () => {
    depth--;
  };

  function parseExpr() {
    enter();
    try {
      return parseOr();
    } finally {
      leave();
    }
  }

  function parseOr() {
    let l = parseAnd();
    while (isWord("or")) {
      const t = next();
      l = { op: "or", args: [l, parseAnd()], pos: t.pos };
    }
    return l;
  }

  function parseAnd() {
    let l = parseNot();
    while (isWord("and")) {
      const t = next();
      l = { op: "and", args: [l, parseNot()], pos: t.pos };
    }
    return l;
  }

  function parseNot() {
    if (isWord("not")) {
      enter();
      try {
        const t = next();
        return { op: "not", args: [parseNot()], pos: t.pos };
      } finally {
        leave();
      }
    }
    return parseCmp();
  }

  function parseCmp() {
    let l = parseAdd();
    while (cur().kind === "op" && CMP.has(cur().text)) {
      const t = next();
      l = { op: t.text, args: [l, parseAdd()], pos: t.pos };
    }
    return l;
  }

  function parseAdd() {
    let l = parseMul();
    while (isOp("+") || isOp("-")) {
      const t = next();
      l = { op: t.text, args: [l, parseMul()], pos: t.pos };
    }
    return l;
  }

  function parseMul() {
    let l = parseUnary();
    while (isOp("*") || isOp("/")) {
      const t = next();
      l = { op: t.text, args: [l, parseUnary()], pos: t.pos };
    }
    return l;
  }

  function parseUnary() {
    enter();
    try {
      if (isOp("-")) {
        const t = next();
        return { op: "neg", args: [parseUnary()], pos: t.pos };
      }
      if (isOp("+")) {
        next();
        return parseUnary();
      }
      return parseDice();
    } finally {
      leave();
    }
  }

  // «NdM», «(выражение)dM», «@полеd6» и «d20» (один куб).
  function parseDice() {
    if (isDice()) {
      const t = next();
      return { op: "dice", args: [{ op: "num", num: 1, pos: t.pos }, parseSides(t)], pos: t.pos };
    }
    let x = parsePrimary();
    if (isDice()) {
      const t = next();
      x = { op: "dice", args: [x, parseSides(t)], pos: t.pos };
    }
    return x;
  }

  function parseSides(d) {
    const t = cur();
    if (t.kind !== "num" && t.kind !== "ref" && !isOp("(")) throw syntaxErr(d.pos, `после «${d.text}» нужно число граней`);
    return parsePrimary();
  }

  function parsePrimary() {
    const t = cur();
    if (t.kind === "num") {
      next();
      return { op: "num", num: t.num, pos: t.pos };
    }
    if (t.kind === "ref") {
      next();
      if (!seen.has(t.text)) {
        seen.add(t.text);
        refs.push(t.text);
      }
      return { op: "ref", name: t.text, pos: t.pos };
    }
    if (t.kind === "ident") {
      next();
      const name = t.text.toLowerCase();
      if (!isOp("(")) throw syntaxErr(t.pos, `непонятное слово «${t.text}»`);
      if (!Object.prototype.hasOwnProperty.call(ARITY, name)) throw new FormulaError("unknown_func", t.pos, t.text);
      const want = ARITY[name];
      next();
      const args = [];
      if (!isOp(")")) {
        for (;;) {
          args.push(parseExpr());
          if (!isOp(",")) break;
          next();
        }
      }
      if (!isOp(")")) throw syntaxErr(cur().pos, "нет закрывающей «)»");
      next();
      if (want < 0 && args.length === 0) throw new FormulaError("arity", t.pos, `функции «${name}» нужен хотя бы один аргумент`);
      if (want === 1 && args.length !== 1) throw new FormulaError("arity", t.pos, `функции «${name}» нужен один аргумент`);
      if (want === 3 && args.length !== 3) throw new FormulaError("arity", t.pos, `функции «${name}» нужно три аргумента: условие, «да», «нет»`);
      return { op: "call", name, args, pos: t.pos };
    }
    if (t.kind === "op") {
      if (t.text === "(") {
        next();
        const x = parseExpr();
        if (!isOp(")")) throw syntaxErr(cur().pos, "нет закрывающей «)»");
        next();
        return x;
      }
      throw syntaxErr(t.pos, `неожиданное «${t.text}»`);
    }
    throw syntaxErr(t.pos, "формула оборвалась");
  }

  return { parseExpr, cur, refs };
}

// Кубы — только слагаемыми верхнего уровня броска: «2*1d6» или «max(1d6, 3)»
// сервер бросить не умеет.
function checkDice(n, top) {
  if (n.op === "dice") {
    if (!top) throw new FormulaError("dice_here", n.pos);
    checkDice(n.args[0], false);
    checkDice(n.args[1], false);
    return;
  }
  const keepTop = top && (n.op === "+" || n.op === "-" || n.op === "neg");
  for (const a of n.args || []) checkDice(a, keepTop);
}

// parse — разобранная формула { root, dice, refs } или исключение
// FormulaError. dice — формула броска: кубы разрешены слагаемыми верхнего
// уровня.
export function parse(src, dice = false) {
  const text = String(src ?? "");
  const chars = Array.from(text);
  if (chars.length > MAX_LEN) throw new FormulaError("too_long");
  if (!text.trim()) throw syntaxErr(0, "формула пустая");
  const p = parser(lex(chars));
  const root = p.parseExpr();
  const t = p.cur();
  if (t.kind !== "eof") throw syntaxErr(t.pos, `лишнее «${t.text}»`);
  checkDice(root, dice);
  return { root, dice, refs: p.refs };
}

// compile — то же без исключений: { expr } или { error }.
export function compile(src, dice = false) {
  try {
    return { expr: parse(src, dice), error: null };
  } catch (e) {
    if (e instanceof FormulaError) return { expr: null, error: e };
    throw e;
  }
}

// ---------- вычисление ----------

const bool01 = (b) => (b ? 1 : 0);

function evalNode(n, resolve) {
  switch (n.op) {
    case "num":
      return n.num;
    case "ref":
      return resolve(n.name);
    case "dice":
      throw new FormulaError("dice_here", n.pos);
    case "neg":
      return -evalNode(n.args[0], resolve);
    case "not":
      return bool01(evalNode(n.args[0], resolve) === 0);
    case "and":
      if (evalNode(n.args[0], resolve) === 0) return 0;
      return bool01(evalNode(n.args[1], resolve) !== 0);
    case "or":
      if (evalNode(n.args[0], resolve) !== 0) return 1;
      return bool01(evalNode(n.args[1], resolve) !== 0);
    case "call":
      return evalCall(n, resolve);
    default:
      break;
  }
  const a = evalNode(n.args[0], resolve);
  const b = evalNode(n.args[1], resolve);
  switch (n.op) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      if (b === 0) throw new FormulaError("div_zero", n.pos);
      return a / b;
    case "<":
      return bool01(a < b);
    case "<=":
      return bool01(a <= b);
    case ">":
      return bool01(a > b);
    case ">=":
      return bool01(a >= b);
    case "==":
      return bool01(a === b);
    case "!=":
      return bool01(a !== b);
    default:
      throw new Error("schema-formula: неизвестный узел " + n.op);
  }
}

function evalCall(n, resolve) {
  if (n.name === "if") {
    return evalNode(n.args[0], resolve) !== 0 ? evalNode(n.args[1], resolve) : evalNode(n.args[2], resolve);
  }
  const vals = n.args.map((a) => evalNode(a, resolve));
  switch (n.name) {
    case "floor":
      return Math.floor(vals[0]);
    case "ceil":
      return Math.ceil(vals[0]);
    case "round":
      // floor(x + 0.5), как на сервере: Math.round и Go math.Round по-разному
      // округляют отрицательные половинки.
      return Math.floor(vals[0] + 0.5);
    case "abs":
      return Math.abs(vals[0]);
    case "min":
      return vals.reduce((a, b) => (b < a ? b : a));
    case "max":
      return vals.reduce((a, b) => (b > a ? b : a));
    default:
      throw new Error("schema-formula: неизвестная функция " + n.name);
  }
}

// evaluate — число по разобранной формуле; resolve(name) — значение ссылки
// @name (бросает FormulaError). Ошибка — исключение FormulaError.
export function evaluate(expr, resolve) {
  const v = evalNode(expr.root, resolve);
  if (!Number.isFinite(v)) throw new FormulaError("too_big");
  return v;
}

function collectTerms(n, sign, out) {
  if (n.op === "+" || n.op === "-") {
    collectTerms(n.args[0], sign, out);
    collectTerms(n.args[1], n.op === "-" ? -sign : sign, out);
  } else if (n.op === "neg") {
    collectTerms(n.args[0], -sign, out);
  } else {
    out.push({ sign, n });
  }
}

// diceRoll — формула броска, сведённая к грамматике сервера:
// { formula: "1d20+3", dice: кубов (0 — бросать нечего, итог — const),
// const: сумма числовых частей, округлена вниз }. Число кубов и граней тоже
// может быть выражением — округляется вниз; 0 кубов — слагаемое пропадает.
// Ошибка — исключение FormulaError.
export function diceRoll(expr, resolve) {
  const terms = [];
  collectTerms(expr.root, 1, terms);
  const parts = [];
  let constSum = 0;
  let total = 0;
  for (const t of terms) {
    if (t.n.op !== "dice") {
      constSum += t.sign * evalNode(t.n, resolve);
      continue;
    }
    let c = evalNode(t.n.args[0], resolve);
    let s = evalNode(t.n.args[1], resolve);
    if (!Number.isFinite(c) || !Number.isFinite(s)) throw new FormulaError("too_big");
    c = Math.floor(c);
    s = Math.floor(s);
    if (c < 0) throw new FormulaError("dice_count", t.n.pos);
    if (c === 0) continue;
    if (s < 2 || s > MAX_DICE_SIDES) throw new FormulaError("dice_sides", t.n.pos);
    if (total + c > MAX_DICE_COUNT) throw new FormulaError("dice_limit");
    total += c;
    parts.push(`${t.sign < 0 ? "-" : "+"}${c}d${s}`);
  }
  if (!Number.isFinite(constSum)) throw new FormulaError("too_big");
  const k = Math.floor(constSum) || 0; // −0 → 0
  if (Math.abs(k) > MAX_CONST) throw new FormulaError("too_big");
  if (parts.length + (k !== 0 ? 1 : 0) > MAX_DICE_TERMS) throw new FormulaError("dice_limit");
  if (!parts.length) return { formula: String(k), dice: 0, const: k };
  let out = parts.join("");
  if (out.startsWith("+")) out = out.slice(1);
  if (k > 0) out += "+" + k;
  else if (k < 0) out += String(k);
  return { formula: out, dice: total, const: k };
}

// applyInput — ввод в числовое поле как выражение: «-5» и «+3» — изменение
// текущего значения, «=12» и «12» — новое значение, «12-3» — посчитать.
// { value } или { error } (FormulaError). resolve — ссылки @поле (без него
// любая ссылка — ошибка).
export function applyInput(current, text, resolve) {
  let src = String(text ?? "").trim();
  let relative = src.startsWith("+") || src.startsWith("-");
  if (src.startsWith("=")) {
    src = src.slice(1);
    relative = false;
  }
  const noRefs = (name) => {
    throw new FormulaError("not_number", 0, name);
  };
  try {
    const v = evaluate(parse(src), resolve || noRefs);
    return { value: relative ? (Number(current) || 0) + v : v, error: null };
  } catch (e) {
    if (e instanceof FormulaError) return { value: null, error: e };
    throw e;
  }
}

// ---------- поля схемы ----------

// Ссылка @name в формуле схемы — по порядку (как internal/schema/eval.go):
//   - колонка той же строки (у формулы колонки таблицы);
//   - id поля схемы — его значение с учётом модификаторов (modifierTarget),
//     у вычисляемого поля — результат его формулы;
//   - stat.<ключ> — свободная характеристика из таблицы со statRows, с
//     модификаторами stat.<ключ>; нет такой строки — 0;
//   - иначе путь в JSON листа или карточки — значение как есть; нет — 0.

const ROLL_SUB = "roll";
const optionSub = (value) => "opt:" + value;
export const formulaKey = (id, sub) => (sub ? id + "#" + sub : id);

// formulasOf — формулы поля (как internal/schema: formulasOf): sub — какая
// ("" — основная, "roll" — бросок по клику, "opt:<значение>" — вариант
// select), value — даёт значение поля и потому участвует в циклах.
function formulasOf(f) {
  if (!f) return [];
  if (f.type === "roll") return [{ sub: "", src: f.roll, dice: true, value: false }];
  const out = [];
  if (f.type === "computed") out.push({ sub: "", src: f.formula, dice: false, value: true });
  if (f.type === "select") for (const o of f.options || []) if (o.formula) out.push({ sub: optionSub(o.value), src: o.formula, dice: false, value: true });
  if (f.roll && (f.type === "number" || f.type === "computed")) out.push({ sub: ROLL_SUB, src: f.roll, dice: true, value: false });
  return out;
}

const hasValueFormula = (f) => formulasOf(f).some((ff) => ff.value);

// fieldFormula — основная формула поля или колонки.
const fieldFormula = (f) => formulasOf(f).find((ff) => ff.sub === "") || null;

const own = (obj, key) => obj != null && Object.prototype.hasOwnProperty.call(obj, key);

// findCycle — первый цикл графа «поле → поля, на которые оно ссылается».
function findCycle(graph) {
  const state = new Map();
  const stack = [];
  const visit = (id) => {
    const st = state.get(id);
    if (st === "busy") return new FormulaError("cycle", 0, cycleChain(stack, id));
    if (st === "done") return null;
    state.set(id, "busy");
    stack.push(id);
    for (const next of graph.get(id) || []) {
      const err = visit(next);
      if (err) return err;
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };
  for (const id of [...graph.keys()].sort()) {
    const err = visit(id);
    if (err) return err;
  }
  return null;
}

function cycleChain(stack, id) {
  let i = stack.length - 1;
  while (i > 0 && stack[i] !== id) i--;
  return [...stack.slice(i), id].join(" → ");
}

// KEY — ключ строки в пути колонки таблицы со строками.
export const KEY = "{key}";

// compileSchema — формулы схемы разбираются один раз: { schema, formulas,
// columns, rows, errors }. errors — [{ field, column?, row?, error }] в том же порядке, в каком
// сервер нашёл бы первую (ссылки на пути клиент не проверяет — схему уже
// проверил сервер).
export function compileSchema(schema) {
  const fields = (schema && schema.fields) || {};
  const formulas = new Map();
  const columns = new Map();
  const rows = new Map();
  const errors = [];
  const graph = new Map();
  for (const id of Object.keys(fields).sort()) {
    const f = fields[id];
    const edges = [];
    for (const ff of formulasOf(f)) {
      const c = compile(ff.src, ff.dice);
      formulas.set(formulaKey(id, ff.sub), c);
      if (c.error) errors.push({ field: id, error: c.error });
      else if (ff.value) edges.push(...c.expr.refs.filter((r) => fields[r] && hasValueFormula(fields[r])));
    }
    if (hasValueFormula(f)) graph.set(id, edges);
    if (!f || f.type !== "table") continue;
    const cols = new Map();
    const byId = {};
    for (const col of f.columns || []) byId[col.id] = col;
    const colGraph = new Map();
    for (const col of f.columns || []) {
      const cf = fieldFormula(col);
      if (!cf) continue;
      const c = compile(cf.src, cf.dice);
      cols.set(col.id, c);
      if (c.error) errors.push({ field: id, column: col.id, error: c.error });
      else if (col.type === "computed") colGraph.set(col.id, c.expr.refs.filter((r) => byId[r] && byId[r].type === "computed"));
    }
    columns.set(id, cols);
    const cycle = findCycle(colGraph);
    if (cycle) errors.push({ field: id, error: cycle });
    rows.set(id, compileRows(id, f, cols, byId, errors));
  }
  const cycle = findCycle(graph);
  if (cycle) errors.push({ field: null, error: cycle });
  return { schema, formulas, columns, rows, errors };
}

// compileRows — формулы строк таблицы: ключ строки → колонка → формула.
function compileRows(id, table, cols, byId, errors) {
  const out = new Map();
  for (const row of table.rows || []) {
    const overrides = new Map();
    for (const [colId, src] of Object.entries(row.formulas || {})) {
      const c = compile(src, false);
      overrides.set(colId, c);
      if (c.error) errors.push({ field: id, column: colId, row: row.key, error: c.error });
    }
    out.set(row.key, overrides);
    const graph = new Map();
    for (const col of table.columns || []) {
      const c = overrides.get(col.id) || cols.get(col.id);
      if (c && !c.error && col.type === "computed") graph.set(col.id, c.expr.refs.filter((r) => byId[r] && byId[r].type === "computed"));
    }
    const cycle = findCycle(graph);
    if (cycle) errors.push({ field: id, row: row.key, error: cycle });
  }
  return out;
}

// lookupPath — значение по пути «a.b.0»; undefined — его нет.
export function lookupPath(data, path) {
  let cur = data;
  for (const part of String(path).split(".")) {
    if (Array.isArray(cur)) {
      if (!/^[+-]?\d+$/.test(part)) return undefined;
      cur = cur[parseInt(part, 10)];
    } else if (cur !== null && typeof cur === "object") {
      cur = own(cur, part) ? cur[part] : undefined;
    } else {
      return undefined;
    }
  }
  return cur;
}

const NUMBER_RE = /^[+-]?\d+(\.\d+)?$/;

// toNumber — значение как число: пусто — 0, флажок — 1/0, строка — если
// это число; null — не число.
export function toNumber(v) {
  if (v === undefined || v === null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return 0;
    return NUMBER_RE.test(s) ? Number(s) : null;
  }
  return null;
}

// createEvaluator — расчёт по листу или карточке data с модификаторами
// mods (надетые предметы и состояния, см. modifiers.js: collectModifiers).
// compiled — compileSchema(схема) или null (система со старым бланком:
// ссылки — только пути). Значения запоминаются: один расчёт — на одно
// состояние листа.
//
//   value(id)        → { value, error } — значение поля;
//   dice(src)        → { formula, dice, const, error } — бросок по формуле;
//   rollField(id)    → то же для поля-броска (roll) или поля с формулой
//                      кубов, которую вписал человек (dice);
//   row(table, i)    → { value(col), dice(col) } — строка таблицы;
//   stat(name)       → свободная характеристика с таким названием (с
//                      модификаторами), как @stat.<ключ>.
export function createEvaluator(compiled, data, mods) {
  const c = compiled || { schema: null, formulas: new Map(), columns: new Map() };
  const fields = (c.schema && c.schema.fields) || {};
  const list = mods || [];

  const modify = (v, target) => (target && hasModifiersFor(target, list) ? applyModifiers(Math.floor(v), target, list) : v);

  // scope — «область» расчёта: поля листа или колонки одной строки.
  // pathOf — путь значения поля (с подставленным ключом строки).
  function makeScope(defs, source, formulaOf, parent, pathOf = (f) => f.path) {
    const memo = new Map();
    const busy = [];
    const inCycle = new Set();

    function value(id) {
      if (memo.has(id)) return memo.get(id);
      const f = defs[id];
      if (!f) throw new FormulaError("unknown_ref", 0, id);
      if (busy.includes(id)) {
        let i = busy.length - 1;
        while (i > 0 && busy[i] !== id) i--;
        for (const m of busy.slice(i)) inCycle.add(m);
        throw new FormulaError("cycle", 0, cycleChain(busy, id));
      }
      busy.push(id);
      let res;
      try {
        res = { value: compute(id, f), error: null };
      } catch (e) {
        if (!(e instanceof FormulaError)) throw e;
        res = { value: null, error: e };
      } finally {
        busy.pop();
      }
      memo.set(id, res);
      return res;
    }

    function compute(id, f) {
      let v;
      if (f.type === "computed") {
        const cf = formulaOf(id);
        if (!cf || cf.error) throw cf ? cf.error : new FormulaError("syntax", 0, "нет формулы");
        v = evaluate(cf.expr, resolver(id));
      } else if (f.type === "select" && hasValueFormula(f)) {
        return optionValue(id, f);
      } else if (f.type === "select") {
        throw new FormulaError("not_number", 0, id);
      } else if (f.type === "roll" || f.type === "table" || f.type === "resource") {
        throw new FormulaError("not_number", 0, id);
      } else {
        v = toNumber(lookupPath(source, pathOf(f)));
        if (v === null) throw new FormulaError("not_number", 0, id);
      }
      return modify(v, f.modifierTarget);
    }

    // optionValue — формула выбранного варианта select; пустой выбор — 0.
    function optionValue(id, f) {
      const chosen = lookupPath(source, pathOf(f));
      if (typeof chosen !== "string" || chosen === "") return 0;
      const cf = formulaOf(formulaKey(id, optionSub(chosen)));
      if (!cf) throw new FormulaError("not_number", 0, id);
      if (cf.error) throw cf.error;
      return evaluate(cf.expr, resolver(id));
    }

    // Ошибка вычисляемого поля, на которое ссылаются, становится «ошибкой
    // в @поле»; только у участников цикла она остаётся циклом.
    function resolver(self) {
      return (name) => {
        if (own(defs, name)) {
          const r = value(name);
          if (!r.error) return r.value;
          if (!hasValueFormula(defs[name])) throw r.error;
          if (r.error.code === "cycle" && self && inCycle.has(self)) throw r.error;
          throw new FormulaError("ref_error", 0, name);
        }
        return parent(name);
      };
    }

    return { value, resolver };
  }

  function stat(key) {
    for (const id of Object.keys(fields).sort()) {
      const f = fields[id];
      if (!f || f.type !== "table" || !f.statRows) continue;
      const cols = f.columns || [];
      const nameCol = cols.find((col) => col.id === f.statRows.name);
      const valueCol = cols.find((col) => col.id === f.statRows.value);
      const rows = lookupPath(data, f.path);
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        const name = lookupPath(row, nameCol ? nameCol.path : "");
        if (typeof name !== "string" || statKey(name) !== key) continue;
        const v = toNumber(lookupPath(row, valueCol ? valueCol.path : ""));
        return modify(v === null ? 0 : v, statTarget(name));
      }
    }
    return 0;
  }

  // Последний шаг любой ссылки: характеристика или путь в JSON листа.
  function fallback(name) {
    if (name.startsWith("stat.")) return stat(name.slice(5));
    const v = toNumber(lookupPath(data, name));
    if (v === null) throw new FormulaError("not_number", 0, name);
    return v;
  }

  const sheet = makeScope(fields, data, (id) => c.formulas.get(id), fallback);
  const sheetResolve = sheet.resolver("");

  function roll(src, resolve) {
    try {
      return Object.assign(diceRoll(parse(src, true), resolve), { error: null });
    } catch (e) {
      if (!(e instanceof FormulaError)) throw e;
      return { formula: null, dice: 0, const: 0, error: e };
    }
  }

  function rollOf(defs, source, formulaOf, resolve, id, pathOf = (f) => f.path) {
    const f = defs[id];
    const clickRoll = f && f.roll && (f.type === "number" || f.type === "computed");
    if (f && (f.type === "roll" || clickRoll)) {
      const cf = formulaOf(clickRoll ? formulaKey(id, ROLL_SUB) : id);
      if (!cf || cf.error) return { formula: null, dice: 0, const: 0, error: cf ? cf.error : new FormulaError("syntax", 0, "нет формулы") };
      try {
        return Object.assign(diceRoll(cf.expr, resolve), { error: null });
      } catch (e) {
        if (!(e instanceof FormulaError)) throw e;
        return { formula: null, dice: 0, const: 0, error: e };
      }
    }
    if (f && f.type === "dice") return roll(String(lookupPath(source, pathOf(f)) ?? ""), resolve);
    return { formula: null, dice: 0, const: 0, error: new FormulaError("not_number", 0, id) };
  }

  const rows = new Map();

  return {
    value: (id) => {
      try {
        return sheet.value(id);
      } catch (e) {
        if (!(e instanceof FormulaError)) throw e;
        return { value: null, error: e };
      }
    },
    dice: (src) => roll(src, sheetResolve),
    stat: (name) => stat(statKey(name)),
    rollField: (id) => rollOf(fields, data, (fid) => c.formulas.get(fid), sheetResolve, id),
    row(tableId, index) {
      const key = tableId + "\u0000" + index;
      if (rows.has(key)) return rows.get(key);
      const table = fields[tableId];
      const defs = {};
      for (const col of (table && table.columns) || []) defs[col.id] = col;
      const rowsData = table ? lookupPath(data, table.path) : undefined;
      const keyed = table && table.rows ? table.rows[index] : null;
      const rowData = keyed ? rowsData : Array.isArray(rowsData) ? rowsData[index] : undefined;
      const pathOf = keyed ? (f) => String(f.path).replaceAll(KEY, keyed.key) : undefined;
      const colFormulas = c.columns.get(tableId) || new Map();
      const overrides = keyed && c.rows ? (c.rows.get(tableId) || new Map()).get(keyed.key) : null;
      const formulaOf = (cid) => (overrides && overrides.get(cid)) || colFormulas.get(cid);
      const scope = makeScope(defs, rowData, formulaOf, sheetResolve, pathOf);
      const rowResolve = scope.resolver("");
      const api = {
        value: (id) => {
          try {
            return scope.value(id);
          } catch (e) {
            if (!(e instanceof FormulaError)) throw e;
            return { value: null, error: e };
          }
        },
        dice: (id) => rollOf(defs, rowData, formulaOf, rowResolve, id, pathOf),
      };
      rows.set(key, api);
      return api;
    },
  };
}
