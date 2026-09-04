import { Container, Graphics, Text } from "pixi.js";

// board/render.js — отрисовка сцены Excalidraw на холсте доски.
//
// ЧЕГО ЭТОТ РЕНДЕР НЕ ДЕЛАЕТ, и это осознанно:
//
//   - не рисует «от руки». У Excalidraw фигуры рисуются через rough.js:
//     каждая линия — несколько дрожащих штрихов, посчитанных от element.seed.
//     Повторять это значило бы тянуть rough.js и воспроизводить их генератор
//     штрихов; вместо этого фигуры рисуются ровными. Геометрия, цвета и
//     расположение при этом те же самые, отличается «почерк».
//   - не рисует картинки и встроенные заметки: их содержимое лежит файлами
//     ваулта Obsidian, которых у стола нет. Вместо них — рамка с подписью,
//     чтобы место на доске не пропало и было видно, что там было.
//   - не воспроизводит привязки стрелок к фигурам: стрелка рисуется по своим
//     точкам, как её сохранил Excalidraw. Пока элементы не двигают, это
//     ровно то же самое.
//
// Всё перечисленное при этом СОХРАНЯЕТСЯ в файле нетронутым (см.
// internal/excalidraw): не нарисовать — не значит потерять.

// FONTS — соответствие excalidraw fontFamily. 1 — их рукописный Virgil,
// которого у нас нет: подменяется обычным гротеском, как и всё остальное.
const FONTS = {
  1: "Segoe UI, -apple-system, sans-serif",
  2: "Helvetica, Arial, sans-serif",
  3: "Cascadia Code, Consolas, monospace",
};

const TRANSPARENT = "transparent";

function toInt(color, fallback = 0x000000) {
  if (!color || color === TRANSPARENT) return fallback;
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (m) return parseInt(m[1], 16);
  const short = /^#?([0-9a-f]{3})$/i.exec(color.trim());
  if (short) {
    const [r, g, b] = short[1].split("");
    return parseInt(r + r + g + g + b + b, 16);
  }
  return fallback;
}

function alphaOf(el) {
  const o = typeof el.opacity === "number" ? el.opacity : 100;
  return Math.max(0, Math.min(1, o / 100));
}

function strokeStyle(el) {
  return {
    width: el.strokeWidth > 0 ? el.strokeWidth : 1,
    color: toInt(el.strokeColor, 0x1e1e1e),
    alpha: alphaOf(el),
    cap: "round",
    join: "round",
  };
}

// fillOf — заливка, если она есть. fillStyle у Excalidraw бывает hachure и
// cross-hatch (штриховка); ровной заливкой их не изобразить, поэтому такие
// приглушаются прозрачностью — так пятно читается как «залито штриховкой», а
// не как сплошной цвет поверх соседей.
function fillOf(el) {
  if (!el.backgroundColor || el.backgroundColor === TRANSPARENT) return null;
  const solid = el.fillStyle === "solid";
  return { color: toInt(el.backgroundColor, 0xffffff), alpha: alphaOf(el) * (solid ? 1 : 0.45) };
}

// ARROWHEAD_LEN — длина наконечника. Excalidraw считает её от длины стрелки и
// толщины линии; здесь достаточно того, чтобы она была видна и не съедала
// короткую стрелку.
function arrowhead(g, from, to, style) {
  const angle = Math.atan2(to[1] - from[1], to[0] - from[0]);
  const len = Math.max(style.width * 4, 12);
  for (const side of [-1, 1]) {
    const a = angle + Math.PI + side * 0.45;
    g.moveTo(to[0], to[1]).lineTo(to[0] + Math.cos(a) * len, to[1] + Math.sin(a) * len);
  }
  g.stroke(style);
}

// drawShape — фигура в СОБСТВЕННЫХ координатах элемента (0,0 — его левый
// верхний угол). Сдвиг и поворот делает вызывающий через контейнер: так
// поворот вокруг центра получается сам собой, без матричной арифметики на
// каждую точку.
function drawShape(g, el) {
  const style = strokeStyle(el);
  const fill = fillOf(el);
  const w = el.width || 0;
  const h = el.height || 0;

  switch (el.type) {
    case "rectangle": {
      // roundness !== null у Excalidraw означает скруглённые углы; конкретный
      // радиус у них считается от размера, тут достаточно похожего.
      const r = el.roundness ? Math.min(32, Math.min(Math.abs(w), Math.abs(h)) * 0.25) : 0;
      if (r > 0) g.roundRect(0, 0, w, h, r);
      else g.rect(0, 0, w, h);
      break;
    }
    case "ellipse":
      g.ellipse(w / 2, h / 2, Math.abs(w) / 2, Math.abs(h) / 2);
      break;
    case "diamond":
      g.poly([w / 2, 0, w, h / 2, w / 2, h, 0, h / 2]);
      break;
    case "frame":
      // Рамка-группировщик: пунктиром её не отличить от обычного
      // прямоугольника без лишнего кода, поэтому просто бледный контур.
      g.rect(0, 0, w, h);
      g.stroke({ width: 1.5, color: 0x9a9a9a, alpha: 0.7 });
      return;
    case "image":
    case "embeddable":
      // Содержимого нет (см. шапку файла) — показываем место и границу.
      g.rect(0, 0, w, h);
      g.fill({ color: 0xffffff, alpha: 0.05 });
      g.stroke({ width: 1.5, color: 0x8a8a8a, alpha: 0.8 });
      return;
    case "line":
    case "arrow":
    case "freedraw": {
      const pts = el.points || [];
      if (pts.length < 2) return;
      g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
      if (fill && el.type !== "arrow") g.fill(fill);
      g.stroke(style);
      if (el.type === "arrow") {
        if (el.endArrowhead) arrowhead(g, pts[pts.length - 2], pts[pts.length - 1], style);
        if (el.startArrowhead) arrowhead(g, pts[1], pts[0], style);
      }
      return;
    }
    default:
      // Незнакомый тип: рисуем габарит, чтобы место на доске не пропало
      // молча. Сам элемент при этом сохранён целиком (см. Extra в
      // internal/excalidraw).
      if (!w || !h) return;
      g.rect(0, 0, w, h);
      g.stroke({ width: 1, color: 0x666666, alpha: 0.6 });
      return;
  }
  if (fill) g.fill(fill);
  g.stroke(style);
}

// label — подпись под заглушкой картинки/заметки и имя фрейма.
function label(text, size, color) {
  const t = new Text({
    text,
    style: { fill: color, fontSize: size, fontFamily: FONTS[2], wordWrap: false },
  });
  return t;
}

// renderScene рисует сцену в контейнер, возвращая границы содержимого
// (нужны, чтобы вписать доску в экран при открытии).
export function renderScene(container, scene) {
  container.removeChildren().forEach((c) => c.destroy({ children: true }));
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  if (!scene || !Array.isArray(scene.elements)) return bounds;

  // Порядок отрисовки — как в файле: Excalidraw хранит элементы уже
  // отсортированными по своему дробному index.
  for (const el of scene.elements) {
    if (!el || el.isDeleted) continue;

    const node = new Container();
    node.position.set(el.x || 0, el.y || 0);
    if (el.angle) {
      // Поворот у Excalidraw — вокруг центра элемента.
      node.pivot.set((el.width || 0) / 2, (el.height || 0) / 2);
      node.position.set((el.x || 0) + (el.width || 0) / 2, (el.y || 0) + (el.height || 0) / 2);
      node.rotation = el.angle;
    }

    if (el.type === "text") {
      const t = new Text({
        // Именно text, а не originalText: Excalidraw хранит в нём текст УЖЕ
        // разбитым по строкам так, как он влезал в свою рамку, а в
        // originalText/rawText — сплошную строку для поиска в Obsidian.
        // Рисовать надо первое, иначе подпись вылезает за свою фигуру.
        text: el.text || el.rawText || el.originalText || "",
        style: {
          fill: toInt(el.strokeColor, 0x1e1e1e),
          fontSize: el.fontSize || 20,
          fontFamily: FONTS[el.fontFamily] || FONTS[2],
          align: el.textAlign || "left",
          lineHeight: el.lineHeight ? el.lineHeight * (el.fontSize || 20) : undefined,
          wordWrap: false,
        },
      });
      t.alpha = alphaOf(el);
      node.addChild(t);
    } else {
      const g = new Graphics();
      drawShape(g, el);
      node.addChild(g);
      if (el.type === "image" || el.type === "embeddable") {
        const caption = el.type === "image" ? "картинка ваулта" : "заметка ваулта";
        const t = label(caption, 13, 0x9a9a9a);
        t.position.set(8, 8);
        node.addChild(t);
      }
      if (el.type === "frame" && el.name) {
        const t = label(el.name, 14, 0x9a9a9a);
        t.position.set(0, -20);
        node.addChild(t);
      }
    }

    container.addChild(node);

    const x = el.x || 0;
    const y = el.y || 0;
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x + (el.width || 0));
    bounds.maxY = Math.max(bounds.maxY, y + (el.height || 0));
  }

  if (!isFinite(bounds.minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return bounds;
}
