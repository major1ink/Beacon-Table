import { Container, Graphics, Text } from "pixi.js";

// ruler.js — общие визуальные кусочки для двух сценариев: инструмент
// "Линейка" (ПКМ... нет, ЛКМ-драг без переноса токена, см. interaction.js)
// и подсказка дистанции, которая всплывает при обычном перетаскивании
// токена (и у ДМ, и у игрока). Оба сценария рисуют одно и то же: отрезок
// между двумя мировыми точками + подпись с расстоянием — вынесено сюда,
// чтобы не дублировать Graphics/Text-код в interaction.js дважды (ДМ и
// игрок — разные ветки обработчиков мыши).

// createRulerLine — линия + две точки на концах, в мировых координатах;
// толщина линии и радиус точек компенсированы под 1/scale, как у
// сетки/стен (layers/grid.js) — иначе на сильном зуме линия либо тонет,
// либо становится противоестественно толстой.
export function createRulerLine(ctx) {
  const g = new Graphics();
  ctx.world.addChild(g);

  function draw(from, to, color = 0x5dd0ff) {
    const scale = ctx.world.scale.x || 1;
    g.clear();
    g.moveTo(from.x, from.y).lineTo(to.x, to.y).stroke({ width: 2 / scale, color, alpha: 0.9 });
    g.circle(from.x, from.y, 4 / scale).fill({ color, alpha: 0.9 });
    g.circle(to.x, to.y, 4 / scale).fill({ color, alpha: 0.9 });
  }
  function clear() {
    g.clear();
  }
  return { draw, clear };
}

// createDistanceLabel — плавающая табличка с текстом расстояния ("15 фт")
// рядом с точкой в мировых координатах. Сам текст держит постоянный
// ЭКРАННЫЙ размер независимо от зума карты (компенсируем инверсией
// world.scale прямо на контейнере — тот же приём, что 1px-линии сетки,
// только применён к масштабу текста, а не к lineWidth), а позиция —
// мировая, чтобы подпись двигалась вместе с картой при пане/зуме.
export function createDistanceLabel(ctx) {
  const container = new Container();
  const bg = new Graphics();
  const text = new Text({ text: "", style: { fill: 0xffffff, fontSize: 13, fontWeight: "700", fontFamily: "sans-serif" } });
  text.anchor.set(0.5);
  container.addChild(bg, text);
  container.visible = false;
  ctx.world.addChild(container);

  function show(worldX, worldY, str) {
    const scale = ctx.world.scale.x || 1;
    text.text = str;
    text.scale.set(1 / scale);
    const padX = 8 / scale;
    const padY = 4 / scale;
    const w = text.width + padX * 2;
    const h = text.height + padY * 2;
    bg.clear();
    bg.roundRect(-w / 2, -h / 2, w, h, 6 / scale).fill({ color: 0x16161d, alpha: 0.82 });
    container.position.set(worldX, worldY - 18 / scale);
    container.visible = true;
  }
  function hide() {
    container.visible = false;
  }
  return { show, hide };
}
