// Таймеры ширмы, которые ведущий открыл игрокам и трансляции: плашка сверху.
// Код идёт и в legacy-сборку трансляции — без gap и inset.

let styleInjected = false;
function injectStyle() {
  if (styleInjected) return;
  styleInjected = true;
  const s = document.createElement("style");
  s.textContent = `
  .screen-timers { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 550; display: flex; flex-wrap: wrap; justify-content: center; pointer-events: none; }
  .screen-timer { margin: 0 5px 6px; padding: 6px 14px; border-radius: 999px; background: rgba(22,22,29,.92); border: 1px solid rgba(255,255,255,.12); color: #eee; font: 600 15px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; display: flex; align-items: baseline; box-shadow: 0 4px 16px rgba(0,0,0,.35); }
  .screen-timer span, .screen-timer b { font-family: var(--font-serif, Georgia, serif); }
  .screen-timer b { margin-left: 10px; font-size: 24px; font-weight: 700; font-variant-numeric: tabular-nums; color: #fff; }
  .screen-timer.running b { color: #7fd694; }
  .screen-timer.done { border-color: rgba(240,160,160,.6); }
  .screen-timer.done b { color: #f0a0a0; animation: screen-timer-blink 1s steps(2) infinite; }
  @keyframes screen-timer-blink { 50% { opacity: .35; } }
  .tv .screen-timer { font-size: 22px; padding: 8px 20px; }
  .tv .screen-timer b { font-size: 38px; }
  `;
  document.head.appendChild(s);
}

function fmt(ms) {
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? h + ":" + String(m).padStart(2, "0") + ":" + sec : m + ":" + sec;
}

export function initScreenTimers({ role = "player" } = {}) {
  injectStyle();
  const box = document.createElement("div");
  box.className = "screen-timers" + (role === "tv" ? " tv" : "");
  box.setAttribute("role", "timer");
  document.body.appendChild(box);
  let timers = [];
  let offset = 0;
  let tick = null;

  function draw() {
    const now = Date.now() + offset;
    box.textContent = "";
    let running = false;
    for (const t of timers) {
      const left = t.endsAt ? Math.max(0, t.endsAt - now) : t.left || (t.seconds || 0) * 1000;
      const done = !!t.endsAt && left <= 0;
      running = running || (!!t.endsAt && left > 0);
      const chip = document.createElement("div");
      chip.className = "screen-timer" + (done ? " done" : t.endsAt ? " running" : "");
      const name = document.createElement("span");
      name.textContent = t.title || "Таймер";
      const value = document.createElement("b");
      value.textContent = done ? "Время!" : fmt(left);
      chip.appendChild(name);
      chip.appendChild(value);
      box.appendChild(chip);
    }
    if (running && !tick) tick = setInterval(draw, 250);
    if (!running && tick) {
      clearInterval(tick);
      tick = null;
    }
  }

  document.addEventListener("vtt:screenTimers", (e) => {
    timers = e.detail.timers || [];
    offset = e.detail.offset || 0;
    draw();
  });
}
