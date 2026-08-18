// createSideMenu — общая вертикальная колонка иконок-кнопок у правого края
// канваса (сейчас: 🔊 громкость в audio.js, 🎲 кубы в pages/dm.js). Каждая
// иконка — своя кнопка + своя панель, открывается КЛИКОМ (не наведением —
// у прежней hover-версии курсор на пути от кнопки к панели часто выходил
// из зоны наведения обеих раньше, чем успевал доехать, и панель
// захлопывалась). Открытие одной панели закрывает другую — тот же принцип,
// что был у старых hover-иконок, просто без самого hover. Клик мимо колонки
// или Esc закрывают текущую открытую.
export function createSideMenu(ctx) {
  const column = document.createElement("div");
  column.style.cssText = "position:fixed;z-index:41;display:flex;flex-direction:column;gap:8px;transform:translateY(-50%);";
  document.body.appendChild(column);

  let openPanel = null;
  // openPanelSticky — панель "Справочник" (opts.sticky, см. addIcon) не
  // должна пропадать от клика мимо колонки/Esc: пока дерево открыто,
  // пользователь кликает по только что открытым окнам-спискам (это
  // отдельные floating window, не часть column, см. floating-window.js), и
  // без этого флага обычный клик снаружи колонки захлопывал бы дерево
  // посреди работы. Закрывается такая панель только своей кнопкой ✕ внутри
  // (см. compendium-menu.js), которая зовёт panel.close() — тот же closeOpen.
  let openPanelSticky = false;
  function closeOpen() {
    if (openPanel) openPanel.style.display = "none";
    openPanel = null;
    openPanelSticky = false;
  }

  // addIcon — заводит кнопку с иконкой + пустую панель рядом с ней (слева,
  // по вертикали посередине кнопки), возвращает панель, чтобы вызывающий
  // код наполнил её своим содержимым (слайдеры, кубы и т.п.). opts.width —
  // необязательная фиксированная ширина панели (px) вместо min-width:190px
  // по умолчанию — нужно панели "Справочник" (дереву категорий тесно).
  // opts.sticky — см. openPanelSticky выше; панель получает .close() — тот
  // же closeOpen, вызывающий код может дать свою кнопку ✕.
  function addIcon(icon, title, opts) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:relative;";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.innerHTML = icon;
    btn.title = title;
    btn.style.cssText =
      "width:34px;height:34px;border:1px solid var(--glass-border,rgba(255,255,255,0.07));border-radius:999px;" +
      "background:var(--glass-bg,rgba(26,26,34,0.74));backdrop-filter:var(--glass-blur,blur(20px));" +
      "-webkit-backdrop-filter:var(--glass-blur,blur(20px));color:#eee;cursor:pointer;" +
      "display:flex;align-items:center;justify-content:center;box-shadow:var(--shadow-soft,0 4px 16px rgba(0,0,0,0.35));";
    const panel = document.createElement("div");
    panel.style.cssText =
      "display:none;flex-direction:column;gap:8px;position:absolute;right:calc(100% + 8px);top:50%;" +
      "transform:translateY(-50%);background:var(--glass-bg-strong,rgba(22,22,29,0.88));" +
      "backdrop-filter:var(--glass-blur,blur(20px));-webkit-backdrop-filter:var(--glass-blur,blur(20px));" +
      "border:1px solid var(--glass-border,rgba(255,255,255,0.07));border-radius:var(--radius-lg,16px);padding:10px 12px;" +
      "min-width:190px;max-height:calc(100vh - 20px);overflow-y:auto;box-shadow:var(--shadow-float,0 12px 32px rgba(0,0,0,0.45));";
    if (opts && opts.width) {
      panel.style.width = opts.width + "px";
      panel.style.minWidth = opts.width + "px";
    }
    const sticky = !!(opts && opts.sticky);
    btn.onclick = () => {
      if (openPanel === panel) {
        // sticky-панель по клику на свою же иконку не закрывается — только
        // её кнопкой ✕ (panel.close()), см. комментарий у openPanelSticky.
        if (!sticky) closeOpen();
        return;
      }
      closeOpen();
      panel.style.display = "flex";
      openPanel = panel;
      openPanelSticky = sticky;
    };
    wrap.append(btn, panel);
    column.appendChild(wrap);
    panel.close = closeOpen;
    return panel;
  }

  document.addEventListener("mousedown", (e) => {
    if (openPanel && !openPanelSticky && !column.contains(e.target)) closeOpen();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !openPanelSticky) closeOpen();
  });

  // Позиция — правый край канваса (не viewport), по вертикали посередине.
  function position() {
    const rect = ctx.canvas.getBoundingClientRect();
    column.style.left = Math.round(rect.right - 44) + "px";
    column.style.top = Math.round(rect.top + rect.height / 2) + "px";
  }
  position();
  window.addEventListener("resize", position);
  new ResizeObserver(position).observe(ctx.canvas);

  return { addIcon };
}
