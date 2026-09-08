// bug-report.test.js — сборка отчёта о баге (см. web/src/bug-report.js):
// текст issue и длина ссылки на форму GitHub. Сам диалог не проверяем —
// jsdom в зависимостях нет, вся неочевидная логика в этих двух функциях.
import test from "node:test";
import assert from "node:assert/strict";

import { buildBody, issueURLFitting } from "../src/bug-report.js";

test("тело issue идёт по разделам шаблона, пустые поля — прочерком", () => {
  const body = buildBody({ what: " карта чёрная ", steps: "", expected: "", tech: "—", withTech: false });
  assert.equal(body, "**Что сломалось**\nкарта чёрная\n\n**Как повторить**\n—\n\n**Ожидалось**\n—");
});

test("технические данные прикладываются отдельным разделом и только по галочке", () => {
  const args = { what: "а", steps: "б", expected: "в", tech: "- Версия: v1" };
  assert.ok(buildBody({ ...args, withTech: true }).endsWith("**Окружение**\n- Версия: v1"));
  assert.ok(!buildBody({ ...args, withTech: false }).includes("Окружение"));
});

test("короткий отчёт уезжает в ссылку целиком", () => {
  const { url, trimmed } = issueURLFitting("Баг", "**Что сломалось**\nкарта чёрная");
  assert.equal(trimmed, false);
  assert.ok(url.startsWith("https://github.com/major1ink/Beacon-Table/issues/new?"));
  assert.ok(url.includes("labels=bug"));
});

// Кириллица в percent-encoding раздувается вшестеро — длина считается по
// закодированному адресу.
test("длинный отчёт режется, пока ссылка не влезет в потолок длины", () => {
  const { url, trimmed } = issueURLFitting("Баг", "Стена текста кириллицей. ".repeat(600));
  assert.equal(trimmed, true);
  assert.ok(url.length <= 8000, `длина ссылки ${url.length}`);
  // Пробелы в query — плюсами, поэтому ищем слово, а не фразу целиком.
  assert.ok(decodeURIComponent(url).includes("обрезан"));
});
