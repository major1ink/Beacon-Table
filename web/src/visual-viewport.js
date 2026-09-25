// visual-viewport.js — видимая часть экрана над экранной клавиатурой.
//
// Android Chrome с interactive-widget=resizes-content (meta viewport всех
// страниц) под клавиатуру сжимает саму страницу, и 100dvh уже честные. iOS
// Safari так не умеет: страница остаётся прежней высоты, клавиатура ложится
// поверх, и поле ввода внизу полноэкранного чата оказывается под ней. Там
// сжимается только visualViewport — его размер и сдвиг кладём в --vv-h /
// --vv-top на :root, по ним встают полноэкранные слои телефона (чат,
// плавающие окна, лист персонажа — см. theme.css, floating-window.js,
// sheet-dock.js). Без поддержки API переменные не ставятся, и слои берут
// запасное значение (100dvh / 0).
export function initVisualViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement.style;
  const sync = () => {
    root.setProperty("--vv-h", vv.height + "px");
    root.setProperty("--vv-top", vv.offsetTop + "px");
  };
  vv.addEventListener("resize", sync);
  vv.addEventListener("scroll", sync);
  sync();
}
