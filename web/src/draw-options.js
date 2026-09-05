// draw-options.js — панель инструмента «Пометки»: фигура, цвет, толщина
// (+ «Очистить слой» у ДМ). Один компонент на обе роли: у ДМ он живёт в
// рейл-панели «Инструменты», у игрока — во всплывашке под кнопкой топбара,
// но набор инструментов и их поведение одинаковые. Раньше игроку доставался
// урезанный вариант (только выбор фигуры селектом), и это было не решение, а
// недоделка: рисуют за столом все, а разбирать, кто чем может рисовать,
// незачем.
//
// Панель ничего не знает про сам жест рисования — она только сообщает
// выбранное событием "vtt:drawSettings" (см. web/src/vtt/interaction.js:
// drawSettings), тем же приёмом, каким тулбар сообщает инструмент через
// "vtt:setTool".
import { icon } from "./icons.js";
import { attachTooltip, renderWithKeys } from "./tooltip.js";
import { SHAPE_HELP } from "./tool-help.js";

// SHAPES — то, чем можно рисовать. "eraser" — не форма, а режим стирания
// (см. interaction.js: beginDraw), но живёт в том же ряду: для руки это
// такой же выбор «чем я сейчас вожу по карте», и на планшете это
// единственный способ стереть одну пометку — правой кнопки там нет.
const SHAPES = [
  { id: "free", label: "Кисть", glyph: "✏️" },
  { id: "line", label: "Линия", glyph: "╱" },
  { id: "arrow", label: "Стрелка", glyph: "➜" },
  { id: "rect", label: "Прямоугольник", glyph: "▭" },
  { id: "circle", label: "Круг", glyph: "◯" },
  { id: "text", label: "Текст", glyph: "🅣" },
  { id: "eraser", label: "Ластик", glyph: "🩹" },
];

// PALETTE — те же цвета, что и у участников в vtt/layers/drawings.js, плюс
// «свой цвет» первым: пустая строка означает «цвет автора», и тогда пометки
// ДМ белые, а каждого игрока — своего цвета, без всякой договорённости.
const PALETTE = ["", "#ffffff", "#ff7b72", "#ffb454", "#ffd866", "#7ee081", "#5dd0ff", "#c792ea"];

// Пустая shape — не «ничего не выбрано по недосмотру», а РЕЖИМ ПРАВКИ:
// панель открыта, инструмент включён, и рука занята уже нарисованным —
// тянет за точки и линии. Фигура выбирается осознанно и ровно тогда, когда
// человек собрался рисовать новое; повторный клик по ней возвращает правку.
const DEFAULTS = { shape: "", color: "", width: 4 };

// createDrawOptions строит панель внутри mount. onClear — если передан,
// добавляется кнопка «Очистить слой» (у игрока её нет: сервер очистку от
// него всё равно не примет, см. Room.authorize).
export function createDrawOptions(mount, { onClear } = {}) {
  const state = { ...DEFAULTS };

  function push() {
    document.dispatchEvent(new CustomEvent("vtt:drawSettings", { detail: { ...state } }));
  }

  mount.classList.add("draw-options");

  // ---- фигуры ----
  const shapesBlock = document.createElement("div");
  shapesBlock.className = "draw-field";
  shapesBlock.innerHTML = `<span class="draw-field-label">Фигура</span>`;
  const shapesGrid = document.createElement("div");
  shapesGrid.className = "draw-shapes";
  const shapeBtns = new Map();
  for (const shape of SHAPES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "draw-shape";
    btn.innerHTML = `<span class="draw-shape-glyph">${shape.glyph}</span>${shape.label}`;
    btn.onclick = () => setShape(state.shape === shape.id ? "" : shape.id);
    attachTooltip(btn, SHAPE_HELP[shape.id]);
    shapeBtns.set(shape.id, btn);
    shapesGrid.appendChild(btn);
  }
  shapesBlock.appendChild(shapesGrid);

  // mode — строка состояния под фигурами: в какой руке сейчас инструмент.
  // Без неё режим правки читался бы только по отсутствию подсветки, то есть
  // никак.
  const mode = document.createElement("p");
  mode.className = "draw-mode";
  shapesBlock.appendChild(mode);

  // selection — что сейчас выбрано на карте (см. interaction.js:
  // setSelectedDrawing). Пока выбор есть, «Цвет» и «Толщина» правят именно
  // его, а не только будущие пометки, — иначе нарисованное тонкой линией
  // по невнимательности оставалось бы тонким навсегда.
  let selection = null;

  function renderMode() {
    let text;
    if (state.shape) {
      text = "Рисуем новое. Нажми выбранную фигуру ещё раз — вернёшься к правке.";
    } else if (selection) {
      text =
        selection.kind === "text"
          ? "Выбрана подпись: «Цвет» и «Толщина» меняют её прямо сейчас — у текста толщина это размер. [Delete] — стереть."
          : "Выбрана пометка: «Цвет» и «Толщина» меняют её прямо сейчас. [Delete] — стереть.";
    } else {
      text = "Правка: кликни пометку, чтобы менять её цвет и толщину. Тяни за белую точку — переформовать, за линию — перенести.";
    }
    mode.textContent = "";
    renderWithKeys(mode, text);
  }

  function setShape(next) {
    state.shape = next;
    for (const [id, b] of shapeBtns) b.classList.toggle("active", id === next);
    renderMode();
    push();
  }

  // showSelection — подтянуть контролы под выбранную пометку. Молча, без
  // push(): панель тут ОТРАЖАЕТ чужое состояние, а не задаёт своё, и лишняя
  // рассылка вернулась бы обратно правкой той же пометки теми же значениями.
  function showSelection(sel) {
    selection = sel;
    if (sel) {
      state.color = sel.color || "";
      markColor(state.color);
      if (sel.width > 0) {
        state.width = Math.min(24, Math.max(2, sel.width));
        widthInput.value = String(state.width);
      }
    }
    renderMode();
  }
  document.addEventListener("vtt:drawSelection", (e) => showSelection(e.detail || null));

  // ---- цвет ----
  const colorBlock = document.createElement("div");
  colorBlock.className = "draw-field";
  colorBlock.innerHTML = `<span class="draw-field-label">Цвет</span>`;
  const colorRow = document.createElement("div");
  colorRow.className = "draw-colors";
  for (const color of PALETTE) {
    const sw = document.createElement("button");
    sw.type = "button";
    sw.className = "draw-swatch";
    sw.title = color || "Цвет участника (у ДМ — белый)";
    if (color) sw.style.background = color;
    else sw.classList.add("draw-swatch--auto");
    sw.dataset.color = color;
    sw.onclick = () => {
      state.color = color;
      markColor(color);
      push();
    };
    colorRow.appendChild(sw);
  }
  function markColor(color) {
    for (const el of colorRow.children) el.classList.toggle("active", el.dataset.color === color);
  }
  markColor(state.color);
  colorBlock.appendChild(colorRow);

  // ---- толщина ----
  const widthBlock = document.createElement("div");
  widthBlock.className = "draw-field";
  widthBlock.innerHTML = `<span class="draw-field-label">Толщина</span>`;
  const widthInput = document.createElement("input");
  widthInput.type = "range";
  widthInput.min = "2";
  widthInput.max = "24";
  widthInput.step = "1";
  widthInput.value = String(state.width);
  widthInput.oninput = () => {
    state.width = Number(widthInput.value) || DEFAULTS.width;
    push();
  };
  widthBlock.appendChild(widthInput);

  mount.append(shapesBlock, colorBlock, widthBlock);

  if (onClear) {
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "draw-clear";
    clearBtn.innerHTML = `${icon("trash", { size: 14 })} Очистить слой`;
    clearBtn.onclick = onClear;
    attachTooltip(clearBtn, {
      title: "Очистить слой",
      summary: "Стирает со сцены ВСЕ пометки разом — и свои, и игроков. Спросит подтверждение.",
      rows: [["Одну пометку", "«Ластик» или [ПКМ] по ней"]],
    });
    mount.appendChild(clearBtn);
  }

  setShape(state.shape); // начальное состояние строки режима + рассылка настроек

  return {
    // reset — вернуть панель в режим правки (игроку, когда ДМ отобрал право
    // рисовать: возвращаться к инструменту с зажатым ластиком не надо).
    reset() {
      setShape(DEFAULTS.shape);
    },
  };
}
