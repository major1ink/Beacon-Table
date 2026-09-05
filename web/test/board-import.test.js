// Разбор зависимостей доски при импорте из ваулта (см. web/src/board/import.js).
import test from "node:test";
import assert from "node:assert/strict";

import { imageNamesOf, indexFolder, lookupFile, noteFileFor, titleOf, noteContent } from "../src/board/import.js";

const file = "---\nexcalidraw-plugin: parsed\n---\n\n# Excalidraw Data\n\n" +
  "## Text Elements\nЗдесь ловушка ^t1\n\n" +
  "## Embedded Files\n" +
  "sha1aaa: [[Тронный зал.png]]\n\n" +
  "sha1bbb: [[Вложения/Схема.png]]\n\n" +
  "sha1ccc: [[Карта.png|подпись]]\n\n" +
  "%%\n## Drawing\n```json\n{}\n```\n%%\n";

test("imageNamesOf берёт имена файлов, отбрасывая путь и подпись", () => {
  assert.deepEqual(imageNamesOf(file), ["Тронный зал.png", "Схема.png", "Карта.png"]);
});

test("imageNamesOf не заходит за границы раздела", () => {
  // Строка блока рисунка не должна попасть в список, даже если похожа.
  assert.deepEqual(imageNamesOf("## Embedded Files\n%%\nsha1: [[Нет.png]]\n"), []);
  assert.deepEqual(imageNamesOf("рисунок без картинок"), []);
});

test("indexFolder ищет по имени и на одноимённых берёт первый", () => {
  const a = { name: "Схема.png", where: "Вложения" };
  const b = { name: "Схема.png", where: "Старое" };
  const index = indexFolder([a, b, { name: "Кладбище.md" }]);
  assert.equal(lookupFile(index, "Схема.png").where, "Вложения");
  assert.equal(noteFileFor(index, "Кладбище").name, "Кладбище.md");
  assert.equal(noteFileFor(index, "Таверна"), null);
});

test("поиск не зависит от регистра и нормализации юникода", () => {
  // Ваулт с macOS отдаёт имена в NFD: «й» там — «и» плюс знак краткости.
  const index = indexFolder([{ name: "Тронный зал.png".normalize("NFD") }]);
  assert.ok(lookupFile(index, "Тронный зал.png"), "NFC-имя не нашло NFD-файл");
  assert.ok(lookupFile(index, "тронный ЗАЛ.png"), "регистр помешал");
  assert.equal(lookupFile(index, "Другой зал.png"), null);
});

test("titleOf снимает расширение заметки", () => {
  assert.equal(titleOf("Кладбище Нортбриджа.md"), "Кладбище Нортбриджа");
  assert.equal(titleOf("Кладбище Нортбриджа.MD"), "Кладбище Нортбриджа");
});

test("noteContent ставит название заголовком", () => {
  // Заголовка нет — дописываем, иначе запись будет «Без названия», и ссылка
  // с доски её не найдёт.
  assert.equal(noteContent("Таверна", "Тут шумно."), "# Таверна\n\nТут шумно.");
  // Заголовок уже тот же — не удваиваем.
  assert.equal(noteContent("Таверна", "# Таверна\n\nТут шумно."), "# Таверна\n\nТут шумно.");
});

test("noteContent снимает шапку YAML и чинит чужой заголовок", () => {
  const withFrontMatter = "---\ntags: [dnd]\naliases:\n  - кабак\n---\n\n# Кабак\n\nТут шумно.";
  // Шапка Obsidian журналу ни к чему, а заголовок «Кабак» не совпадает с
  // именем файла — связь идёт по имени, поэтому название ставим своё.
  assert.equal(noteContent("Таверна", withFrontMatter), "# Таверна\n\n# Кабак\n\nТут шумно.");
  assert.equal(noteContent("Таверна", "---\ntags: [x]\n---\n# Таверна\n\nТут."), "# Таверна\n\nТут.");
});
