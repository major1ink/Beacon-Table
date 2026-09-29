// Разбор событий wheel: колесо мыши зумит, прокрутка тачпада двигает карту,
// щипок на тачпаде зумит плавно.

const GESTURE_GAP_MS = 150;
const MOUSE_MIN_DELTA = 50;
const PINCH_MAX_DELTA = 25;
const PINCH_SPEED = 0.01;

// createWheelClassifier возвращает функцию, которая по событию wheel говорит:
// "pinch" (плавный зум), "pan" (сдвиг карты) или "zoom" (шаг зума колесом).
// Мышь и тачпад различаются по значениям delta: колесо мыши даёт целые
// deltaY от 100 и deltaX = 0, тачпад — мелкие и дробные значения или deltaX.
// Инерция тачпада после отпускания пальцев даёт крупные значения, поэтому
// события подряд считаются одним жестом.
export function createWheelClassifier() {
  let lastPanAt = -Infinity;
  return (e) => {
    if (e.ctrlKey) return "pinch";
    const mouse = e.deltaMode !== 0 || (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= MOUSE_MIN_DELTA);
    if (mouse && e.timeStamp - lastPanAt > GESTURE_GAP_MS) return "zoom";
    lastPanAt = e.timeStamp;
    return "pan";
  };
}

// pinchFactor — множитель зума для щипка; ограничение нужно, чтобы Ctrl + колесо мыши не прыгало.
export function pinchFactor(deltaY) {
  const d = Math.max(-PINCH_MAX_DELTA, Math.min(PINCH_MAX_DELTA, deltaY));
  return Math.exp(-d * PINCH_SPEED);
}
