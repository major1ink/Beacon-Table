import { Container, Graphics } from "pixi.js";

// Анимация атаки — чисто визуальный слой поверх токенов, в state не
// пишется. Перенос spawnFx/tickFx/drawFx: вместо ручного
// requestAnimationFrame используется app.ticker (см. index.js — ctx.app),
// который сам не крутится, пока список пуст (add/remove колбэка на тикер, а
// не постоянно работающий цикл с проверкой "есть ли что анимировать").
export function createFxLayer(ctx) {
  const container = new Container();
  let fxList = [];
  let tickerAttached = false;

  function drawOne(g, fx, t) {
    // "бросок" — снаряд летит от атакующего к цели, на 80% дороги гаснет вспышкой
    const px = fx.fromX + (fx.toX - fx.fromX) * Math.min(1, t / 0.8);
    const py = fx.fromY + (fx.toY - fx.fromY) * Math.min(1, t / 0.8);
    const color = fx.color ? parseColor(fx.color) : 0xff5555;

    g.moveTo(fx.fromX, fx.fromY).lineTo(px, py).stroke({ width: 3, color });

    if (t > 0.75) {
      const flashT = (t - 0.75) / 0.25; // 0..1 на моменте удара
      g.circle(fx.toX, fx.toY, 10 + flashT * 26).fill({ color, alpha: 1 - flashT });
    }
  }

  function parseColor(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    return m ? parseInt(m[1], 16) : 0xff5555;
  }

  function redraw() {
    container.removeChildren();
    const now = performance.now();
    for (const fx of fxList) {
      const t = Math.min(1, (now - fx.start) / fx.duration);
      const g = new Graphics();
      drawOne(g, fx, t);
      container.addChild(g);
    }
  }

  function tick() {
    const now = performance.now();
    fxList = fxList.filter((fx) => now - fx.start < fx.duration);
    redraw();
    if (fxList.length === 0) {
      ctx.app.ticker.remove(tick);
      tickerAttached = false;
    }
  }

  function spawnFx(fx) {
    if (fx.type !== "animate_attack") return;
    fxList.push({ ...fx, start: performance.now(), duration: 420 });
    if (!tickerAttached) {
      tickerAttached = true;
      ctx.app.ticker.add(tick);
    }
  }

  return { container, spawnFx, update() {} };
}
