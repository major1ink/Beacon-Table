// Разбор событий wheel: колесо мыши зумит, прокрутка тачпада двигает карту,
// щипок на тачпаде зумит плавно.

const GESTURE_GAP_MS = 150;
const MOUSE_MIN_DELTA = 50;
const PINCH_MAX_DELTA = 25;
const PINCH_SPEED = 0.01;

// createWheelClassifier по событию wheel возвращает "pinch" (щипок), "pan" (сдвиг карты)
// или "zoom" (шаг колеса). Колесо мыши даёт целый deltaY от 50 и deltaX = 0,
// тачпад — мелкие или дробные значения. События подряд считаются одним жестом.
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

// pinchFactor — множитель зума для щипка, с ограничением для Ctrl + колесо мыши.
export function pinchFactor(deltaY) {
  const d = Math.max(-PINCH_MAX_DELTA, Math.min(PINCH_MAX_DELTA, deltaY));
  return Math.exp(-d * PINCH_SPEED);
}
