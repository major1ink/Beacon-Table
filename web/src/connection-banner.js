// Плашка «связь со столом потеряна».
//
// Переподключение (см. ws-reconnect.js) само по себе молчаливо, и это его
// худшая черта: пока оно идёт, карта на экране выглядит живой, кнопки
// нажимаются, а команды уходят в никуда — send честно возвращает false, но
// на экране от этого ничего не меняется. ДМ должен видеть, что стол сейчас
// не отвечает, иначе он двигает токены и не понимает, почему их не видят
// игроки.
//
// Разметку и стили модуль заводит сам, а не просит их у страницы: плашка
// нужна одинаковая на всех трёх экранах стола (dm.html, player.html,
// broadcast.html), а держать один и тот же <div> в трёх файлах — верный
// способ однажды поправить его в двух.

// showAfterMs — не мигать на каждом чихе. Короткий обрыв (переключение
// вышки на телефоне, перезапуск сервера) переживается за секунду-другую, и
// плашка, успевшая мигнуть, пугает больше самого обрыва.
const showAfterMs = 3000;

// hideAfterMs — сколько держать «связь восстановлена», прежде чем убрать
// плашку совсем.
const hideAfterMs = 2000;

const css = `
#connBanner {
  position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
  z-index: 60; display: none; align-items: center; gap: 8px;
  padding: 7px 14px; border-radius: 999px;
  background: rgba(10, 10, 14, 0.88); color: #eee;
  font: 13px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.45);
  pointer-events: none;
}
#connBanner.open { display: flex; }
#connBanner.ok { color: #9be29b; }
#connBanner .dot {
  width: 7px; height: 7px; border-radius: 50%; background: #e2a33b;
  animation: connBannerPulse 1.1s ease-in-out infinite;
}
#connBanner.ok .dot { background: #6ec06e; animation: none; }
@keyframes connBannerPulse { 50% { opacity: 0.25; } }
@media (prefers-reduced-motion: reduce) {
  #connBanner .dot { animation: none; }
}
`;

let el = null;
let showTimer = null;
let hideTimer = null;

function ensure() {
  if (el) return el;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  el = document.createElement("div");
  el.id = "connBanner";
  el.innerHTML = '<span class="dot"></span><span id="connBannerText"></span>';
  document.body.appendChild(el);
  return el;
}

function show(text, ok) {
  const node = ensure();
  node.querySelector("#connBannerText").textContent = text;
  node.classList.toggle("ok", !!ok);
  node.classList.add("open");
}

function hide() {
  el?.classList.remove("open");
}

// initConnectionBanner подписывается на события, которые шлёт vtt/net.js.
// Зовётся один раз при сборке стола; повторный вызов безвреден.
export function initConnectionBanner() {
  document.addEventListener("vtt:connectionLost", () => {
    clearTimeout(hideTimer);
    clearTimeout(showTimer);
    showTimer = setTimeout(() => show("Связь со столом потеряна — переподключаюсь…", false), showAfterMs);
  });

  document.addEventListener("vtt:connectionRestored", () => {
    clearTimeout(showTimer);
    // Плашка так и не успела появиться — значит обрыв был незаметным, и
    // сообщать теперь уже не о чем.
    if (!el || !el.classList.contains("open")) return;
    show("Связь восстановлена", true);
    hideTimer = setTimeout(hide, hideAfterMs);
  });

  // Сессия кончилась — этим занимается свой оверлей страницы (см.
  // authFailedOverlay в dm.html/player.html), плашка тут только мешала бы.
  document.addEventListener("vtt:authFailed", () => {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    hide();
  });
}
