// kv-table.js — таблица «показатель · значение» карточки (стоимость, вес,
// урон, КД…): значение правится прямо в строке, в режиме чтения пустые
// строки скрыты, формулы кубов кликабельны (inline-rolls.js). Общая для
// предметов; стили — styles/card.css (.kvt).
//
// rows: [{ label, get, set, placeholder, mono, type, min, step, custom }] —
// get/set замыкаются на объект карточки, как textInput в pages/*.js;
// custom() — свой контрол вместо поля (компоненты заклинания, КД с
// подписью), в чтении всё равно показывается get().
import { el } from "./card-shell.js";
import { enhanceRolls } from "./inline-rolls.js";

export function renderKvTable(rows, { readOnly = false, onChange, sendRoll, hint } = {}) {
  const body = el("tbody");
  for (const r of rows) {
    const value = r.get();
    const empty = value === "" || value === null || value === undefined || value === 0;
    if (readOnly && empty) continue;
    let cell;
    if (readOnly) {
      cell = el("span", { class: "kvt-val" + (r.mono ? " mono" : ""), text: String(value) + (r.unit || "") });
      if (sendRoll) enhanceRolls(cell, sendRoll);
    } else if (r.custom) {
      cell = r.custom();
    } else {
      const inp = el("input", { type: r.type || "text", class: r.mono ? "mono" : "", value: value ?? "", placeholder: r.placeholder || "—", "aria-label": r.label, min: r.min, step: r.step, autocomplete: "off" });
      inp.addEventListener("input", () => {
        r.set(r.type === "number" ? (inp.value === "" ? 0 : Number(inp.value)) : inp.value);
        onChange && onChange();
      });
      cell = inp;
    }
    body.appendChild(el("tr", {}, [el("th", { scope: "row", text: r.label }), el("td", {}, [cell])]));
  }
  if (!body.children.length) return null;
  return el("div", { class: "kvt" + (readOnly ? " readonly" : "") }, [el("table", {}, [body]), hint && !readOnly ? el("p", { class: "kvt-hint", text: hint }) : null]);
}
