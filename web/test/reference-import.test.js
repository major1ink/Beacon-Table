// reference-import.test.js — mapFoundryReferenceBatch (см.
// web/src/reference-import.js). Здесь только facility (помещение бастиона,
// правила 2024) — самая свежая и наименее очевидная ветка: остальные типы
// (class/subclass/feat/race/background) проверены живым импортом уже давно
// и регрессий не давали.
import test from "node:test";
import assert from "node:assert/strict";

const { mapFoundryReferenceBatch } = await import("../src/reference-import.js");

test("facility мапится в справочник, а не отбрасывается", () => {
  const doc = {
    name: "Магическая лаборатория",
    type: "facility",
    img: "icons/facility.webp",
    system: {
      type: { value: "special" },
      size: "roomy",
      level: 5,
      description: { value: "<p>Комната для магических опытов.</p>" },
      // Игровое состояние конкретного мира — не должно попасть в текст.
      order: "craft",
      hirelings: { value: ["Actor.abc"], max: 2 },
    },
  };
  const [ref] = mapFoundryReferenceBatch([doc]);
  assert.equal(ref.name, "Магическая лаборатория");
  assert.equal(ref.kind, "помещение бастиона");
  assert.match(ref.description, /Тип: особое/);
  assert.match(ref.description, /Размер: просторное/);
  assert.match(ref.description, /Требуемый уровень: 5/);
  assert.match(ref.description, /Комната для магических опытов/);
  assert.doesNotMatch(ref.description, /craft|hirelings|Actor\.abc/);
});

test("незнакомый подтип пропускается молча, не ломая батч", () => {
  const out = mapFoundryReferenceBatch([{ name: "Меч", type: "weapon", system: {} }]);
  assert.equal(out.length, 0);
});
