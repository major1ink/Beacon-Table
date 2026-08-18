import { Container, Graphics } from "pixi.js";
import { hexToInt } from "../../geometry.js";
import { worldSize } from "../camera.js";

// Сетка клеток — PIXI.Graphics, перестраивается только когда реально
// изменились настройки сетки/размер сцены (dirty.grid) ИЛИ камера (масштаб
// линии держим ~1 экранный пиксель независимо от зума, как в оригинале —
// см. index.js: markCameraDirty). Сама перестройка — дешёвые line-геометрии,
// без пересчёта чего-либо тяжёлого.
//
// highlight — отдельная Graphics для "ручки" редактора сетки (см.
// interaction.js, tool "grid-edit"): один квадрат, подсвеченный красным, за
// который сетку двигают/ресайзят мышью. Рисуется, только пока
// ctx.gridEditActive — независимо от grid.visible (сетку можно
// перенастраивать и когда сами линии скрыты). Саму клетку (какая именно —
// col/row, и её текущий прямоугольник x0/y0/size) целиком считает и держит
// interaction.js в ctx.gridEditHandle (один раз при входе в инструмент — по
// центру вьюпорта, см. gridHandleCell — и дальше двигает/ресайзит вместе с
// драгом); тут её только рисуем как есть. Специально НЕ пересчитываем
// заново от камеры на каждый update() — иначе после переноса сетки клетка,
// которую только что тащили, могла бы перестать быть "ближайшей к центру
// вьюпорта" и подсветка перескочила бы на соседнюю прямо в момент отпускания
// мыши.
export function createGridLayer(ctx) {
  const container = new Container();
  const g = new Graphics();
  const highlight = new Graphics();
  container.addChild(g, highlight);

  function update() {
    g.clear();
    highlight.clear();
    const grid = ctx.scene.grid;
    if (!grid || !grid.size || grid.size <= 0) return;

    const scale = ctx.world.scale.x || 1;

    if (grid.visible !== false) {
      const { w, h } = worldSize(ctx.scene);
      const lineWidth = 1 / scale; // ~1 экранный пиксель независимо от зума
      const color = hexToInt(grid.lineColor, 0xffffff);
      const alpha = grid.lineOpacity == null ? 0.28 : grid.lineOpacity;

      const firstCol = Math.floor(-grid.offsetX / grid.size);
      const lastCol = Math.ceil((w - grid.offsetX) / grid.size);
      for (let i = firstCol; i <= lastCol; i++) {
        const x = grid.offsetX + i * grid.size;
        if (x < 0 || x > w) continue;
        g.moveTo(x, 0).lineTo(x, h);
      }
      const firstRow = Math.floor(-grid.offsetY / grid.size);
      const lastRow = Math.ceil((h - grid.offsetY) / grid.size);
      for (let j = firstRow; j <= lastRow; j++) {
        const y = grid.offsetY + j * grid.size;
        if (y < 0 || y > h) continue;
        g.moveTo(0, y).lineTo(w, y);
      }
      g.stroke({ width: lineWidth, color, alpha });
    }

    const cell = ctx.gridEditActive ? ctx.gridEditHandle : null;
    if (!cell) return;
    highlight.rect(cell.x0, cell.y0, cell.size, cell.size).fill({ color: 0xff3b3b, alpha: 0.32 });
    highlight.rect(cell.x0, cell.y0, cell.size, cell.size).stroke({ width: 2 / scale, color: 0xff3b3b, alpha: 0.95 });
  }

  return { container, update };
}
