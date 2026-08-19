import { Container, Graphics, Text } from "pixi.js";
import { wallMidpoint } from "../../geometry.js";

// Значки дверей (domain.Wall.Door/DoorState) — эмодзи "🚪" в кружке-подложке,
// цвет которой кодирует состояние (closed/open/locked/secret). Тот же
// retained-mode/syncMap приём, что у layers/note-markers.js (📜) — Container
// на дверь, пересоздаётся только когда дверь реально появилась/исчезла.
//
// В отличие от layers/walls.js (линии стен — ТОЛЬКО ДМ), значки видны И ДМ, И
// игроку: сам клик по двери — единственное стеновое взаимодействие, доступное
// игроку (см. interaction.js, service.Room.handleToggleDoor). Секретную дверь
// (Door==="secret") от игрока просто не рендерим вовсе — visibleDoors() ниже.
//
// Слой добавляется в список ПЕРЕД visionFog (см. vtt/index.js) — значки
// рисуются в мировых координатах, и тьма/туман (layers/vision-fog.js) красит
// поверх них как обычно: в неисследованном/неосвещённом месте значок
// физически перекрыт заливкой тьмы, ровно как и токены, которые по той же
// причине тоже идут в списке слоёв перед visionFog. Отдельного расчёта
// видимости специально для дверей тут поэтому нет.
const ICON_SIZE = 20;

const CLOSED_COLOR = 0x8a5a2b;
const OPEN_COLOR = 0x4caf50;
const LOCKED_COLOR = 0xcc3333;
const SECRET_COLOR = 0x9b59b6; // виден только ДМ (см. visibleDoors)

function colorForDoor(w) {
  if (w.doorState === "locked") return LOCKED_COLOR;
  if (w.doorState === "open") return OPEN_COLOR;
  if (w.door === "secret") return SECRET_COLOR;
  return CLOSED_COLOR;
}

export function createDoorsLayer(ctx) {
  const container = new Container();
  const views = new Map(); // wallId -> view

  function createView() {
    const root = new Container();
    const bg = new Graphics();
    const icon = new Text({ text: "🚪", style: { fontSize: ICON_SIZE } });
    icon.anchor.set(0.5);
    root.addChild(bg, icon);
    return { root, bg, icon };
  }

  function updateView(view, w, scale) {
    const { x, y } = wallMidpoint(w);
    view.root.position.set(x, y);
    // 1/scale — постоянный ЭКРАННЫЙ размер значка независимо от зума карты
    // (тот же приём, что и у кружков-вершин стен в walls.js: `5 / scale`,
    // только тут масштабируется контейнер целиком, а не один радиус).
    view.root.scale.set(1 / scale);
    view.bg
      .clear()
      .circle(0, 0, ICON_SIZE * 0.62)
      .fill({ color: colorForDoor(w), alpha: 0.88 })
      .stroke({ width: 2, color: 0x1a1a1a, alpha: 0.6 });
    // Секретная дверь видна только ДМ (см. visibleDoors) — тут же её слегка
    // приглушаем, чтобы отличать от обычной с первого взгляда, не открывая меню.
    view.icon.alpha = w.door === "secret" ? 0.75 : 1;
  }

  // visibleDoors — стены с непустым Door, секретные — только для ДМ (игрок
  // не должен ни видеть значок, ни попасть по нему хит-тестом — см.
  // geometry.js:doorAt(..., includeSecret) на стороне interaction.js).
  function visibleDoors() {
    const walls = ctx.scene.walls || {};
    const out = [];
    for (const id in walls) {
      const w = walls[id];
      if (!w.door) continue;
      if (w.door === "secret" && !ctx.isDM) continue;
      out.push([id, w]);
    }
    return out;
  }

  function rebuild() {
    const scale = ctx.world.scale.x || 1;
    const entries = visibleDoors();
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
    // Двери — часть scene.walls, отдельный dirty-флаг не нужен: dirty.walls
    // и так выставляется и на правку стен (см. dirty.js), и на каждый
    // pan/zoom камеры (markCameraDirty в interaction.js) — последнее нужно
    // именно тут, чтобы 1/scale в updateView не отставал от зума.
    if (!ctx.dirty.walls) return;
    rebuild();
  }

  return { container, update };
}
