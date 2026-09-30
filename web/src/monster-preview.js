// monster-preview.js — «На карте и в трекере» у карточки существа: токен с
// артом или глифом и чип бойца.
import { el } from "./card-shell.js";
import { icon } from "./icons.js";
import { escapeHtml } from "./html.js";

// renderMonsterPreview — токен с артом/глифом и чип бойца с инициативой, КД
// и хитами — те числа, с которыми существо появится на карте (см.
// pages/dm.js: перетаскивание из списка существ). numbers() → { ini, ac, hp }
// текстом — общие поля ядра (schema-summary.js: coreSummary); glyphName() —
// запасной глиф без арта. Пустая ini — схема инициативу не задаёт (её бросает
// сервер по правилам боя системы), в чипе её нет.
export function renderMonsterPreview(monster, { glyphNode, glyphName, numbers }) {
  const root = el("div", { class: "mp" });
  root.update = () => {
    root.innerHTML = "";
    const art = monster.imageUrl ? el("img", { src: monster.imageUrl, alt: "" }) : glyphNode(glyphName(), "");
    const { ini, ac, hp } = numbers();
    root.append(
      el("span", { class: "card-lbl", text: "На карте и в трекере" }),
      el("div", { class: "mp-token", role: "img", "aria-label": "Токен" }, [art]),
      el("div", { class: "mp-chip" }, [
        el("span", { class: "mp-av" }, [monster.imageUrl ? el("img", { src: monster.imageUrl, alt: "" }) : glyphNode(glyphName(), "")]),
        el("span", {}, [el("div", { text: monster.name || "Без имени" }), el("div", { class: "mp-nums", html: (ini ? `ини <b>${escapeHtml(ini)}</b> · ` : "") + `КД <b>${escapeHtml(ac)}</b> · <b>${escapeHtml(hp)}/${escapeHtml(hp)}</b>` })]),
      ]),
      el("span", { class: "card-aside-note", html: "Перетащи существо из списка на карту — токен и боец в трекере появятся с этими числами. " + icon("creature", { size: 12 }) })
    );
  };
  root.update();
  return root;
}
