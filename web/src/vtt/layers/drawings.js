import { Container, Graphics, Text } from "pixi.js";
import { hexToInt } from "../../geometry.js";

// Слой пометок поверх сцены (domain.Drawing): стрелка «обходим слева», круг
// вокруг двери, подпись «здесь ловушка». Рисуется у ВСЕХ ролей — это то,
// что участники за столом показывают друг другу, а не разметка ДМ (в
// отличие от стен/тумана).
//
// Геометрия — один общий Graphics, перестраиваемый целиком по dirty.drawings
// (как layers/walls.js): элементов на сцене десятки, каждый — несколько
// вызовов Graphics, дешевле перерисовать всё, чем вести diff. Подписи
// (kind "text") — отдельные Text-объекты в Map по id, как значки в
// layers/note-markers.js: Text дорог в создании и пересоздавать его на
// каждую перерисовку нельзя.

// DEFAULT_WIDTH — толщина линии по умолчанию в мировых px (Drawing.Width==0).
export const DRAWING_DEFAULT_WIDTH = 4;
// DEFAULT_TEXT_SIZE — кегль подписи по умолчанию, в мировых px.
export const DRAWING_DEFAULT_TEXT_SIZE = 18;
// TEXT_SIZE_FACTOR — во сколько раз кегль подписи больше «толщины» из того
// же ползунка панели. Drawing.Width у подписи означает именно кегль, а
// ползунок размечен под толщину линии (2–24 px): без множителя подпись
// выходила бы ростом с саму линию, то есть нечитаемой.
export const DRAWING_TEXT_SIZE_FACTOR = 4;

// AUTHOR_COLORS — палитра «у каждого участника свой цвет». Цвет выбирается
// детерминированно по id автора, поэтому один и тот же игрок получает один и
// тот же цвет во всех окнах за столом без всякой договорённости по сети.
const AUTHOR_COLORS = ["#5dd0ff", "#7ee081", "#ffb454", "#ff7b72", "#c792ea", "#ffd866", "#4fd6be", "#f78fb3"];
// DM_COLOR — цвет ДМ (Drawing.AuthorID пустой), намеренно вне палитры
// игроков: пометка ведущего должна отличаться с первого взгляда.
const DM_COLOR = "#ffffff";

// colorForAuthor — цвет участника по его id. Пустой id — ДМ.
export function colorForAuthor(authorId) {
  if (!authorId) return DM_COLOR;
  let hash = 0;
  for (let i = 0; i < authorId.length; i++) hash = (hash * 31 + authorId.charCodeAt(i)) >>> 0;
  return AUTHOR_COLORS[hash % AUTHOR_COLORS.length];
}

// colorOf — цвет конкретной пометки: свой, если автор выбрал его в палитре,
// иначе цвет участника (см. sanitizeDrawingColor на сервере — мусор туда не
// доезжает, тут остаётся только "" или "#rrggbb").
function colorOf(d) {
  return hexToInt(d.color || colorForAuthor(d.authorId));
}

// visibleDrawings — что вообще рисуем: тумблер стола «скрыть пометки
// игроков» (см. domain.CombatState.HidePlayerDrawings) убирает с карты всё
// чужое, не стирая его на сервере. Фильтр клиентский, а не в payload
// (в отличие от hidden-токенов/значков заметок в service.Room.sceneFor):
// тут нет секрета ДМ — это разгрузка экрана, и вернуть пометки обратно
// тумблером надо мгновенно, не дожидаясь новой рассылки сцены.
function visibleDrawings(ctx) {
  const all = Object.values(ctx.scene.drawings || {});
  if (!(ctx.combat && ctx.combat.hidePlayerDrawings)) return all;
  return all.filter((d) => !d.authorId);
}

// strokeFor — общий стиль линии всех форм. Толщина задана в МИРОВЫХ px (в
// отличие от стен/сетки, где она компенсируется под 1/scale): пометка —
// часть карты, она обязана расти и уменьшаться вместе с ней, иначе стрелка,
// нарисованная на общем плане, при зуме в комнату превратится в волосок.
function strokeFor(d) {
  return { width: d.width > 0 ? d.width : DRAWING_DEFAULT_WIDTH, color: colorOf(d), alpha: 0.95, cap: "round", join: "round" };
}

// paintDrawing — геометрия одной пометки в переданный Graphics. "text" тут
// не рисуется — им занимаются Text-объекты ниже. Экспортируется, потому что
// тем же кодом interaction.js рисует превью текущего жеста: превью обязано
// выглядеть ровно так же, как получившийся элемент.
export function paintDrawing(g, d) {
  const p = d.points || [];
  const style = strokeFor(d);
  switch (d.kind) {
    case "free": {
      if (p.length < 2) return;
      g.moveTo(p[0].x, p[0].y);
      for (let i = 1; i < p.length; i++) g.lineTo(p[i].x, p[i].y);
      g.stroke(style);
      return;
    }
    case "line": {
      g.moveTo(p[0].x, p[0].y).lineTo(p[1].x, p[1].y).stroke(style);
      return;
    }
    case "arrow": {
      g.moveTo(p[0].x, p[0].y).lineTo(p[1].x, p[1].y).stroke(style);
      // Наконечник — два коротких отрезка под 25° к самой линии; длина
      // считается от толщины линии, чтобы тонкая стрелка не получала
      // непропорционально огромный наконечник.
      const angle = Math.atan2(p[1].y - p[0].y, p[1].x - p[0].x);
      const len = Math.max(style.width * 3.5, 10);
      for (const side of [-1, 1]) {
        const a = angle + Math.PI + side * 0.44;
        g.moveTo(p[1].x, p[1].y).lineTo(p[1].x + Math.cos(a) * len, p[1].y + Math.sin(a) * len);
      }
      g.stroke(style);
      return;
    }
    case "rect": {
      const x = Math.min(p[0].x, p[1].x);
      const y = Math.min(p[0].y, p[1].y);
      g.rect(x, y, Math.abs(p[1].x - p[0].x), Math.abs(p[1].y - p[0].y)).stroke(style);
      return;
    }
    case "circle": {
      // Вторая точка — на окружности, а не противоположный угол: круг
      // рисуется от центра наружу, как радиус света у токена.
      g.circle(p[0].x, p[0].y, Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y)).stroke(style);
      return;
    }
  }
}

export function createDrawingsLayer(ctx) {
  const container = new Container();
  const strokes = new Graphics();
  const labels = new Container();
  container.addChild(strokes, labels);

  const textViews = new Map(); // id -> Text

  function rebuild() {
    strokes.clear();
    const items = visibleDrawings(ctx);
    const textIds = new Set();

    for (const d of items) {
      if (d.kind === "text") {
        textIds.add(d.id);
        continue;
      }
      paintDrawing(strokes, d);
    }

    for (const id of textViews.keys()) {
      if (!textIds.has(id)) {
        textViews.get(id).destroy();
        textViews.delete(id);
      }
    }
    for (const d of items) {
      if (d.kind !== "text" || !d.points || !d.points.length) continue;
      let view = textViews.get(d.id);
      if (!view) {
        view = new Text({ text: "", style: { fontFamily: "sans-serif", fontWeight: "700" } });
        view.anchor.set(0.5);
        textViews.set(d.id, view);
        labels.addChild(view);
      }
      view.text = d.text || "";
      view.style.fontSize = d.width > 0 ? d.width : DRAWING_DEFAULT_TEXT_SIZE;
      view.style.fill = colorOf(d);
      view.position.set(d.points[0].x, d.points[0].y);
    }
  }

  function update() {
    if (!ctx.dirty.drawings) return;
    rebuild();
  }

  return { container, update };
}
