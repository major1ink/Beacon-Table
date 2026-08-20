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
// целиком, ПКМ — меню "удалить точку"). Точки (и сама возможность правки)
// видны, только пока активен инструмент "Стена" (ctx.tool — см. rebuild) —
// вне его стены заблокированы для редактирования, линии остаются просто
// ориентиром.

// Цвет линии по типу сегмента (только для ДМ — см. rebuild): обычная стена —
// как раньше, окно — светлее/прозрачнее (сквозь него видно), дверь/секретная
// дверь — отдельные цвета, чтобы отличать на глаз ДО контекстного меню;
// значок самой двери (открыта/закрыта/заперта) рисует отдельный слой поверх
// — см. layers/doors.js.
const WALL_COLOR = 0x5dd0ff;
const WINDOW_COLOR = 0xbfe8ff;
const DOOR_COLOR = 0xd08a3e;
const SECRET_DOOR_COLOR = 0x9b59b6;

function colorForWall(w) {
  if (w.window) return WINDOW_COLOR;
  if (w.door === "secret") return SECRET_DOOR_COLOR;
  if (w.door === "door") return DOOR_COLOR;
  return WALL_COLOR;
}

export function createWallsLayer(ctx) {
  const container = new Container();
  const g = new Graphics();
  container.addChild(g);

  function rebuild() {
    g.clear();
    if (!ctx.isDM) return;
    const scale = ctx.world.scale.x || 1;
    // Красим КАЖДЫЙ сегмент своим цветом (см. colorForWall) — раньше все
    // стены шли одним moveTo/lineTo-путём с одним общим stroke() в конце;
    // теперь stroke() вызывается на каждой стене отдельно (Graphics это
    // поддерживает — stroke() просто "закрывает" текущий путь заданным
    // стилем и можно тут же начинать следующий moveTo).
    for (const id in ctx.scene.walls) {
      const w = ctx.scene.walls[id];
      g.moveTo(w.x1, w.y1).lineTo(w.x2, w.y2).stroke({ width: 3 / scale, color: colorForWall(w), cap: "round" });
    }
    // Точки-ручки — только пока активен сам инструмент "Стена" (см.
    // interaction.js: там же и вся правка/создание стен теперь гейтится
    // этим инструментом) — вне его стены заблокированы для редактирования,
    // и точки, за которые раньше можно было бы хвататься, только бы путали.
    if (ctx.tool === "wall") {
      for (const v of wallVertices(ctx.scene.walls)) {
        g.circle(v.x, v.y, 5 / scale).fill(0xffffff).stroke({ width: 1.5 / scale, color: 0x5dd0ff });
      }
    }
  }

  function update() {
    if (!ctx.dirty.walls) return;
    rebuild();
  }

  return { container, update };
}
