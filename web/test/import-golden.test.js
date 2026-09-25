// import-golden.test.js — страховочные тесты импортов перед выносом D&D в
// модули (задача «Импорты при переходе на модули»). Каждый маппер прогоняется
// по фикстурам и сверяется с эталоном в test/golden/: пока идёт перенос,
// эталоны не должны меняться ни на байт.
//
// Фикстуры (test/fixtures/foundry, test/fixtures/lss) — документы реальной
// структуры: Foundry dnd5e 5.x (существа, транспорт, готовые персонажи,
// заклинания, предметы, справочник) и старые схемы 2.x/3.x, плюс экспорты
// Long Story Short 2014 и 2024. Длинные тексты в них заменены заглушкой —
// важна форма документа, а не чужой перевод.
import test from "node:test";
import { matchGolden, fixture, fixtureText, safe } from "./golden.js";

const { mapFoundryMonsterJson } = await import("../src/monster-import.js");
const { mapFoundryCharacterJson } = await import("../src/character-import.js");
const { mapFoundrySpellJson, mapFoundrySpellStatuses } = await import("../src/spell-import.js");
const { mapFoundryItemJson } = await import("../src/item-import.js");
const { mapFoundryReferenceBatch } = await import("../src/reference-import.js");
const { mapFoundryConditionBatch } = await import("../src/condition-import.js");
const { parseLssExport, applyLssImport } = await import("../src/lss-import.js");
const { normalizeSheet } = await import("../src/sheet-normalize.js");
const { tokenArt, itemArt, pregenArt, mapPackDocs, cardKey, sameCard } = await import("../src/foundry-import-cards.js");

const npc = fixture("foundry/actors-npc.json");
const vehicle = fixture("foundry/actors-vehicle.json");
const characters = fixture("foundry/actors-character.json");
const spells = fixture("foundry/spells.json");
const items = fixture("foundry/items.json");
const references = fixture("foundry/references.json");
const legacy = fixture("foundry/legacy-v2-v3.json");

test("Foundry 5.x: существа и транспорт → бестиарий", () => {
  matchGolden("monsters", [...npc, ...vehicle].map((d) => safe(() => mapFoundryMonsterJson(d))));
});

test("Foundry 2.x/3.x: существо старой схемы → бестиарий", () => {
  matchGolden("monsters-legacy", legacy.npc.map((d) => safe(() => mapFoundryMonsterJson(d))));
});

test("Foundry: готовые персонажи → прегены", () => {
  matchGolden("pregens", characters.map((d) => safe(() => mapFoundryCharacterJson(d))));
});

test("Foundry: заклинания и что они накладывают", () => {
  const all = [...spells, ...legacy.spells];
  matchGolden(
    "spells",
    all.map((d) => ({ card: safe(() => mapFoundrySpellJson(d)), statuses: safe(() => mapFoundrySpellStatuses(d)) })),
  );
});

test("Foundry: предметы всех типов", () => {
  matchGolden("items", [...items, ...legacy.items].map((d) => safe(() => mapFoundryItemJson(d))));
});

test("Foundry: справочник — классы, архетипы, черты, происхождения, пристройки", () => {
  matchGolden("references", mapFoundryReferenceBatch(references));
});

test("Foundry: состояния из эффектов заклинаний, предметов и отдельных документов", () => {
  matchGolden("conditions", {
    fromSpells: mapFoundryConditionBatch(spells),
    fromItems: mapFoundryConditionBatch([...items, ...legacy.items]),
    fromLegacy: mapFoundryConditionBatch([...legacy.spells, ...legacy.effects]),
  });
});

// Не-свои документы в чужом разделе: маппер должен отказать или пропустить,
// а не собрать мусорную карточку.
test("Foundry: документы не своего типа", () => {
  matchGolden("wrong-type", {
    spellAsMonster: safe(() => mapFoundryMonsterJson(spells[0])),
    npcAsSpell: safe(() => mapFoundrySpellJson(npc[0])),
    spellAsItem: safe(() => mapFoundryItemJson(spells[0])),
    npcAsPregen: safe(() => mapFoundryCharacterJson(npc[0])),
    mixedReferences: mapFoundryReferenceBatch([...spells.slice(0, 2), ...items.slice(0, 2)]).length,
  });
});

// Склейка на странице импорта пакета: арт из документа, якорь _id для
// связи с токенами сцен и отказ одного документа, не роняющий раздел.
test("импорт пакета: карточки раздела, арт и якоря", () => {
  const errors = [];
  const onError = (doc, err) => errors.push(`${doc && doc.name}: ${err.message}`);
  const monsters = mapPackDocs(
    { mapOne: mapFoundryMonsterJson, art: tokenArt, linkField: "foundryActorId" },
    [...npc, spells[0]],
    onError,
  );
  const pregens = mapPackDocs({ mapOne: mapFoundryCharacterJson, art: pregenArt }, characters, onError);
  const gear = mapPackDocs({ mapOne: mapFoundryItemJson, art: itemArt }, items, onError);
  const refs = mapPackDocs({ mapBatch: mapFoundryReferenceBatch }, references, onError);
  matchGolden("pack-cards", {
    monsters: monsters.mapped.map((c) => c && { name: c.name, imageUrl: c.imageUrl, anchor: monsters.sourceIds.get(c) || "" }),
    pregens: pregens.mapped.map((c) => c && { name: c.name, avatarUrl: c.avatarUrl, imageUrl: c.imageUrl }),
    items: gear.mapped.map((c) => c && { name: c.name, imageUrl: c.imageUrl }),
    references: refs.mapped.length,
    errors,
  });
});

test("импорт пакета: совпадение с уже заведённой карточкой", () => {
  const card = mapFoundrySpellJson(spells[0]);
  const conditions = { id: "conditions" };
  const other = { id: "spells" };
  matchGolden("pack-dedupe", {
    keyByName: cardKey(other, { name: "  Огненный Снаряд " }),
    keyBySlug: cardKey(conditions, { name: "Сбит с ног", slug: " Prone " }),
    keyNoSlug: cardKey(conditions, { name: "Горение" }),
    sameAsItself: sameCard({ ...card, id: "x", tags: ["своё"] }, card),
    changedField: sameCard({ ...card, range: "другое" }, card),
    numberVsString: sameCard({ level: "0" }, { level: 0 }),
    missingVsEmpty: sameCard({}, { note: "" }),
  });
});

// LSS: парсинг файла и перенос в лист — тем же путём, что в бланке: лист,
// каким его отдаёт сервер новому персонажу (fixtures/default-sheet.json =
// domain.DefaultCharacterSheet), проходит normalizeSheet, затем импорт.
function freshSheet() {
  return normalizeSheet(fixture("default-sheet.json"));
}

function lss(file, targetIsClassic) {
  const sheet = freshSheet();
  const parsed = parseLssExport(fixtureText(file));
  const result = applyLssImport(sheet, parsed, targetIsClassic);
  return { result, edition: parsed.edition, sheet };
}

test("LSS 2024 → лист 2024 и лист 2014", () => {
  matchGolden("lss-2024", { to2024: lss("lss/lss-2024.json", false), to2014: lss("lss/lss-2024.json", true) });
});

test("LSS 2014 → лист 2014", () => {
  matchGolden("lss-2014", lss("lss/lss-2014.json", true));
});

test("LSS: повторный импорт не затирает и не дублирует", () => {
  const sheet = freshSheet();
  const parsed = parseLssExport(fixtureText("lss/lss-2024.json"));
  applyLssImport(sheet, parsed, false);
  applyLssImport(sheet, parsed, false);
  matchGolden("lss-2024-twice", sheet);
});

test("лист нового персонажа после normalizeSheet", () => {
  matchGolden("sheet-normalized", freshSheet());
});

test("LSS: чужие файлы отклоняются понятной ошибкой", () => {
  matchGolden("lss-errors", {
    notJson: safe(() => parseLssExport("{")),
    foundryActor: safe(() => parseLssExport(JSON.stringify(npc[0]))),
    brokenInner: safe(() => parseLssExport(JSON.stringify({ jsonType: "character", data: "{" }))),
  });
});
