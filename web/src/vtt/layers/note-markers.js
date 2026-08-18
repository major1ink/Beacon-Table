import { Container, Text } from "pixi.js";

// DEFAULT_SIZE/MIN_SIZE/MAX_SIZE — та же шкала, что читает и пишет
// interaction.js при резайзе (драг от центра значка наружу задаёт marker.size
// напрямую в мировых px — см. noteMarkerAt/resizingNoteMarkerId там же).
export const NOTE_MARKER_DEFAULT_SIZE = 22;
export const NOTE_MARKER_MIN_SIZE = 12;
export const NOTE_MARKER_MAX_SIZE = 96;

// Значки заметок ДМ на карте (domain.NoteMarker) — свиток 📜 + подпись с
// заголовком заметки, ВСЕГДА видимая (сервер и так шлёт scene.noteMarkers
// только роли DM — см. service.Room.sceneFor, — поэтому, в отличие от старых
// hidden-меток, тут нет своего toggle "скрыто/раскрыто"). Тот же
// retained-mode/syncMap приём, что и в layers/tokens.js: контейнер на
// значок, пересоздаётся только когда значок реально появился/исчез.
export function createNoteMarkersLayer(ctx) {
  const container = new Container();
  const views = new Map(); // id -> view

  function createView() {
    const root = new Container();
    const icon = new Text({ text: "📜", style: { fontSize: NOTE_MARKER_DEFAULT_SIZE } });
    icon.anchor.set(0.5, 0.5);
    const label = new Text({
      text: "",
      style: { fill: 0xe8d9a8, fontSize: 11, fontFamily: "sans-serif", align: "center" },
    });
    label.anchor.set(0.5, 0);
    root.addChild(icon, label);
    return { root, icon, label };
  }

  function updateView(view, id, marker) {
    view.root.position.set(marker.x, marker.y);
    view.label.text = marker.label || "";
    // Размер — редактируется ДМ через ПКМ → "Изменить размер" (см.
    // interaction.js). Подпись масштабируется вместе с иконкой, но мягче
    // (иначе на маленьких значках текст просто перестаёт помещаться/читаться),
    // и сдвигается вниз ровно настолько, чтобы не наезжать на увеличенную иконку.
    const size = marker.size > 0 ? marker.size : NOTE_MARKER_DEFAULT_SIZE;
    view.icon.style.fontSize = size;
    view.label.style.fontSize = Math.max(9, Math.round(size * 0.5));
    view.label.position.set(0, size / 2 + 4);
  }

  function update() {
    if (!ctx.dirty.tokens) return; // тот же бит, что и токены/старые hidden-метки — см. dirty.js
    const data = ctx.scene.noteMarkers || {};
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
      updateView(view, id, data[id]);
    }
  }

  return { container, update };
}
