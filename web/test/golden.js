// golden.js — эталонные снимки для страховочных тестов импорта (см.
// import-golden.test.js). Снимок — JSON-файл в test/golden/: тест сверяет
// результат маппера с ним глубоким сравнением (порядок ключей не важен).
//
// Эталон переписывается только осознанно:
//   UPDATE_GOLDEN=1 npm test
// и дифф test/golden/ смотрится глазами — любое изменение там означает, что
// импорт стал раскладывать данные иначе.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const goldenDir = path.join(testDir, "golden");

export function fixture(rel) {
  return JSON.parse(readFileSync(path.join(testDir, "fixtures", rel), "utf8"));
}

export function fixtureText(rel) {
  return readFileSync(path.join(testDir, "fixtures", rel), "utf8");
}

// plain — то, что реально уйдёт на сервер: JSON.stringify выбрасывает
// undefined и функции, Map/Set превращаются в {} — сравниваем именно это.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

export function matchGolden(name, value) {
  const file = path.join(goldenDir, name + ".json");
  const actual = plain(value);
  if (process.env.UPDATE_GOLDEN) {
    mkdirSync(goldenDir, { recursive: true });
    writeFileSync(file, JSON.stringify(actual, null, 1) + "\n");
    return;
  }
  assert.ok(existsSync(file), `нет эталона ${name}.json — запусти UPDATE_GOLDEN=1 npm test`);
  const expected = JSON.parse(readFileSync(file, "utf8"));
  assert.deepStrictEqual(actual, expected, `импорт разошёлся с эталоном test/golden/${name}.json`);
}

// safe — результат маппера или текст ошибки: то, что документ отклоняется,
// тоже часть поведения импорта.
export function safe(fn) {
  try {
    return fn();
  } catch (err) {
    return { error: err.message };
  }
}
