// a11y.js — кликабельные <div>, которым <button> не подошёл по вёрстке
// (плитка с фоном-картинкой, строка со своей кнопкой удаления внутри): без
// этого с клавиатуры до них не добраться. Образец — колонка страниц журнала
// (pages/journal.js), где то же сделано вручную.

export function asButton(el, label) {
  el.setAttribute("role", "button");
  if (!el.hasAttribute("tabindex")) el.tabIndex = 0;
  if (label && !el.hasAttribute("aria-label")) el.setAttribute("aria-label", label);
  el.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    // Пробел на элементе с role="button" иначе прокручивает страницу.
    e.preventDefault();
    el.click();
  });
  return el;
}
