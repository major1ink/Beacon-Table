// schema-spellbook.js — виджет листа «spellbook»: заклинания и ячейки.
// Поля берёт из section.bind (spells, slots, attack, dc, modifier, level).
// Карточку библиотеки к строке листа находит по названию.
import { fetchSpells } from "./api.js";
import { wireCatalogLinks } from "./catalog-links.js";
import { enhanceRolls } from "./inline-rolls.js";
import { evaluatorOf, liveTile, showNumber, viewKeyedTable } from "./schema-fields.js";
import { cellPath, formatSigned, getPath, parsePool } from "./schema-layout.js";
import { checkDie } from "./system-profile.js";

// Шаблоны текста урона из spell-import.js: humanizeDamage.
const CANTRIP_DAMAGE_RE = /^(\d+)к(\d+)([^,]*), \+(\d+)к(\d+) на 5\/11\/17 ур\.$/;
const MODIFIER_TEXT = " + мод. заклинательной характеристики";
const CANTRIP_TIERS = [5, 11, 17];

// cantripTier — сколько рубежей прогрессии заговора пройдено.
export const cantripTier = (level) => CANTRIP_TIERS.filter((from) => level >= from).length;

// addDice — прибавляет кубики к первой группе урона: «8к6» + 2к6 = «10к6».
export function addDice(text, count, faces) {
  if (count <= 0) return text;
  const re = new RegExp(`^(\\d+)к${faces}\\b`);
  if (re.test(text)) return text.replace(re, (_, n) => `${Number(n) + count}к${faces}`);
  return `${text} + ${count}к${faces}`;
}

// spellDamageText — урон карточки с учётом уровня персонажа, модификатора и
// ячейки.
export function spellDamageText(card, spellLevel, slotLevel, { level = 1, modifier = 0 } = {}) {
  let text = String((card && card.damage) || "").trim();
  if (!text) return "";
  const cantrip = CANTRIP_DAMAGE_RE.exec(text);
  if (cantrip) text = `${Number(cantrip[1]) + Number(cantrip[4]) * cantripTier(level)}к${cantrip[2]}${cantrip[3]}`;
  if (text.includes(MODIFIER_TEXT)) text = text.replace(MODIFIER_TEXT, formatSigned(modifier));
  const up = /^(\d+)к(\d+)$/.exec(String((card && card.upcast) || "").trim());
  if (up && slotLevel > spellLevel) text = addDice(text, Number(up[1]) * (slotLevel - spellLevel), up[2]);
  return text;
}

// slotLevelsFrom — круги, с которых можно наложить заклинание (строка i — круг i+1).
export function slotLevelsFrom(spellLevel, slotValues) {
  const out = [spellLevel];
  slotValues.forEach((raw, i) => {
    const p = parsePool(raw);
    if (i + 1 > spellLevel && p && p.total > 0) out.push(i + 1);
  });
  return out;
}

const spellKey = (name) => String(name || "").trim().toLowerCase();
// в каталоге «Свет [Light]», на листе обычно «Свет»
const spellBareKey = (name) => spellKey(String(name || "").replace(/\s*\[[^\]]*\]\s*$/, ""));

// buildIndex — карточки библиотеки по названию.
export function buildIndex(list) {
  const index = new Map();
  for (const sp of list) {
    const name = String(sp.name || "").trim();
    if (!name) continue;
    const card = { name, attack: sp.attack || "", damage: sp.damage || "", upcast: sp.upcast || "" };
    for (const key of [spellKey(name), spellBareKey(name)]) if (!index.has(key)) index.set(key, card);
  }
  return index;
}

const cardOf = (index, name) => index.get(spellKey(name)) || index.get(spellBareKey(name)) || null;

// renderSpellbook — виджет в режиме чтения; пока карточки не загрузились,
// имена — обычный текст.
export function renderSpellbook(ctx, sec) {
  const { h } = ctx;
  const holder = h("div", { class: "v-stack" });
  const build = (index) => {
    holder.innerHTML = "";
    for (const node of [headTiles(ctx, sec), slotsCard(ctx, sec), spellsCard(ctx, sec, index)]) if (node) holder.appendChild(node);
  };
  build(new Map());
  fetchSpells()
    .catch(() => [])
    .then((list) => build(buildIndex(list)));
  wireCatalogLinks(holder);
  return holder;
}

function boundValue(ctx, sec, role) {
  const id = sec.bind[role];
  return id ? evaluatorOf(ctx).value(id) : null;
}

function headTiles(ctx, sec) {
  const fields = ctx.compiled.schema.fields;
  if (sec.bind.ability && !getPath(ctx.data, fields[sec.bind.ability].path)) return null;
  const tiles = ["modifier", "dc", "attack"]
    .filter((role) => sec.bind[role])
    .map((role) => {
      const f = fields[sec.bind[role]];
      const read = () => {
        const r = evaluatorOf(ctx).value(sec.bind[role]);
        return r.error ? { text: "!", error: r.error } : { text: showNumber(f, r.value) };
      };
      const roll = role === "attack" ? () => rollAttack(ctx, evaluatorOf(ctx).value(sec.bind.attack).value, f.label) : null;
      return liveTile(ctx, f.label, read, roll);
    });
  return tiles.length ? ctx.h("div", { class: "v-tiles", style: "margin-bottom:8px;" }, tiles) : null;
}

function rollAttack(ctx, bonus, label) {
  if (typeof bonus !== "number") return;
  ctx.sendRoll((checkDie() || "1d20") + formatSigned(bonus), label);
}

function slotsCard(ctx, sec) {
  const id = sec.bind.slots;
  return id ? viewKeyedTable(ctx, id, ctx.compiled.schema.fields[id], "Ячейки заклинаний") : null;
}

function spellsCard(ctx, sec, index) {
  const { h } = ctx;
  const table = ctx.compiled.schema.fields[sec.bind.spells];
  const col = (id) => (table.columns || []).find((c) => c.id === id);
  const read = (row, id) => (col(id) ? getPath(row, col(id).path) : undefined);
  const level = boundValue(ctx, sec, "level");
  const modifier = boundValue(ctx, sec, "modifier");
  const charLevel = level && !level.error ? level.value : 1;
  const modValue = modifier && !modifier.error ? modifier.value : 0;
  const slotValues = slotRawValues(ctx, sec);

  const byLevel = new Map();
  for (const row of getPath(ctx.data, table.path) || []) {
    if (!String(read(row, "name") || "").trim()) continue;
    const lvl = Number(read(row, "level")) || 0;
    if (!byLevel.has(lvl)) byLevel.set(lvl, []);
    byLevel.get(lvl).push(row);
  }
  const kids = [];
  for (const lvl of [...byLevel.keys()].sort((a, b) => a - b)) {
    kids.push(h("div", { class: "v-spell-lvl", text: lvl === 0 ? "Заговоры" : lvl + "-й уровень" }));
    for (const row of byLevel.get(lvl)) kids.push(spellRow(ctx, sec, index, row, lvl, { read, charLevel, modValue, slotValues }));
  }
  return ctx.vCard("Заклинания", kids);
}

// slotRawValues — значения ячеек по кругам.
function slotRawValues(ctx, sec) {
  const table = sec.bind.slots && ctx.compiled.schema.fields[sec.bind.slots];
  const pool = table && (table.columns || []).find((c) => c.type === "pool");
  if (!pool) return [];
  return table.rows.map((row) => getPath(ctx.data, cellPath(table, pool, row)));
}

function spellRow(ctx, sec, index, row, lvl, { read, charLevel, modValue, slotValues }) {
  const { h } = ctx;
  const name = String(read(row, "name")).trim();
  const card = cardOf(index, name);
  const meta = [read(row, "cast_time"), read(row, "range")].filter(Boolean).join(" · ");
  const notes = read(row, "notes");
  const metaEl = meta ? h("span", { class: "v-spell-meta", text: meta }) : null;
  const notesEl = notes ? h("span", { class: "v-spell-meta", text: notes }) : null;

  const dmgEl = h("span", { class: "v-atk-dmg" });
  const showDamage = (slotLevel) => {
    dmgEl.textContent = spellDamageText(card, lvl, slotLevel, { level: charLevel, modifier: modValue });
    enhanceRolls(dmgEl, ctx.sendRoll);
  };
  const slots = card && card.upcast && lvl > 0 ? slotLevelsFrom(lvl, slotValues) : [];
  const slotEl =
    slots.length > 1
      ? h("select", { class: "v-spell-slot", title: "С какой ячейки накладываем" }, slots.map((n) => h("option", { value: String(n), text: n + "-й" })))
      : null;
  if (slotEl) {
    slotEl.value = String(lvl);
    slotEl.addEventListener("change", () => showDamage(Number(slotEl.value)));
  }
  showDamage(lvl);

  const line = h("div", { class: "v-spell" }, [
    card
      ? h("a", { class: "v-spell-name catalog-ref", href: "#", "data-kind": "spell", "data-name": card.name, title: "Открыть карточку заклинания", text: name })
      : h("span", { class: "v-spell-name", text: name }),
    attackButton(ctx, sec, card, name),
    dmgEl.textContent ? dmgEl : null,
    dmgEl.textContent ? slotEl : null,
    read(row, "concentration") ? h("span", { class: "v-tag c", text: "К" }) : null,
    read(row, "ritual") ? h("span", { class: "v-tag", text: "Р" }) : null,
    read(row, "material") ? h("span", { class: "v-tag", text: "М" }) : null,
    metaEl,
    notesEl,
  ]);
  // не на кнопке атаки: «+4» внутри неё кидал бы кубик дважды
  if (metaEl) enhanceRolls(metaEl, ctx.sendRoll);
  if (notesEl) enhanceRolls(notesEl, ctx.sendRoll);
  return line;
}

// attackButton — кнопка атаки, если карточка бьёт броском и схема задаёт бонус.
function attackButton(ctx, sec, card, name) {
  if (!card || !card.attack || !sec.bind.attack) return null;
  const r = evaluatorOf(ctx).value(sec.bind.attack);
  if (r.error) return null;
  return ctx.h("button", {
    type: "button",
    class: "v-atk-hit",
    text: formatSigned(r.value),
    title: (card.attack === "melee" ? "Рукопашная" : "Дистанционная") + " атака заклинанием: " + name,
    onclick: () => rollAttack(ctx, evaluatorOf(ctx).value(sec.bind.attack).value, name),
  });
}
