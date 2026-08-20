import { Container, Graphics, Text, BlurFilter } from "pixi.js";
import { wallMidpoint } from "../../geometry.js";

// Значки окон (domain.Wall.Window) — эмодзи "🪟" в кружке-подложке, тот же
// retained-mode/syncMap приём, что у layers/doors.js (значок двери) и
// layers/note-markers.js. В отличие от двери у окна нет состояния
// открыто/закрыто/заперто (Window — просто bool, см. domain.Wall) — значок
// всегда один и тот же, задача тут не "показать состояние", а просто дать
// понять, что тут именно окно, а не дверь и не глухая стена (сквозь него
// видно — geometry.wallBlocksSight, но не пройти — wallBlocksMovement). Без
// значка на линии стены (layers/walls.js, видна только ДМ) окно ничем не
// отличалось от обычной стены на глаз игрока.
//
// Видно и ДМ, и игроку (как и дверь) — окно физическая часть карты, а не
// секрет, отдельного visibleWindows()-фильтра по роли поэтому нет (в отличие
// от doors.js, где секретную дверь прячем от игрока).
//
// shadow — небольшая мягкая тень под значком (GPU-блюр, тот же приём, что у
// ручного тумана — см. layers/manual-fog.js): просто смещённый затемнённый
// кружок позади подложки, для ощущения глубины/реалистичности, а не честная
// светотень от источников света.
const ICON_SIZE = 18;
const GLASS_COLOR = 0x8fd3ff;

export function createWindowsLayer(ctx) {
  const container = new Container();
  const views = new Map(); // wallId -> view

  function createView() {
    const root = new Container();
    const shadow = new Graphics();
    shadow.filters = [new BlurFilter({ strength: 3, quality: 2 })];
    const bg = new Graphics();
    const icon = new Text({ text: "🪟", style: { fontSize: ICON_SIZE } });
    icon.anchor.set(0.5);
    root.addChild(shadow, bg, icon);
    return { root, shadow, bg, icon };
  }

  function updateView(view, w, scale) {
    const { x, y } = wallMidpoint(w);
    view.root.position.set(x, y);
    // 1/scale — постоянный ЭКРАННЫЙ размер значка независимо от зума карты
    // (тот же приём, что и у значка двери — см. doors.js).
    view.root.scale.set(1 / scale);
    view.shadow.clear().circle(2, 3, ICON_SIZE * 0.62).fill({ color: 0x000000, alpha: 0.35 });
    view.bg
      .clear()
      .circle(0, 0, ICON_SIZE * 0.62)
      .fill({ color: GLASS_COLOR, alpha: 0.85 })
      .stroke({ width: 2, color: 0x1a1a1a, alpha: 0.5 });
  }

  function visibleWindows() {
    const walls = ctx.scene.walls || {};
    const out = [];
    for (const id in walls) {
      if (walls[id].window) out.push([id, walls[id]]);
    }
    return out;
  }

  function rebuild() {
    const scale = ctx.world.scale.x || 1;
    const entries = visibleWindows();
    const ids = new Set(entries.map(([id]) => id));
    for (const id of views.keys()) {
      if (!ids.has(id)) {
        views.get(id).root.destroy({ children: true });
        views.delete(id);
      }
    }
    for (const [id, w] of entries) {
      let view = views.get(id);
      if (!view) {
        view = createView();
        views.set(id, view);
        container.addChild(view.root);
      }
      updateView(view, w, scale);
    }
  }

  function update() {
    // Окна — часть scene.walls, отдельный dirty-флаг не нужен: dirty.walls
    // выставляется и на правку стен (см. dirty.js), и на каждый pan/zoom
    // камеры (markCameraDirty в interaction.js) — последнее нужно, чтобы
    // 1/scale в updateView не отставал от зума (та же причина, что у
    // doors.js).
    if (!ctx.dirty.walls) return;
    rebuild();
  }

  return { container, update };
}
