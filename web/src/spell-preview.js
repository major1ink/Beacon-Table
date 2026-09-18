// spell-preview.js — «Что произойдёт»: атака/спасбросок, урон с кликабельной
// формулой, длительность и чипы состояний (domain.SpellStatusRef) как в
// трекере. У ДМ внутри окна стола чип наложит метку через топ-документ
// (postMessage "beacon:applySpellStatus", см. pages/dm.js) — тот же путь, что
// был у блока «Накладывает состояния» в старом read-режиме.
import { el } from "./card-shell.js";
import { enhanceRolls } from "./inline-rolls.js";
import { glyphNode } from "./condition-glyphs.js";

export function renderSpellPreview(spell, { sendRoll, attackLabel, conditions, canApply }) {
  const root = el("div", { class: "spp" });
  root.update = () => {
    root.innerHTML = "";
    const kv = [];
    if (spell.attack) kv.push(el("b", { text: "Атака" }), el("span", { text: attackLabel(spell.attack) }));
    if (spell.savingThrow) kv.push(el("b", { text: "Спасбросок" }), el("span", { text: spell.savingThrow }));
    if (spell.damage) {
      const d = el("span", { text: spell.damage });
      if (sendRoll) enhanceRolls(d, sendRoll);
      kv.push(el("b", { text: "Урон" }), d);
    }
    if (spell.duration) kv.push(el("b", { text: "Длится" }), el("span", { text: spell.duration }));
    const chips = (spell.statuses || []).map((ref) => {
      const cond = (conditions || []).find((c) => c.slug === ref.slug);
      const chip = el("span", { class: "spp-chip" + (canApply ? " clickable" : "") }, [
        el("span", { class: "spp-chip-g" }, [glyphNode(cond ? cond.icon : "question", "")]),
        el("span", { text: ref.name || ref.slug }),
        el("span", { class: "spp-chip-r", text: ref.rounds ? ref.rounds + " р." : "∞" }),
      ]);
      if (cond && cond.color) chip.style.setProperty("--cc", cond.color);
      if (ref.note) chip.title = ref.note;
      if (canApply) {
        chip.title = "Наложить это состояние на токен на карте" + (ref.note ? " · " + ref.note : "");
        chip.setAttribute("role", "button");
        chip.tabIndex = 0;
        const apply = () => window.parent.postMessage({ type: "beacon:applySpellStatus", slug: ref.slug, name: ref.name || ref.slug, rounds: ref.rounds || 0, spellName: spell.name || "" }, location.origin);
        chip.addEventListener("click", apply);
        chip.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            apply();
          }
        });
      }
      return chip;
    });
    const note = spell.concentration
      ? "Концентрация: при её потере эффект и метки снимаются."
      : chips.length
        ? canApply
          ? "Клик по чипу — наложить метку на токен на карте."
          : "Наложить метку может только ДМ из окна стола."
        : "Ни атаки, ни спасброска, ни состояний — эффект целиком в описании.";
    root.append(el("span", { class: "card-lbl", text: "Что произойдёт" }), kv.length ? el("div", { class: "spp-kv" }, kv) : null, ...chips, el("span", { class: "card-aside-note", text: note }));
  };
  root.update();
  return root;
}
