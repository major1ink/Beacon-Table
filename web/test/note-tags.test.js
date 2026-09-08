// Метки #нпс в тексте записи (см. web/src/notes/markdown.js: tagsIn).
// Решётка в markdown значит ещё и заголовок, и якорь ссылки, и цвет в коде —
// проверяем именно границу «что метка, а что нет».
import test from "node:test";
import assert from "node:assert/strict";

import { tagsIn, wikiTargetsIn } from "../src/notes/markdown.js";

test("метка — решётка со словом сразу после неё", () => {
  assert.deepEqual(tagsIn("Хозяйка таверны #нпс, живёт тут же"), ["нпс"]);
  assert.deepEqual(tagsIn("#нпс/таверна — вложенная метка"), ["нпс/таверна"]);
  assert.deepEqual(tagsIn("#Нпс и #нпс — одна метка"), ["нпс"]);
});

test("заголовок, якорь и код метками не считаются", () => {
  assert.deepEqual(tagsIn("# Заголовок\n\n## Раздел"), []);
  assert.deepEqual(tagsIn("Ссылка https://example.com/page#anchor"), []);
  assert.deepEqual(tagsIn("Код `#define X` и блок\n```\n#include <stdio.h>\n```"), []);
});

test("wikiTargetsIn отдаёт цели ссылок как написаны", () => {
  assert.deepEqual(wikiTargetsIn("см. [[Таверна]] и [[Глава 1/Марго|хозяйку]]"), ["Таверна", "Глава 1/Марго"]);
  assert.deepEqual(wikiTargetsIn("бросок [[/r 2d6]] — не ссылка"), []);
});
