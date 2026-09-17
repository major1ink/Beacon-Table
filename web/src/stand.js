// stand.js — «примерить на»: существа и персонажи мира, на которых
// карточка состояния/предмета показывает «было → стало» (см.
// stat-editor.js). База — реальные числа из бестиария и листов персонажей,
// расчёт — applyModifiers (modifiers.js); ничего не пишет, только читает.
import { fetchCharacters, fetchCharacter, fetchBestiary } from "./api.js";

const STORAGE_KEY = "beacon.stand";
// Без мира с существами стенд всё равно должен что-то показывать.
const DUMMY = {
  id: "dummy",
  name: "Манекен",
  kind: "dummy",
  stats: { ac: 10, speed: 30, "hp.max": 10, "hp.current": 10, initiative: 0, "abilities.str": 10, "abilities.dex": 10, "abilities.con": 10, "abilities.int": 10, "abilities.wis": 10, "abilities.cha": 10 },
};
// Персонажей грузим по одному (список отдаёт только имена) — ограничение,
// чтобы стол с сотней персонажей не открывал карточку минуту.
const MAX_CHARACTERS = 20;

const abilityMod = (score) => Math.floor(((score || 10) - 10) / 2);
// Скорость монстра — свободный текст («30 фт., полёт 60 фт.»): берём первое число.
const speedOf = (s) => {
  const m = String(s || "").match(/\d+/);
  return m ? parseInt(m[0], 10) : 30;
};

function fromSheet(c) {
  const sheet = c.sheet || {};
  const ab = sheet.abilities || {};
  const combat = sheet.combat || {};
  return {
    id: c.id,
    name: c.name,
    kind: "character",
    stats: {
      ac: combat.ac || 10,
      speed: combat.speed || 30,
      "hp.max": combat.hpMax || 0,
      "hp.current": combat.hpCurrent || 0,
      initiative: abilityMod(ab.dex),
      "abilities.str": ab.str || 10,
      "abilities.dex": ab.dex || 10,
      "abilities.con": ab.con || 10,
      "abilities.int": ab.int || 10,
      "abilities.wis": ab.wis || 10,
      "abilities.cha": ab.cha || 10,
    },
  };
}

function fromMonster(m) {
  const ab = m.abilities || {};
  return {
    id: m.id,
    name: m.name,
    kind: "monster",
    stats: {
      ac: m.ac || 10,
      speed: speedOf(m.speed),
      "hp.max": m.hp || 0,
      "hp.current": m.hp || 0,
      initiative: abilityMod(ab.dex),
      "abilities.str": ab.str || 10,
      "abilities.dex": ab.dex || 10,
      "abilities.con": ab.con || 10,
      "abilities.int": ab.int || 10,
      "abilities.wis": ab.wis || 10,
      "abilities.cha": ab.cha || 10,
    },
  };
}

// loadStand — все доступные записи. Ошибки глотаем: игроку бестиарий
// недоступен (403), а карточка должна открыться всё равно.
export async function loadStand() {
  const entries = [];
  try {
    const list = await fetchCharacters();
    const full = await Promise.all((list || []).slice(0, MAX_CHARACTERS).map((c) => fetchCharacter(c.id).catch(() => null)));
    for (const c of full) if (c) entries.push(fromSheet(c));
  } catch {
    /* нет персонажей — не беда */
  }
  try {
    const monsters = await fetchBestiary();
    for (const m of monsters || []) entries.push(fromMonster(m));
  } catch {
    /* игрок: бестиарий закрыт */
  }
  if (entries.length === 0) entries.push(DUMMY);
  return entries;
}

// renderStandSelect — выпадашка с группами «Персонажи»/«Существа»; выбор
// помнится между карточками. Возвращает select с методом current().
export function renderStandSelect(entries, onChange) {
  const select = document.createElement("select");
  const groups = [
    ["Персонажи", entries.filter((e) => e.kind === "character")],
    ["Существа", entries.filter((e) => e.kind === "monster")],
    ["", entries.filter((e) => e.kind === "dummy")],
  ];
  for (const [label, list] of groups) {
    if (list.length === 0) continue;
    const parent = label ? document.createElement("optgroup") : select;
    if (label) {
      parent.label = label;
      select.appendChild(parent);
    }
    for (const e of list) {
      const o = document.createElement("option");
      o.value = e.id;
      o.textContent = e.name;
      parent.appendChild(o);
    }
  }
  let remembered = "";
  try {
    remembered = localStorage.getItem(STORAGE_KEY) || "";
  } catch {
    /* приватный режим */
  }
  if (remembered && entries.some((e) => e.id === remembered)) select.value = remembered;
  select.current = () => entries.find((e) => e.id === select.value) || entries[0];
  select.addEventListener("change", () => {
    try {
      localStorage.setItem(STORAGE_KEY, select.value);
    } catch {
      /* приватный режим */
    }
    onChange && onChange(select.current());
  });
  return select;
}
