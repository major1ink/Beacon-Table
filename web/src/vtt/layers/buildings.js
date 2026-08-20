import { Container, Graphics } from "pixi.js";
import { dashedPolyline } from "../dash.js";
import { pointInPolygon } from "../../geometry.js";
import { worldSize } from "../camera.js";

const ROOF_COLOR = 0x06060a;

// Здания (см. domain.Building) — ЗАМКНУТЫЕ контуры (обязательное условие
// проверяется на клике, см. interaction.js: незамкнутая цепочка на сервер
// вообще не отправляется). Контур здания НЕ участвует в raycasting'е (в
// отличие от обычной Wall) — только свет от источников блокируется им, и
// то отдельной булевой обрезкой уже готовых многоугольников, БЕЗ лишних
// лучей (см. vision-fog.js: clipLightByBuildings) — раньше подмешивание
// контура в сам raycasting рисовало от каждого угла здания те же "жёсткие"
// тени, что и у обычных стен, а зданию это не нужно и заметно грузило
// пересчёт. Обзор через стены здания вообще не трогается — прятать
// интерьер снаружи и обзор изнутри — работа ЭТОГО слоя: независимая от
// освещения непрозрачная "крыша" ровно над контуром, скрывающая у игроков
// то, что находится ВНУТРИ (point-in-polygon), даже там, куда обычный
// туман войны/свет в принципе не должен был бы дотягиваться (например, при
// globalLight="bright" или выключенном тумане войны — см. vision-fog.js:
// оба игнорируются ЭТИМ слоем, ровно как manual-fog.js игнорирует их для
// ручного тумана).
//
// ДМ (как и со стенами/ручным туманом) видит контур всегда — как ориентир
// для редактирования, поэтому isDM-ветка ничего не скрывает, только рисует
// пунктирный контур + лёгкую заливку (см. layers/manual-fog.js — тот же
// визуальный язык, чтобы не путать со сплошными линиями стен).
//
// У игрока/TV — два режима, переключаются по факту присутствия токена
// внутри контура (не LOS, просто вкл/выкл):
//  - СНАРУЖИ (ни в одном здании никого): каждое здание — своя непрозрачная
//    "крыша" ровно по контуру, остальная карта — как обычно (обычный
//    туман войны/свет, независимо от этой крыши).
//  - ВНУТРИ (хотя бы в одном здании есть видимый токен): наоборот — вся
//    карта скрывается ЦЕЛИКОМ, кроме контура(ов) занятых зданий (если
//    партия разделилась и стоит в разных зданиях одновременно — видно все
//    занятые). Открытая часть по-прежнему подчиняется обычному
//    туману/свету снизу (см. z-order в index.js — buildings рисуется
//    ПОСЛЕ vision-fog) — просто крыша над ней снята, а не сама область
//    насильно "проявлена".
export function createBuildingsLayer(ctx) {
  const container = new Container();
  const dmOutline = new Graphics();
  const playerRoof = new Graphics();
  container.addChild(dmOutline, playerRoof);

  function occupied(points) {
    const tokens = ctx.scene.tokens || {};
    for (const id in tokens) {
      const t = tokens[id];
      if (t.hidden || t.lightOnly) continue;
      if (pointInPolygon(t.x, t.y, points)) return true;
    }
    return false;
  }

  function rebuild() {
    dmOutline.clear();
    playerRoof.clear();
    const buildings = Object.values(ctx.scene.buildings || {}).filter((b) => b.points.length >= 3);
    if (!buildings.length) return;

    if (ctx.isDM) {
      const scale = ctx.world.scale.x || 1;
      for (const b of buildings) {
        dmOutline.poly(b.points).fill({ color: 0xffb454, alpha: 0.08 });
        dashedPolyline(dmOutline, b.points, 6, 4, true);
      }
      dmOutline.stroke({ width: 2 / scale, color: 0xffb454, alpha: 0.7 });
      // Точки-ручки на каждой вершине — та же идиома, что у стен/тумана (см.
      // layers/walls.js, layers/manual-fog.js), тут же за них хватает мышью
      // interaction.js для переформовки контура — только пока активен сам
      // инструмент "Здание" (вне его правка заблокирована, см. requirement 1).
      if (ctx.tool === "building") {
        for (const b of buildings) {
          for (const p of b.points) {
            dmOutline.circle(p.x, p.y, 5 / scale).fill(0xffffff).stroke({ width: 1.5 / scale, color: 0xffb454 });
          }
        }
      }
      return;
    }

    const occupiedBuildings = buildings.filter((b) => occupied(b.points));

    if (occupiedBuildings.length) {
      // Кто-то из партии зашёл внутрь — прячем ВСЮ карту одной заливкой и
      // вырезаем дыры только под занятыми контурами (poly().cut() —
      // геометрия, тот же приём, что paintMulti в light-geometry.js, не
      // блендмод/маска). Пустующие здания не перечисляем отдельно — они и
      // так уже часть общей заливки, никакой дополнительной крыши им не
      // нужно.
      const { w, h } = worldSize(ctx.scene);
      playerRoof.rect(0, 0, w, h).fill({ color: ROOF_COLOR, alpha: 1 });
      for (const b of occupiedBuildings) playerRoof.poly(b.points).cut();
      return;
    }

    // Снаружи всех зданий — обычный режим: у каждого своя крыша ровно по
    // контуру, остальная карта эту заливку не видит вообще.
    for (const b of buildings) {
      playerRoof.poly(b.points).fill({ color: ROOF_COLOR, alpha: 1 });
    }
  }

  function update() {
    if (!ctx.dirty.buildings) return;
    rebuild();
  }

  return { container, update };
}
