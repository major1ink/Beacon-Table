// drag.js — общий жест «схватил и тянешь»: шапка окна, уголок лога,
// разделитель дока. Pointer events — работает и пальцем; захват указателя —
// иначе курсор над iframe уносит события в его документ и жест рвётся;
// слушатели на window — элемент может перерисоваться посреди жеста.
//
// attachDrag(handle, { onStart(e) → false отменяет, onMove(dx, dy, e), onEnd(dx, dy) })
export function attachDrag(handle, { onStart, onMove, onEnd } = {}) {
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("button, input, select, textarea, a")) return;
    if (onStart && onStart(e) === false) return;
    e.preventDefault();
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* указатель уже отпущен */
    }
    const startX = e.clientX;
    const startY = e.clientY;
    let dx = 0;
    let dy = 0;
    const move = (ev) => {
      dx = ev.clientX - startX;
      dy = ev.clientY - startY;
      onMove && onMove(dx, dy, ev);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      onEnd && onEnd(dx, dy);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  });
}
