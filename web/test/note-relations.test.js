// Блок ```связи (src/notes/relations.js): разбор, панель в просмотре и то,
// что редактор не портит блок при сохранении.
import test from "node:test";
import assert from "node:assert/strict";
import { MarkdownManager } from "@tiptap/markdown";

import { parseRelations, extractRelationBlocks, restoreRelationBlocks, relationLabel } from "../src/notes/relations.js";
import { noteExtensions } from "../src/notes/editor.js";

const block = "# Орден\n\n```связи\nподчинённый: [[Марго Вейл]], [[NPC/Брат Ансельм|брат]]\nВраг: [[Звонарь Тобиас]]\n```\n\nТекст.";

test("связи разбираются из блока кода", () => {
  assert.deepEqual(parseRelations(block), [
    { type: "подчинённый", target: "Марго Вейл" },
    { type: "подчинённый", target: "NPC/Брат Ансельм" },
    { type: "враг", target: "Звонарь Тобиас" },
  ]);
  assert.deepEqual(parseRelations("```связи\nсвязи:\n  союзник: [[А]]\n```"), [{ type: "союзник", target: "А" }]);
});

test("блок становится панелью со ссылками", () => {
  const { text, panels } = extractRelationBlocks(block);
  assert.ok(!text.includes("```"));
  const token = /BEACONRELATIONS\d+/.exec(text)[0];
  const html = restoreRelationBlocks(`<h1>Орден</h1><p>${token}</p>`, panels);
  assert.match(html, /class="note-relations"/);
  assert.match(html, /href="wikilink:NPC%2F%D0%91/);
  assert.match(html, />Брат Ансельм</);
});

test("редактор сохраняет блок как есть", () => {
  const manager = new MarkdownManager({ extensions: noteExtensions(), markedOptions: { breaks: true, gfm: true } });
  assert.equal(manager.serialize(manager.parse(block)), block);
});

test("обратная подпись", () => {
  assert.equal(relationLabel("подчинённый", false), "подчиняется");
  assert.equal(relationLabel("враг", false), "враг");
  assert.equal(relationLabel("", false), "упомянута в");
});
