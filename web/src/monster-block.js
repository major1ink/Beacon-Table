// monster-block.js — общие куски статблока существа (domain.Monster):
// модификатор характеристики, плитки шести характеристик с броском, цвет по
// опасности и запасной глиф по типу. Сам статблок собирает pages/bestiary.js
// из kv-table.js + этих плиток + свёрнутых блоков текста.
import { el } from "./card-shell.js";
import { icon } from "./icons.js";
import { escapeHtml } from "./html.js";

export const ABILITIES = [
  { key: "str", label: "Сил", full: "Сила" },
  { key: "dex", label: "Лов", full: "Ловкость" },
  { key: "con", label: "Тел", full: "Телосложение" },
  { key: "int", label: "Инт", full: "Интеллект" },
  { key: "wis", label: "Мдр", full: "Мудрость" },
  { key: "cha", label: "Хар", full: "Харизма" },
];

export const abilityMod = (score) => Math.floor(((score || 0) - 10) / 2);
export const fmtMod = (n) => (n >= 0 ? "+" + n : "−" + Math.abs(n));
// формула для роллера — с обычным минусом, не типографским
const rollMod = (n) => (n >= 0 ? "+" + n : String(n));

// crColor — цвет медальона по опасности: 0–½ серый, 1–4 зелёный, 5–10
// синий, 11–16 фиолетовый, 17+ золото. Незнакомый текст — без цвета.
export function crColor(cr) {
  const t = String(cr || "").trim();
  if (!t) return "";
  let n;
  if (t.includes("/")) {
    const [a, b] = t.split("/").map(Number);
    n = a / (b || 1);
  } else n = parseFloat(t.replace(",", "."));
  if (!Number.isFinite(n)) return "";
  if (n < 1) return "#9aa0a6";
  if (n < 5) return "#3fb950";
  if (n < 11) return "#4a8ef0";
  if (n < 17) return "#a371f7";
  return "#e3a008";
}

// monsterGlyphName — запасной значок без арта, по словам в типе существа.
const TYPE_RULES = [
  [/нежить|скелет|зомби|призрак|вампир/i, "skull"],
  [/дракон/i, "dragon"],
  [/зверь|животн|чудовищ/i, "paw"],
  [/исчадие|демон|дьявол|бес/i, "horns"],
  [/растен|дерев/i, "tree"],
  [/аберрац|слизь/i, "eye"],
  [/фея|небожител|элементал/i, "sparkle"],
  [/конструкт|голем/i, "box"],
  [/гуманоид|великан/i, "hood"],
];
export function monsterGlyphName(monster) {
  const t = String((monster && monster.type) || "");
  for (const [re, name] of TYPE_RULES) if (re.test(t)) return name;
  return "hood";
}

// renderAbilityTiles — шесть плиток: счёт (поле в редакторе) и модификатор,
// клик по модификатору — бросок к20 с ним. Модификатор пересчитывается на
// каждый ввод без перерисовки.
export function renderAbilityTiles(monster, { readOnly, onChange, sendRoll }) {
  const grid = el("div", { class: "mb-ab" });
  for (const a of ABILITIES) {
    const mod = el("button", { type: "button", class: "mb-mod", title: "Бросить " + a.full, text: fmtMod(abilityMod(monster.abilities[a.key])) });
    mod.addEventListener("click", () => sendRoll && sendRoll("1d20" + rollMod(abilityMod(monster.abilities[a.key])), a.full));
    let score;
    if (readOnly) score = el("span", { class: "mb-score", text: String(monster.abilities[a.key]) });
    else {
      score = el("input", { type: "number", min: "1", max: "30", value: monster.abilities[a.key], "aria-label": a.full });
      score.addEventListener("input", () => {
        const v = parseInt(score.value, 10);
        monster.abilities[a.key] = Math.max(1, Math.min(30, Number.isNaN(v) ? 10 : v));
        mod.textContent = fmtMod(abilityMod(monster.abilities[a.key]));
        onChange && onChange();
      });
    }
    grid.appendChild(el("div", { class: "mb-tile" }, [el("span", { class: "card-lbl", text: a.label }), score, mod]));
  }
  return grid;
}

// renderMonsterPreview — «На карте и в трекере»: токен с артом/глифом и чип
// бойца с инициативой, КД и хитами — те числа, с которыми существо появится
// на карте (см. pages/dm.js: перетаскивание из списка существ).
export function renderMonsterPreview(monster, { glyphNode }) {
  const root = el("div", { class: "mp" });
  root.update = () => {
    root.innerHTML = "";
    const art = monster.imageUrl ? el("img", { src: monster.imageUrl, alt: "" }) : glyphNode(monsterGlyphName(monster), "");
    const ini = fmtMod(abilityMod(monster.abilities.dex));
    root.append(
      el("span", { class: "card-lbl", text: "На карте и в трекере" }),
      el("div", { class: "mp-token", role: "img", "aria-label": "Токен" }, [art]),
      el("div", { class: "mp-chip" }, [
        el("span", { class: "mp-av" }, [monster.imageUrl ? el("img", { src: monster.imageUrl, alt: "" }) : glyphNode(monsterGlyphName(monster), "")]),
        el("span", {}, [el("div", { text: monster.name || "Без имени" }), el("div", { class: "mp-nums", html: `ини <b>${escapeHtml(ini)}</b> · КД <b>${escapeHtml(monster.ac || 0)}</b> · <b>${escapeHtml(monster.hp || 0)}/${escapeHtml(monster.hp || 0)}</b>` })]),
      ]),
      el("span", { class: "card-aside-note", html: "Перетащи существо из списка на карту — токен и боец в трекере появятся с этими числами. " + icon("creature", { size: 12 }) })
    );
  };
  root.update();
  return root;
}
