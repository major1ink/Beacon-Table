import { Container, Graphics, BlurFilter } from "pixi.js";
import { dashedPolyline } from "../dash.js";

// Ручной "туман-фигурами" — DM обводит область произвольной формы, и она
// гарантированно скрыта у игроков ДАЖЕ если туда дотягивается LOS токена
// (постоянный оверрайд DM). У игроков рисуется как мягкое облако (GPU-блюр +
// лёгкая живая пульсация альфы), у DM — пунктирный контур для ориентира.
//
// Вторая половина "корневого фикса": в Canvas2D-версии ctx.filter =
// "blur(12px)" — CPU/software-фильтр, пересчитывался на каждый кадр видео
// вместе с LOS (см. layers/vision-fog.js). Тут два независимых механизма:
//  - геометрия (сам путь полигонов) перестраивается только по
//    dirty.manualFog — когда фигуры реально добавили/убрали/сдвинули;
//  - пульсация альфы — как и раньше, по таймеру ~120мс (не 60fps), но
//    перерисовывает ТОЛЬКО альфу заливки по уже готовому кэшу точек, не
//    трогая геометрию; сам блюр — GPU-шейдер (PIXI.BlurFilter), а не
//    CPU-путь, поэтому даже с тем же таймингом стоит на порядки дешевле.
export function createManualFogLayer(ctx) {
  const container = new Container();
  const dmOutline = new Graphics();
  const playerFill = new Graphics();
  const blur = new BlurFilter({ strength: 12, quality: 4 });
  playerFill.filters = [blur];
  container.addChild(dmOutline, playerFill);

  let cachedAreas = []; // [[{x,y},...], ...] — точки текущих фигур, для дешёвой перерисовки пульса
  let pulseTimer = null;

  function rebuild() {
    dmOutline.clear();
    playerFill.clear();
    cachedAreas = [];
    const areas = Object.values(ctx.scene.fogAreas || {});
    if (!areas.length) return;

    if (ctx.isDM) {
      const scale = ctx.world.scale.x || 1;
      for (const area of areas) {
        if (area.points.length < 3) continue;
        dmOutline.poly(area.points).fill({ color: 0x8bc3ff, alpha: 0.08 });
        dashedPolyline(dmOutline, area.points, 6, 4, true);
      }
      dmOutline.stroke({ width: 2 / scale, color: 0x8bc3ff, alpha: 0.6 });
      // Кружки-ручки на каждой вершине — та же идиома, что у стен (см.
      // layers/walls.js), тут же за них хватает мышью interaction.js для
      // переформовки/переноса фигуры (сейчас можно было только удалить
      // фигуру целиком и обвести заново).
      for (const area of areas) {
        if (area.points.length < 3) continue;
        for (const p of area.points) {
          dmOutline.circle(p.x, p.y, 5 / scale).fill(0xffffff).stroke({ width: 1.5 / scale, color: 0x8bc3ff });
        }
      }
      return;
    }

    for (const area of areas) {
      if (area.points.length < 3) continue;
      cachedAreas.push(area.points);
    }
    paintPulse();
  }

  // paintPulse — перерисовывает playerFill из УЖЕ известной геометрии
  // (cachedAreas) с текущей фазой пульсации альфы. Не трогает
  // computeVisibilityPolygon/стены/токены — только альфа заливки.
  function paintPulse() {
    if (ctx.isDM) return;
    playerFill.clear();
    if (!cachedAreas.length) return;
    const pulse = 0.88 + Math.sin(ctx.now() / 1400) * 0.06;
    for (const points of cachedAreas) {
      playerFill.poly(points).fill({ color: 0x14161e, alpha: pulse });
    }
  }

  function ensureAnim() {
    const shouldAnimate = !ctx.isDM && cachedAreas.length > 0;
    if (shouldAnimate && !pulseTimer) {
      pulseTimer = setInterval(paintPulse, 120);
    } else if (!shouldAnimate && pulseTimer) {
      clearInterval(pulseTimer);
      pulseTimer = null;
    }
  }

  function update() {
    if (ctx.dirty.manualFog) rebuild();
    ensureAnim();
  }

  return { container, update };
}
