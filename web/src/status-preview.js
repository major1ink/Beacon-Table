// status-preview.js — «как это увидят за столом»: токен с меткой (бейдж по
// кромке или во весь токен — см. domain.Condition.Overlay) и чип трекера.
// Рисует то же, что status-palette.js:statusVisual и vtt/layers/tokens.js:
// drawStatuses — картинка, если есть арт, иначе глиф, кайма цветом карточки.
// Только показ: ничего не шлёт и не сохраняет.
import { el } from "./card-shell.js";
import { glyphNode } from "./condition-glyphs.js";

function visual(cond) {
  if (cond.imageUrl) return el("img", { src: cond.imageUrl, alt: "" });
  return glyphNode(cond.icon, "");
}

// renderStatusPreview — возвращает узел с методом update(): перерисовать по
// текущим полям карточки (имя, глиф, цвет, overlay, уровни, длительность).
export function renderStatusPreview(cond, { durLabel, ridersNames }) {
  const root = el("div", { class: "sp" });
  root.update = () => {
    root.innerHTML = "";
    root.style.setProperty("--cc", cond.color || "");
    const token = el("div", { class: "sp-token", role: "img", "aria-label": "Токен с меткой" }, [
      el("span", { class: "sp-token-art", text: "🧌", "aria-hidden": "true" }),
      cond.overlay ? el("div", { class: "sp-ov" }, [visual(cond)]) : el("div", { class: "sp-badge" }, [visual(cond)]),
    ]);
    const chip = el("span", { class: "sp-chip" }, [
      el("span", { class: "sp-chip-g" }, [visual(cond)]),
      el("span", { text: cond.name || "Без имени" }),
      cond.levels > 1 ? el("span", { class: "sp-chip-r", text: "ур. 1" }) : null,
      el("span", { class: "sp-chip-r", text: cond.defaultRounds ? cond.defaultRounds + "р" : "∞" }),
    ]);
    const riders = ridersNames ? ridersNames() : [];
    root.append(
      el("span", { class: "card-lbl", text: "На токене и в трекере" }),
      token,
      chip,
      el("span", { class: "card-aside-note", text: "Действует " + durLabel() + (riders.length ? " · вместе с: " + riders.join(", ") : "") })
    );
  };
  root.update();
  return root;
}
