// card-shell.js — каркас карточки книги: шапка-медальон с именем и
// плашками, свёрнутые разделы с выжимкой в заголовке, обёртка «основная
// колонка + панель предпросмотра». Общий для состояний и предметов (см.
// pages/conditions.js, pages/itembook.js), стили — styles/card.css.
//
// Модуль не знает, что за карточка: страница отдаёт готовые DOM-узлы
// контролов и коллбеки, а обратно получает ручки для точечного обновления
// (setName/setGlyph/setPills, setSummary) — чтобы на каждый ввод не
// перестраивать всю форму и не ронять фокус.
import { icon } from "./icons.js";

export function el(tag, attrs, children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(children || [])) {
    if (c === undefined || c === null || c === false) continue;
    e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
}

let uid = 0;
// labeled — подпись, связанная с полем через for/id (без этого скринридер
// читает поле как безымянное).
export function labeled(text, input, hint) {
  input.id = input.id || "cf" + ++uid;
  return el("div", { class: "field" }, [el("label", { for: input.id, text }), input, hint ? el("p", { class: "card-note", text: hint }) : null]);
}

export function pill(text, kind, svg) {
  return el("span", { class: "card-pill" + (kind ? " " + kind : "") }, [svg ? el("span", { html: svg, style: "display:inline-flex" }) : null, text]);
}

// ORNAMENT — линейка между шапкой и телом; decorative, поэтому aria-hidden.
const ORNAMENT =
  '<svg class="card-orn" viewBox="0 0 400 14" preserveAspectRatio="none" fill="none" stroke="var(--gold)" stroke-width="1" aria-hidden="true">' +
  '<path d="M0 7h170M230 7h170" opacity=".55"/><path d="M185 7l7-5 8 5-8 5z" fill="var(--gold)" opacity=".9"/><path d="M200 7l7-5 8 5-8 5z" fill="var(--gold)" opacity=".5"/></svg>';

export function ornament() {
  return el("span", { html: ORNAMENT, style: "display:block" });
}

// renderHero — шапка. glyph: DOM-узел или строка (эмодзи); imageUrl
// перекрывает глиф. readOnly — имя текстом, без контролов.
export function renderHero({ glyph, imageUrl, color, name, namePlaceholder, levels, pills, controls, onName, readOnly }) {
  const medal = el("div", { class: "card-medal", role: "img", "aria-label": "Значок" });
  const pillsBox = el("div", { class: "card-pills" });
  const nameBox = el("h2", { class: "card-name" });
  let nameInput = null;
  if (readOnly) {
    nameBox.appendChild(el("span", { class: "card-name-text", text: name || "Без имени" }));
  } else {
    nameInput = el("input", { type: "text", value: name || "", placeholder: namePlaceholder || "Название", "aria-label": namePlaceholder || "Название", maxlength: "120" });
    nameInput.addEventListener("input", () => onName && onName(nameInput.value));
    nameBox.appendChild(nameInput);
  }
  const root = el("div", { class: "card-hero" }, [
    medal,
    el("div", { class: "card-hero-text" }, [nameBox, pillsBox, !readOnly && controls && controls.length ? el("div", { class: "card-hero-controls" }, controls) : null]),
  ]);

  const api = {
    el: root,
    setColor(c) {
      root.style.setProperty("--cc", c || "");
    },
    setGlyph(g, img) {
      medal.innerHTML = "";
      if (img) medal.appendChild(el("img", { src: img, alt: "" }));
      else if (g && g.nodeType) medal.appendChild(g);
      else medal.appendChild(el("span", { text: g || "❔" }));
      if (levels > 1) medal.appendChild(el("span", { class: "card-medal-lvl", text: "1–" + levels }));
    },
    setLevels(n) {
      levels = n;
      const lvl = medal.querySelector(".card-medal-lvl");
      if (lvl) lvl.remove();
      if (n > 1) medal.appendChild(el("span", { class: "card-medal-lvl", text: "1–" + n }));
    },
    setPills(list) {
      pillsBox.innerHTML = "";
      for (const p of list || []) if (p) pillsBox.appendChild(p);
    },
    setName(v) {
      if (nameInput) nameInput.value = v || "";
      else nameBox.textContent = v || "Без имени";
    },
  };
  api.setColor(color);
  api.setGlyph(glyph, imageUrl);
  api.setPills(pills);
  return api;
}

// fold — свёрнутый раздел; summary — выжимка в заголовке, видна только в
// свёрнутом виде. Возвращает <details> с ручкой setSummary.
export function fold({ title, summary, body, open }) {
  const sum = el("span", { class: "card-fold-sum", text: summary || "" });
  const d = el("details", { class: "card-fold", open: open || null }, [
    el("summary", {}, [el("h3", { text: title }), sum, el("span", { class: "card-fold-car", html: icon("chevron-right", { size: 12 }), "aria-hidden": "true" })]),
    el("div", { class: "card-fold-body" }, body),
  ]);
  d.setSummary = (text) => {
    sum.textContent = text || "";
  };
  return d;
}

// renderBody — обёртка «основная колонка + липкая панель справа». aside
// null — одна колонка на всю ширину.
export function renderBody(mainChildren, aside) {
  const body = el("div", { class: "card-body" + (aside ? "" : " no-aside") }, [el("div", { class: "card-main" }, mainChildren)]);
  if (aside) body.appendChild(el("aside", { class: "card-aside", "aria-label": "Предпросмотр" }, [el("div", { class: "card-aside-in" }, aside)]));
  return body;
}
