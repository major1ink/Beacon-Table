// wake-lock.js — экран телефона/планшета не гаснет, пока открыт стол: за
// игрой в него смотрят урывками, и каждые полминуты разблокировать его —
// то, на что жаловались первым делом.
//
// Замок браузер снимает сам, когда вкладку прячут, — берём заново при
// возвращении. Только тач-устройства: у компьютера своё энергосбережение, и
// держать ему экран незачем. API есть лишь в защищённом контексте (https
// или localhost) — по голому http в локальной сети тихо ничего не делаем.
export function initWakeLock() {
  if (!("wakeLock" in navigator) || !matchMedia("(pointer: coarse)").matches) return;
  let lock = null;
  async function take() {
    if (lock || document.visibilityState !== "visible") return;
    try {
      lock = await navigator.wakeLock.request("screen");
      lock.addEventListener("release", () => (lock = null));
    } catch {
      /* отказали (энергосбережение, политика) — экран погаснет как обычно */
    }
  }
  document.addEventListener("visibilitychange", take);
  take();
}
