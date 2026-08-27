// heading-nav.js — «перейти к разделу»: кнопка-оглавление у длинной записи
// журнала. В Foundry сюжет приключения разбит на страницы с боковым списком;
// у нас все страницы слиты в один текст разделами «## …» (см.
// internal/foundry/journal.go), и без быстрого перехода по ним читать
// импортированный модуль неудобно.
//
// Общий модуль для журнала стола (pages/journal.js) и других markdown-
// поверхностей — поведение одинаковое. Всплывашка строится в JS с inline-
// стилями по CSS-переменным темы: так не нужно добавлять правила в каждый
// <style>.
import { scrollHeadingIntoView } from "./markdown.js";

const POP_STYLE = `
  position: fixed; z-index: 60; min-width: 200px; max-width: 340px;
  max-height: 60vh; overflow-y: auto; padding: 4px;
  background: var(--panel-bg, #1e1e22); color: var(--text, #eee);
  border: 1px solid var(--border, #3a3a40); border-radius: 10px;
  box-shadow: var(--shadow-float, 0 8px 30px rgba(0,0,0,.4)); font-size: 12.5px;
`;
const ITEM_STYLE = `
  display: block; width: 100%; box-sizing: border-box; text-align: left;
  padding: 6px 10px; border: none; border-radius: 6px; background: none;
  color: inherit; font: inherit; cursor: pointer; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
`;

// mountHeadingNav(btn, container) — вешает на кнопку btn всплывающее
// оглавление по заголовкам h1–h4 внутри container. Возвращает { refresh }:
// вызывающий зовёт refresh() после каждой перерисовки container — кнопка
// прячется, если заголовков меньше двух, и закрывает открытую всплывашку.
export function mountHeadingNav(btn, container) {
  if (!btn || !container) return { refresh() {} };
  let pop = null;

  // Заголовки внутри врезок («зачитать вслух», советы Мастеру — см.
  // theme.css) в оглавление не берём: это подписи блоков, а не разделы.
  const headings = () =>
    [...container.querySelectorAll("h1, h2, h3, h4")].filter(
      (h) => h.textContent.trim() && !h.closest(".beacon-readaloud, .beacon-dm-note")
    );

  function close() {
    if (!pop) return;
    pop.remove();
    pop = null;
    document.removeEventListener("click", onDocClick, true);
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", close);
  }

  function onDocClick(e) {
    if (pop && !pop.contains(e.target) && !btn.contains(e.target)) close();
  }
  function onKey(e) {
    if (e.key === "Escape") close();
  }

  function open() {
    const items = headings();
    if (items.length < 2) return;
    const minLevel = Math.min(...items.map((h) => +h.tagName[1]));

    pop = document.createElement("div");
    pop.setAttribute("style", POP_STYLE);
    for (const h of items) {
      const level = +h.tagName[1];
      const row = document.createElement("button");
      row.type = "button";
      row.setAttribute("style", ITEM_STYLE + `padding-left:${10 + (level - minLevel) * 14}px;`);
      if (level === minLevel) row.style.fontWeight = "600";
      if (level > minLevel + 1) row.style.opacity = ".7";
      row.textContent = h.textContent.trim();
      row.addEventListener("mouseenter", () => (row.style.background = "var(--surface-hover, #34343a)"));
      row.addEventListener("mouseleave", () => (row.style.background = "none"));
      row.addEventListener("click", () => {
        close();
        scrollHeadingIntoView(container, h);
      });
      pop.appendChild(row);
    }
    document.body.appendChild(pop);

    const r = btn.getBoundingClientRect();
    const w = pop.offsetWidth;
    pop.style.top = Math.round(r.bottom + 4) + "px";
    pop.style.left = Math.round(Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))) + "px";

    // навешиваем закрытие на следующий тик — иначе тот же клик, что открыл, сразу закроет
    setTimeout(() => {
      document.addEventListener("click", onDocClick, true);
      document.addEventListener("keydown", onKey);
      window.addEventListener("resize", close);
    }, 0);
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (pop) close();
    else open();
  });

  return {
    refresh() {
      close();
      btn.style.display = headings().length >= 2 ? "" : "none";
    },
  };
}
