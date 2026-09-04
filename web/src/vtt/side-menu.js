// createSideMenu — общая вертикальная колонка иконок-кнопок у правого края
// канваса (сейчас: 🔊 громкость в audio.js, 🎲 кубы в pages/dm.js). Каждая
// иконка — своя кнопка + своя панель, открывается КЛИКОМ (не наведением —
// у прежней hover-версии курсор на пути от кнопки к панели часто выходил
// из зоны наведения обеих раньше, чем успевал доехать, и панель
// захлопывалась). Открытие одной панели закрывает другую — тот же принцип,
// что был у старых hover-иконок, просто без самого hover. Клик мимо колонки
// или Esc закрывают текущую открытую.
import { attachTooltip, hideTooltip } from "../tooltip.js";

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
  // openPanelOnCanvas — панель "Пометки" (opts.keepOnCanvas, см. addIcon):
  // канвас для неё не "мимо", а рабочая поверхность — первый же штрих
  // захлопывал бы панель вместе с инструментом. Сюда же попадают модалки:
  // жест инструмента может уходить в диалог (ввод подписи — см.
  // interaction.js: placeDrawingText), и клик по его кнопке — продолжение
  // работы инструментом, а не уход от него. От sticky отличается тем, что
  // Esc и своя иконка панель по-прежнему закрывают: инструмент надо уметь
  // выключить, не целясь в крестик.
  let openPanelOnCanvas = false;
  // openPanelToggle — opts.onToggle текущей открытой панели (см. addIcon):
  // её надо дёрнуть и при закрытии, а закрытие идёт общим closeOpen, который
  // сам не знает, чью панель гасит.
  let openPanelToggle = null;
  function closeOpen() {
    if (openPanel) openPanel.style.display = "none";
    const toggle = openPanelToggle;
    openPanel = null;
    openPanelSticky = false;
    openPanelOnCanvas = false;
    openPanelToggle = null;
    if (toggle) toggle(false);
  }

  // addIcon — заводит кнопку с иконкой + пустую панель рядом с ней (слева,
  // по вертикали посередине кнопки), возвращает панель, чтобы вызывающий
  // код наполнил её своим содержимым (слайдеры, кубы и т.п.). opts.width —
  // необязательная фиксированная ширина панели (px) вместо min-width:190px
  // по умолчанию — нужно панели "Справочник" (дереву категорий тесно).
  // opts.sticky — см. openPanelSticky выше; панель получает .close() — тот
  // же closeOpen, вызывающий код может дать свою кнопку ✕.
  // opts.keepOnCanvas — см. openPanelOnCanvas выше.
  // opts.onToggle(open) — панель открыли/закрыли. Нужно тем иконкам, что
  // не просто показывают плашку, а ВКЛЮЧАЮТ режим на карте (сейчас —
  // "Пометки": открыта панель значит выбран инструмент рисования).
  // iconButton — общая «стеклянная» круглая кнопка колонки; ею пользуются и
  // addIcon (кнопка + своя панель), и addButton (кнопка без панели).
  // opts.tip — структурированная подсказка вместо нативного title (см.
  // web/src/tooltip.js): у иконки колонки нет подписи, и одной строки
  // системного тултипа мало, чтобы объяснить, что за ней. Вешает её не
  // iconButton, а вызывающий: у иконки с панелью подсказка должна молчать,
  // пока панель открыта (см. addIcon), и про это знает только он.
  function iconButton(icon, title) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.innerHTML = icon;
    btn.title = title;
    btn.style.cssText =
      "width:34px;height:34px;border:1px solid var(--glass-border,rgba(255,255,255,0.07));border-radius:999px;" +
      "background:var(--glass-bg,rgba(26,26,34,0.74));backdrop-filter:var(--glass-blur,blur(20px));" +
      "-webkit-backdrop-filter:var(--glass-blur,blur(20px));color:#eee;cursor:pointer;" +
      "display:flex;align-items:center;justify-content:center;box-shadow:var(--shadow-soft,0 4px 16px rgba(0,0,0,0.35));";
    return btn;
  }

  // addButton — иконка колонки БЕЗ панели: клик просто зовёт onClick (журнал
  // стола, см. pages/player.js, открывается плавающим окном, а не выезжающей
  // плашкой). Открытую панель при этом закрываем — как и переход к любой
  // другой иконке колонки.
  function addButton(icon, title, onClick, opts) {
    const btn = iconButton(icon, title);
    if (opts && opts.tip) attachTooltip(btn, opts.tip);
    btn.onclick = () => {
      closeOpen();
      onClick();
    };
    column.appendChild(btn);
    return btn;
  }

  function addIcon(icon, title, opts) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:relative;";
    const btn = iconButton(icon, title);
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
    const keepOnCanvas = !!(opts && opts.keepOnCanvas);
    const onToggle = (opts && opts.onToggle) || null;
    btn.onclick = () => {
      if (openPanel === panel) {
        // sticky-панель по клику на свою же иконку не закрывается — только
        // её кнопкой ✕ (panel.close()), см. комментарий у openPanelSticky.
        if (!sticky) closeOpen();
        return;
      }
      closeOpen();
      panel.style.display = "flex";
      // Гасим подсказку явно, а не надеемся на глобальный mousedown-хук:
      // порядок pointerenter и mousedown у синтезированного клика не
      // гарантирован, и подсказка успевала остаться висеть поверх только
      // что открытой панели — ровно та каша, из-за которой она и молчит,
      // пока панель открыта.
      hideTooltip();
      openPanel = panel;
      openPanelSticky = sticky;
      openPanelOnCanvas = keepOnCanvas;
      openPanelToggle = onToggle;
      if (onToggle) onToggle(true);
    };
    // Пока панель этой иконки открыта, подсказка про неё молчит: она
    // выезжает в ту же сторону и накрывала бы собой ровно то, что описывает.
    if (opts && opts.tip) attachTooltip(btn, () => (openPanel === panel ? null : opts.tip));
    wrap.append(btn, panel);
    column.appendChild(wrap);
    panel.close = closeOpen;
    // host — обёртка иконки целиком. Нужна тем, кто прячет иконку по
    // условию (у игрока «Пометки» появляются, только когда ДМ разрешил
    // рисовать): спрятать одну кнопку мало — у колонки flex-gap, и от
    // пустой обёртки остаётся дыра в ряду.
    panel.host = wrap;
    return panel;
  }

  document.addEventListener("mousedown", (e) => {
    if (!openPanel || openPanelSticky || column.contains(e.target)) return;
    if (openPanelOnCanvas && (e.target === ctx.canvas || e.target.closest?.(".bt-modal-overlay"))) return;
    closeOpen();
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

  return { addIcon, addButton };
}
