import { Container, Graphics } from "pixi.js";
import { worldSize } from "../camera.js";

// Зона показа игрокам (domain.SceneState.ViewZone) — один слой на две роли:
//
//  - игрок и трансляция: прямоугольник зоны — маска всего мира. Всё, что
//    снаружи (фон, токены, туман, пометки), отрезано геометрически, а не
//    затемнено — иначе край карты читался бы сквозь тьму. Камера за зону
//    не выпускает сама (camera.js: clampCamera), маска — на случай, когда
//    экран шире зоны и в letterbox-полях мог бы проступить фон;
//  - ДМ: карта целиком, зона — пунктирная рамка и лёгкое затемнение
//    снаружи, чтобы было видно, что игрокам не достаётся. Пока ДМ тянет
//    новую зону инструментом «view-zone» (interaction.js), черновик лежит в
//    ctx.viewZoneDraft и рисуется вместо сохранённой.
//
// Толщина рамки — экранная (делится на scale), поэтому слой перерисовывается
// и на пан/зум: interaction.js: markCameraDirty ставит dirty.grid, его тут
// и слушаем, свой бит dirty.viewZone — на смену самой зоны.
export function createViewZoneLayer(ctx) {
  const container = new Container();
  const g = new Graphics();
  container.addChild(g);
  let maskedKey = "";

  function zoneRect() {
    if (ctx.isDM && ctx.viewZoneDraft) return ctx.viewZoneDraft;
    const z = ctx.scene.viewZone;
    return z && z.w > 0 && z.h > 0 ? z : null;
  }

  function update() {
    if (!ctx.dirty.viewZone && !ctx.dirty.grid) return;
    const z = zoneRect();
    if (!ctx.isDM) {
      // Маска: перестраиваем только когда зона реально сменилась — Graphics
      // в роли маски дёргать на каждый пан незачем.
      const key = z ? [z.x, z.y, z.w, z.h].join(",") : "";
      if (key === maskedKey) return;
      maskedKey = key;
      g.clear();
      if (!z) {
        ctx.world.mask = null;
        return;
      }
      g.rect(z.x, z.y, z.w, z.h).fill({ color: 0xffffff });
      ctx.world.mask = g;
      return;
    }
    g.clear();
    if (!z) return;
    const scale = ctx.world.scale.x || 1;
    const { w, h } = worldSize(ctx.scene);
    // Затемнение снаружи — четыре полосы вокруг зоны, без наложений.
    const dim = { color: 0x000000, alpha: 0.35 };
    if (z.y > 0) g.rect(0, 0, w, z.y).fill(dim);
    if (z.y + z.h < h) g.rect(0, z.y + z.h, w, h - z.y - z.h).fill(dim);
    if (z.x > 0) g.rect(0, z.y, z.x, z.h).fill(dim);
    if (z.x + z.w < w) g.rect(z.x + z.w, z.y, w - z.x - z.w, z.h).fill(dim);
    // Пунктирная рамка: у Pixi нет штриха, режем сами отрезками по 10px экрана.
    const dash = 10 / scale;
    const edges = [
      [z.x, z.y, z.x + z.w, z.y],
      [z.x + z.w, z.y, z.x + z.w, z.y + z.h],
      [z.x + z.w, z.y + z.h, z.x, z.y + z.h],
      [z.x, z.y + z.h, z.x, z.y],
    ];
    for (const [x1, y1, x2, y2] of edges) {
      const len = Math.hypot(x2 - x1, y2 - y1);
      const ux = (x2 - x1) / (len || 1);
      const uy = (y2 - y1) / (len || 1);
      for (let d = 0; d < len; d += dash * 2) {
        const e = Math.min(d + dash, len);
        g.moveTo(x1 + ux * d, y1 + uy * d).lineTo(x1 + ux * e, y1 + uy * e);
      }
    }
    g.stroke({ width: 2 / scale, color: ctx.viewZoneDraft ? 0xffd166 : 0x7c6cf0, alpha: 0.95 });
  }

  return { container, update };
}
