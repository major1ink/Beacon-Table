// import-corpus.mjs — клиентская половина прогона импорта по НАСТОЯЩИМ
// модулям Foundry и экспортам LSS (страховка на время выноса D&D в модули,
// задача «Импорты при переходе на модули»). Чужие данные в репозиторий не
// кладутся, поэтому это отдельный скрипт, а не часть npm test.
//
// Порядок:
//   1. go test -tags corpus ./internal/foundry -run Corpus с BEACON_FOUNDRY_CORPUS=<модуль>
//      и BEACON_FOUNDRY_CORPUS_OUT=<папка> — кладёт в папку *.client.json
//      (документы по разделам, как их получает страница импорта);
//   2. node scripts/import-corpus.mjs <папка> [--lss <папка с .json LSS>] [--update]
//
// С --update записывает эталон в <папка>/golden/, без него сверяет и
// печатает расхождения. Код выхода 1 — есть расхождения.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { mapFoundryMonsterJson } from "../src/monster-import.js";
import { mapFoundryCharacterJson } from "../src/character-import.js";
import { mapFoundrySpellJson, mapFoundrySpellStatuses } from "../src/spell-import.js";
import { mapFoundryItemJson } from "../src/item-import.js";
import { mapFoundryReferenceBatch } from "../src/reference-import.js";
import { mapFoundryConditionBatch } from "../src/condition-import.js";
import { parseLssExport, applyLssImport } from "../src/lss-import.js";
import { normalizeSheet } from "../src/sheet-normalize.js";
import { tokenArt, itemArt, pregenArt, mapPackDocs } from "../src/foundry-import-cards.js";

const args = process.argv.slice(2);
const update = args.includes("--update");
const lssAt = args.indexOf("--lss");
const lssDir = lssAt >= 0 ? args[lssAt + 1] : "";
const dir = args.find((a, i) => !a.startsWith("--") && i !== lssAt + 1);
if (!dir) {
  console.error("использование: node scripts/import-corpus.mjs <папка> [--lss <папка>] [--update]");
  process.exit(2);
}

// Те же разделы и мапперы, что на странице импорта (pages/foundry-import.js: TARGETS).
const TARGETS = {
  pregens: { mapOne: mapFoundryCharacterJson, art: pregenArt },
  monsters: { mapOne: mapFoundryMonsterJson, art: tokenArt, linkField: "foundryActorId" },
  spells: { mapOne: mapFoundrySpellJson },
  items: { mapOne: mapFoundryItemJson, art: itemArt },
  references: { mapBatch: mapFoundryReferenceBatch },
  conditions: { mapBatch: mapFoundryConditionBatch },
};

const plain = (v) => JSON.parse(JSON.stringify(v));
const results = {};

for (const file of readdirSync(dir).filter((f) => f.endsWith(".client.json")).sort()) {
  const byTarget = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
  const out = {};
  for (const [target, docs] of Object.entries(byTarget)) {
    const spec = TARGETS[target];
    if (!spec) continue;
    const errors = [];
    const { mapped, sourceIds } = mapPackDocs(spec, docs, (doc, err) => errors.push(`${doc && doc.name}: ${err.message}`));
    out[target] = {
      cards: mapped.map((c) => (c && sourceIds.has(c) ? { ...c, [spec.linkField]: sourceIds.get(c) } : c)),
      errors,
    };
    if (target === "spells") out.spellStatuses = docs.map((d) => mapFoundrySpellStatuses(d));
  }
  results[file.replace(/\.client\.json$/, "")] = plain(out);
}

if (lssDir) {
  const defaultSheet = readFileSync(path.join(import.meta.dirname, "..", "test", "fixtures", "default-sheet.json"), "utf8");
  for (const file of readdirSync(lssDir).filter((f) => f.endsWith(".json")).sort()) {
    const text = readFileSync(path.join(lssDir, file), "utf8");
    const one = {};
    for (const classic of [false, true]) {
      try {
        const sheet = normalizeSheet(JSON.parse(defaultSheet));
        const parsed = parseLssExport(text);
        const result = applyLssImport(sheet, parsed, classic);
        one[classic ? "to2014" : "to2024"] = { result, sheet };
      } catch (err) {
        one[classic ? "to2014" : "to2024"] = { error: err.message };
      }
    }
    results["lss/" + file] = plain(one);
  }
}

const goldenDir = path.join(dir, "golden");
let bad = 0;
let total = 0;
for (const [name, value] of Object.entries(results)) {
  const file = path.join(goldenDir, name.replace(/[\\/]/g, "_") + ".cards.json");
  total++;
  if (update) {
    mkdirSync(goldenDir, { recursive: true });
    writeFileSync(file, JSON.stringify(value, null, 1) + "\n");
    continue;
  }
  if (!existsSync(file)) {
    console.log(`нет эталона: ${name} (запусти с --update)`);
    bad++;
    continue;
  }
  const want = JSON.parse(readFileSync(file, "utf8"));
  if (!isDeepStrictEqual(want, value)) {
    bad++;
    console.log(`РАСХОЖДЕНИЕ: ${name}`);
    for (const [target, v] of Object.entries(value)) {
      if (isDeepStrictEqual(want[target], v)) continue;
      const cards = (v && v.cards) || [];
      const was = (want[target] && want[target].cards) || [];
      const changed = cards.filter((c, i) => !isDeepStrictEqual(c, was[i])).length;
      console.log(`  ${target}: изменилось карточек ${changed} из ${cards.length} (было ${was.length})`);
    }
  }
}
if (update) console.log(`эталон записан: ${total} файлов в ${goldenDir}`);
else console.log(bad ? `расхождений: ${bad} из ${total}` : `совпало: ${total} из ${total}`);
process.exit(bad ? 1 : 0);
