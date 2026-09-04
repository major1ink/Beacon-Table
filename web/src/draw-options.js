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

// SHAPES — то, чем можно рисовать. "eraser" — не форма, а режим стирания
// (см. interaction.js: beginDraw), но живёт в том же ряду: для руки это
// такой же выбор «чем я сейчас вожу по карте», и на планшете это
// единственный способ стереть одну пометку — правой кнопки там нет.
const SHAPES = [
  { id: "free", label: "Кисть", glyph: "✏️", title: "Свободная кисть" },
  { id: "line", label: "Линия", glyph: "╱", title: "Прямая линия" },
  { id: "arrow", label: "Стрелка", glyph: "➜", title: "Стрелка — от начала протяжки к концу" },
  { id: "rect", label: "Прямоугольник", glyph: "▭", title: "Прямоугольник по двум углам" },
  { id: "circle", label: "Круг", glyph: "◯", title: "Круг от центра наружу" },
  { id: "text", label: "Текст", glyph: "🅣", title: "Подпись — клик по карте, текст спросим в окне" },
  { id: "eraser", label: "Ластик", glyph: "🩹", title: "Стереть пометку — клик или протяжка по ней" },
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
    btn.title = shape.title;
    btn.innerHTML = `<span class="draw-shape-glyph">${shape.glyph}</span>${shape.label}`;
    btn.onclick = () => setShape(state.shape === shape.id ? "" : shape.id);
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

  function setShape(next) {
    state.shape = next;
    for (const [id, b] of shapeBtns) b.classList.toggle("active", id === next);
    mode.textContent = next
      ? "Рисуем новое. Нажми выбранную фигуру ещё раз — вернёшься к правке."
      : "Правка: тяни за белую точку — переформовать, за саму линию — перенести, двойной клик по подписи — сменить текст.";
    push();
  }

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
    sw.onclick = () => {
      state.color = color;
      for (const el of colorRow.children) el.classList.toggle("active", el === sw);
      push();
    };
    colorRow.appendChild(sw);
  }
  colorRow.firstChild.classList.add("active");
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
    clearBtn.title = "Стереть со сцены все пометки — и свои, и игроков";
    clearBtn.innerHTML = `${icon("trash", { size: 14 })} Очистить слой`;
    clearBtn.onclick = onClear;
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
