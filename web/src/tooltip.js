// tooltip.js — всплывающая подсказка инструмента: заголовок и строки
// «метка: значение», где клавиши и кнопки мыши выделены чипами.
//
// Зачем не нативный title. Браузерный тултип — одна строка серым по
// системному фону, без структуры и с задержкой, на которую нельзя влиять.
// У инструмента карты сказать надо больше: что он делает, каким жестом
// рисуется новое, каким правится старое, чем отменяется. Раньше это лежало
// абзацами-подсказками прямо в панели («ЛКМ таскает токены и точки
// стен/зданий…»), то есть стеной текста, которую читают один раз и
// перестают замечать. Тут — то же содержимое, но разложенное по строкам и
// показываемое ровно тогда, когда навёл на конкретный инструмент.
//
// Панель одна на страницу и живёт в body с position:fixed: подсказка обязана
// вылезать за пределы своего контейнера (иконки боковой колонки лежат в
// панели с overflow-y:auto, которая обрезала бы её).

// SHOW_DELAY — сколько ждать до показа. Достаточно, чтобы подсказка не
// мигала, пока курсор просто проезжает по ряду иконок, и достаточно мало,
// чтобы не ждать её осознанно.
const SHOW_DELAY = 320;

let tipEl = null;
let showTimer = null;
let currentAnchor = null;

function ensureEl() {
  if (tipEl) return tipEl;
  tipEl = document.createElement("div");
  tipEl.className = "bt-tip";
  tipEl.setAttribute("role", "tooltip");
  document.body.appendChild(tipEl);
  return tipEl;
}

// appendValue — текст значения с чипами клавиш: всё, что в квадратных
// скобках, становится <kbd> ("[Ctrl] + [ЛКМ] и протяжка"). Собираем узлами,
// а не innerHTML — подсказки задаются в коде, но экранирование тут бесплатно.
function appendValue(host, text) {
  for (const part of String(text).split(/(\[[^\]]+\])/)) {
    if (!part) continue;
    if (part.startsWith("[") && part.endsWith("]")) {
      const key = document.createElement("kbd");
      key.className = "bt-tip-key";
      key.textContent = part.slice(1, -1);
      host.appendChild(key);
    } else {
      host.appendChild(document.createTextNode(part));
    }
  }
}

function render(spec) {
  const el = ensureEl();
  el.textContent = "";
  if (spec.title) {
    const title = document.createElement("div");
    title.className = "bt-tip-title";
    title.textContent = spec.title;
    el.appendChild(title);
  }
  if (spec.summary) {
    const summary = document.createElement("div");
    summary.className = "bt-tip-summary";
    appendValue(summary, spec.summary);
    el.appendChild(summary);
  }
  for (const [label, value] of spec.rows || []) {
    const row = document.createElement("div");
    row.className = "bt-tip-row";
    const key = document.createElement("span");
    key.className = "bt-tip-label";
    key.textContent = label + ":";
    const val = document.createElement("span");
    val.className = "bt-tip-value";
    appendValue(val, value);
    row.append(key, val);
    el.appendChild(row);
  }
  return el;
}

// place — сбоку от иконки, по вертикали по её центру. Сторону выбираем по
// тому, где больше места: колонка инструментов может стоять и у левого края
// (рейл ДМ), и у правого (боковая колонка над канвасом).
function place(el, anchor) {
  const gap = 10;
  const margin = 8;
  const rect = anchor.getBoundingClientRect();
  const { width, height } = el.getBoundingClientRect();

  const fitsLeft = rect.left - gap - width >= margin;
  const preferLeft = rect.left > window.innerWidth / 2;
  const left = preferLeft && fitsLeft ? rect.left - gap - width : rect.right + gap;

  let top = rect.top + rect.height / 2 - height / 2;
  top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));

  el.style.left = Math.round(Math.max(margin, Math.min(left, window.innerWidth - width - margin))) + "px";
  el.style.top = Math.round(top) + "px";
}

function hide() {
  clearTimeout(showTimer);
  showTimer = null;
  currentAnchor = null;
  if (tipEl) tipEl.classList.remove("open");
}

function show(anchor, spec) {
  const resolved = typeof spec === "function" ? spec() : spec;
  // Пустой spec — «сейчас подсказка неуместна». Так иконка боковой колонки
  // молчит, пока её собственная панель открыта: рассказывать про панель,
  // наполовину накрыв её же собой, — хуже, чем не рассказывать вовсе.
  if (!resolved) {
    hide();
    return;
  }
  currentAnchor = anchor;
  const el = render(resolved);
  // Показать до замера: у скрытой панели нулевые размеры, и place() положил
  // бы её мимо.
  el.classList.add("open");
  place(el, anchor);
}

// Подсказка не должна пережить то, к чему прицеплена: панель могли закрыть,
// инструмент — переключить, страницу — прокрутить.
window.addEventListener("scroll", hide, true);
window.addEventListener("resize", hide);
document.addEventListener("mousedown", hide, true);

// attachTooltip — повесить подсказку на элемент. spec: {title, summary, rows}
// либо функция, возвращающая такой объект (когда содержимое зависит от
// состояния) или null (когда показывать не надо — см. show).
// Возвращает функцию отцепления.
export function attachTooltip(el, spec) {
  if (!el) return () => {};
  // Нативный title убираем: иначе поверх нашей панели вылезет ещё и
  // браузерный, с тем же текстом и другой задержкой.
  el.removeAttribute("title");

  const onEnter = (e) => {
    // На тач-устройствах подсказки по наведению не бывает — там палец сразу
    // нажимает, и панель только мешала бы попасть по кнопке.
    if (e.pointerType === "touch") return;
    clearTimeout(showTimer);
    showTimer = setTimeout(() => show(el, spec), SHOW_DELAY);
  };
  const onLeave = () => {
    if (currentAnchor === el || showTimer) hide();
  };
  const onFocus = () => show(el, spec);

  el.addEventListener("pointerenter", onEnter);
  el.addEventListener("pointerleave", onLeave);
  el.addEventListener("focus", onFocus);
  el.addEventListener("blur", onLeave);

  return () => {
    el.removeEventListener("pointerenter", onEnter);
    el.removeEventListener("pointerleave", onLeave);
    el.removeEventListener("focus", onFocus);
    el.removeEventListener("blur", onLeave);
    if (currentAnchor === el) hide();
  };
}

export { hide as hideTooltip };
