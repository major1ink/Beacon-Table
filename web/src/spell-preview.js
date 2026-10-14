// spell-preview.js — чип состояния заклинания (domain.SpellStatusRef) как в
// трекере.
import { el } from "./card-shell.js";
import { glyphNode } from "./condition-glyphs.js";

// statusChip — глиф и цвет состояния, раунды. canApply — клик накладывает
// метку на токен через топ-документ (postMessage "beacon:applySpellStatus",
// только ДМ внутри окна стола).
export function statusChip(ref, { conditions, canApply, spellName }) {
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
    const apply = () => window.parent.postMessage({ type: "beacon:applySpellStatus", slug: ref.slug, name: ref.name || ref.slug, rounds: ref.rounds || 0, spellName: spellName || "" }, location.origin);
    chip.addEventListener("click", apply);
    chip.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        apply();
      }
    });
  }
  return chip;
}
