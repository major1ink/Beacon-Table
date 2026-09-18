import { Container, Graphics, Text } from "pixi.js";

// TELEPORT_MIN_SIZE/MAX_SIZE — пределы диаметра при резайзе (ПКМ →
// «Изменить размер», см. interaction.js). teleportSize — диаметр: свой либо
// клетка сетки; сервер считает попадание токена тем же радиусом (см.
// domain.Teleport.Radius).
export const TELEPORT_MIN_SIZE = 16;
export const TELEPORT_MAX_SIZE = 600;

export function teleportSize(t, grid) {
  if (t.size > 0) return t.size;
  return grid && grid.size > 0 ? grid.size : 48;
}

// Порталы (domain.Teleport) — видны всем: игрок должен знать, куда встать.
// Кольцо с подсветкой и подпись («→ сцена» либо имя пары порталов). Тот же
// retained-mode приём, что и в layers/note-markers.js.
export function createTeleportsLayer(ctx) {
  const container = new Container();
  const views = new Map(); // id -> view

  function createView() {
    const root = new Container();
    const ring = new Graphics();
    const label = new Text({
      text: "",
      style: { fill: 0xc9b8ff, fontSize: 11, fontFamily: "sans-serif", align: "center" },
    });
    label.anchor.set(0.5, 0);
    root.addChild(ring, label);
    return { root, ring, label };
  }

  function updateView(view, t) {
    const size = teleportSize(t, ctx.scene.grid);
    const r = size / 2;
    view.root.position.set(t.x, t.y);
    view.ring.clear();
    view.ring.circle(0, 0, r).fill({ color: 0x7c6cf0, alpha: 0.22 });
    view.ring.circle(0, 0, r * 0.55).fill({ color: 0xc9b8ff, alpha: 0.18 });
    view.ring.circle(0, 0, r).stroke({ width: Math.max(2, r * 0.12), color: 0x9f8cff, alpha: 0.95 });
    view.ring.circle(0, 0, r * 0.7).stroke({ width: Math.max(1, r * 0.06), color: 0xe4dcff, alpha: 0.7 });
    view.label.text = t.label ? (t.targetTeleportId ? t.label : "→ " + t.label) : "";
    view.label.style.fontSize = Math.max(10, Math.min(18, Math.round(size * 0.24)));
    view.label.position.set(0, r + 3);
  }

  function update() {
    if (!ctx.dirty.tokens && !ctx.dirty.grid) return; // тот же бит, что у токенов и значков заметок — см. dirty.js; сетка — дефолтный размер
    const data = ctx.scene.teleports || {};
    for (const id of views.keys()) {
      if (!(id in data)) {
        views.get(id).root.destroy({ children: true });
        views.delete(id);
      }
    }
    for (const id in data) {
      let view = views.get(id);
      if (!view) {
        view = createView();
        views.set(id, view);
        container.addChild(view.root);
      }
      updateView(view, data[id]);
    }
  }

  return { container, update };
}
