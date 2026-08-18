// Ручная имитация ctx.setLineDash — PIXI.Graphics (core, без доп. плагинов)
// не поддерживает пунктирные линии нативно, поэтому режем полилинию/круг/
// прямоугольник на короткие отрезки и рисуем через один. dash/gap — в
// мировых единицах (не экранных пикселях). Используется точечно
// (hidden-токен/hidden-метка/пунктир тумана у ДМ/превью инструментов) —
// не в горячем пути, пересчитывается только когда меняется сама сцена, не
// каждый кадр видео.

export function dashedSegment(g, x1, y1, x2, y2, dash, gap) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  const ux = dx / len, uy = dy / len;
  let pos = 0;
  let on = true;
  while (pos < len) {
    const step = Math.min(on ? dash : gap, len - pos);
    if (on) {
      g.moveTo(x1 + ux * pos, y1 + uy * pos);
      g.lineTo(x1 + ux * (pos + step), y1 + uy * (pos + step));
    }
    pos += step;
    on = !on;
  }
}

export function dashedPolyline(g, points, dash, gap, closed) {
  const pts = closed ? [...points, points[0]] : points;
  for (let i = 0; i < pts.length - 1; i++) {
    dashedSegment(g, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, dash, gap);
  }
}

export function dashedCircle(g, cx, cy, r, dash, gap) {
  const circumference = 2 * Math.PI * r;
  const steps = Math.max(8, Math.round(circumference / (dash + gap)));
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  dashedPolyline(g, pts, dash, gap, false);
}

export function dashedRect(g, x, y, w, h, dash, gap) {
  dashedPolyline(g, [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }], dash, gap, true);
}
