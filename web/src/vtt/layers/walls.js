import { Container, Graphics } from "pixi.js";
import { wallVertices } from "../../geometry.js";

// Стены — видны только ДМ (как ориентир для редактирования; LOS считает по
// ним layers/vision-fog.js для не-ДМ, но саму линию рисуют только ДМ, у
// игрока вместо этого рисуется затемнение — см. draw() в старом app.js:
// role-зависимая ветка "walls либо vision fog"). Пересчитывается только по
// dirty.walls.
//
// Поверх линий рисуются кружки-ручки на каждой уникальной вершине
// (wallVertices — концы стен, сгруппированные по совпадению координат) —
// видимые точки, за которые ДМ хватает мышью в interaction.js (драг угла
// целиком, ПКМ — меню "удалить точку").
export function createWallsLayer(ctx) {
  const container = new Container();
  const g = new Graphics();
  container.addChild(g);

  function rebuild() {
    g.clear();
    if (!ctx.isDM) return;
    const scale = ctx.world.scale.x || 1;
    for (const id in ctx.scene.walls) {
      const w = ctx.scene.walls[id];
      g.moveTo(w.x1, w.y1).lineTo(w.x2, w.y2);
    }
    g.stroke({ width: 3 / scale, color: 0x5dd0ff, cap: "round" });
    for (const v of wallVertices(ctx.scene.walls)) {
      g.circle(v.x, v.y, 5 / scale).fill(0xffffff).stroke({ width: 1.5 / scale, color: 0x5dd0ff });
    }
  }

  function update() {
    if (!ctx.dirty.walls) return;
    rebuild();
  }

  return { container, update };
}
