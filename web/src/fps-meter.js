// fps-meter.js — счётчик кадров в левом нижнем углу. Настройка этого
// устройства (localStorage), как анимация и звук бросков: жалобы «тормозит»
// без цифр не с чем сравнивать, а у разных участников стола разное железо.

const KEY = "beacon:fpsMeter";

export function fpsMeterOn() {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false; // приватный режим
  }
}

function setFpsMeterOn(on) {
  try {
    if (on) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    /* приватный режим */
  }
}

let el = null;
let raf = 0;

function start() {
  if (el) return;
  el = document.createElement("div");
  el.className = "fps-meter";
  el.setAttribute("aria-hidden", "true");
  el.textContent = "FPS …";
  document.body.appendChild(el);

  let frames = 0;
  let from = performance.now();
  const tick = (now) => {
    frames++;
    if (now - from >= 1000) {
      el.textContent = `FPS ${Math.round((frames * 1000) / (now - from))}`;
      frames = 0;
      from = now;
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

function stop() {
  if (!el) return;
  cancelAnimationFrame(raf);
  el.remove();
  el = null;
}

// initFpsMeterToggle — привязать переключатель настроек и сразу показать
// счётчик, если он был включён в прошлый раз.
export function initFpsMeterToggle(input) {
  const on = fpsMeterOn();
  if (on) start();
  if (!input) return;
  input.checked = on;
  input.onchange = () => {
    setFpsMeterOn(input.checked);
    if (input.checked) start();
    else stop();
  };
}
