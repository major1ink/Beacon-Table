// Деньги листа — словарь валют системы (domain.Coins): нормализация не
// выбрасывает и не дописывает ключи, а кошелёк показывает валюты системы и
// отдельно — чужие. Без загруженного профиля вес — просто число.
import test from "node:test";
import assert from "node:assert/strict";

import { normalizeSheet } from "../src/sheet-normalize.js";
import { coinRows, formatWeight } from "../src/system-profile.js";

test("normalizeSheet не теряет валюты другой системы", () => {
  const s = normalizeSheet({ coins: { gp: "12", shells: 4, money: -3 } });
  assert.deepEqual(s.coins, { gp: 12, shells: 4, money: 0 });
});

test("normalizeSheet: старые пять монет D&D как есть", () => {
  const coins = { cp: 1, sp: 2, gp: 3, ep: 0, pp: 0 };
  assert.deepEqual(normalizeSheet({ coins: { ...coins } }).coins, coins);
});

test("normalizeSheet: без денег — пустой кошелёк", () => {
  assert.deepEqual(normalizeSheet({}).coins, {});
});

test("без профиля системы: чужие валюты — отдельно, вес без единицы", () => {
  assert.deepEqual(coinRows({ shells: 1 }), [{ key: "shells", label: "shells", title: "shells", other: true }]);
  assert.equal(formatWeight(2.5), "2.5");
});
