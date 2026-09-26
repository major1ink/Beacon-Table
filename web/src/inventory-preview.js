// inventory-preview.js — «как игрок увидит предмет на листе»: строка
// инвентаря (значок, имя, количество, вес) с тумблером «надето» и то, что
// предмет меняет на стенде (КД было → стало по applyModifiers), урон с
// кликабельной формулой, заряды, активация. Тумблер — локальное состояние
// карточки: ничего не сохраняет, только показывает, что «пока надет» без
// галочки в инвентаре не действует.
import { el } from "./card-shell.js";
import { enhanceRolls } from "./inline-rolls.js";
import { applyModifiers, TARGET_AC, TARGET_SPEED } from "./modifiers.js";
import { glyphNode } from "./condition-glyphs.js";
import { itemGlyphName } from "./item-glyph.js";
import { formatWeight } from "./system-profile.js";

// renderInventoryPreview — узел с update(); stand — select из stand.js.
export function renderInventoryPreview(item, { stand, sendRoll }) {
  const root = el("div", { class: "ip" });
  let equipped = true;
  root.update = () => {
    root.innerHTML = "";
    const who = stand && stand.current() ? stand.current() : null;
    const mods = equipped ? item.modifiers || [] : [];
    const toggle = el("input", { type: "checkbox", checked: equipped || null, "aria-label": "Надето" });
    toggle.addEventListener("change", () => {
      equipped = toggle.checked;
      root.update();
    });
    const icon = item.imageUrl ? el("img", { src: item.imageUrl, alt: "" }) : glyphNode(itemGlyphName(item), "");
    const kv = [];
    if (who) {
      for (const [target, label] of [
        [TARGET_AC, "КД"],
        [TARGET_SPEED, "Скорость"],
      ]) {
        if (!(item.modifiers || []).some((m) => m.target === target && !m.period)) continue;
        const b = who.stats[target];
        const a = applyModifiers(b, target, mods);
        kv.push(el("b", { text: label }), el("span", { class: "ip-delta " + (a > b ? "up" : a < b ? "down" : "same") }, [el("span", { class: "num", text: b }), el("span", { class: "ip-arr", text: "→" }), el("span", { class: "ip-to", text: a })]));
      }
    }
    if (item.damage) {
      const d = el("span", { text: item.damage });
      if (sendRoll) enhanceRolls(d, sendRoll);
      kv.push(el("b", { text: "Урон" }), d);
    }
    if (item.charges) kv.push(el("b", { text: "Заряды" }), el("span", { text: item.charges }));
    if (item.activation) kv.push(el("b", { text: "Активация" }), el("span", { text: item.activation }));
    root.append(
      el("span", { class: "card-lbl", text: who ? "В инвентаре у " + who.name.split(",")[0] : "В инвентаре" }),
      el("div", { class: "ip-inv" }, [
        el("div", { class: "ip-row" }, [el("span", { class: "ip-ic" }, [icon]), el("span", { class: "ip-nm", text: item.name || "Без имени" }), el("span", { class: "ip-w", text: "×1 · " + formatWeight(item.weightLb) })]),
        el("label", { class: "ip-eq" }, [toggle, "надето"]),
      ]),
      kv.length ? el("div", { class: "ip-kv" }, kv) : null,
      el("span", { class: "card-aside-note", text: equipped ? "Так игрок увидит предмет на листе; изменения действуют, пока стоит «надето»." : "Снято — изменения из «Пока надет» не действуют." })
    );
  };
  root.update();
  if (stand) stand.addEventListener("change", root.update);
  return root;
}
