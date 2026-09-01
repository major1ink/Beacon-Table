// Плавающие плашки поверх канваса: «связь со столом потеряна» и текстовые
// объявления сервера (сейчас единственный источник вторых — предупреждение
// демо-стола о скором сбросе, см. cmd/beacon-table/demo.go: demoResetter).
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
//
// Два независимых элемента, не один переиспользуемый: у связи и у
// объявлений сервера разные поводы появиться и разные таймеры скрытия —
// если бы они делили один <div>, объявление посреди обрыва связи стёрло бы
// собой её статус (или наоборот).

// showAfterMs — не мигать на каждом чихе. Короткий обрыв (переключение
// вышки на телефоне, перезапуск сервера) переживается за секунду-другую, и
// плашка, успевшая мигнуть, пугает больше самого обрыва.
const showAfterMs = 3000;

// hideAfterMs — сколько держать «связь восстановлена», прежде чем убрать
// плашку совсем.
const hideAfterMs = 2000;

// noticeHideAfterMs — сколько держать объявление сервера на экране. Не
// статус, который снимается сам по факту события (как «связь
// восстановлена»), поэтому гасим по таймеру — с запасом, чтобы успеть
// дочитать даже на телефоне вполглаза.
const noticeHideAfterMs = 20000;

const css = `
#connBanner, #tableNotice {
  position: fixed; left: 50%; transform: translateX(-50%);
  z-index: 60; display: none; align-items: center; gap: 8px;
  padding: 7px 14px; border-radius: 999px;
  background: rgba(10, 10, 14, 0.88); color: #eee;
  font: 13px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.45);
  pointer-events: none;
  max-width: min(90vw, 480px);
}
#connBanner { top: 12px; }
/* Ниже плашки связи — если обе выпадут разом (не должны, но не обязаны
   друг другу мешать), не накладываются друг на друга. */
#tableNotice { top: 54px; }
#connBanner.open, #tableNotice.open { display: flex; }
#connBanner.ok { color: #9be29b; }
#connBanner .dot {
  width: 7px; height: 7px; border-radius: 50%; background: #e2a33b;
  animation: connBannerPulse 1.1s ease-in-out infinite;
}
#connBanner.ok .dot { background: #6ec06e; animation: none; }
#tableNotice .dot { width: 7px; height: 7px; border-radius: 50%; background: #6ea8e2; }
@keyframes connBannerPulse { 50% { opacity: 0.25; } }
@media (prefers-reduced-motion: reduce) {
  #connBanner .dot { animation: none; }
}
`;

let el = null;
let showTimer = null;
let hideTimer = null;

let noticeEl = null;
let noticeHideTimer = null;

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

function ensureNotice() {
  ensure(); // тот же <style> обслуживает оба элемента
  if (noticeEl) return noticeEl;
  noticeEl = document.createElement("div");
  noticeEl.id = "tableNotice";
  noticeEl.innerHTML = '<span class="dot"></span><span id="tableNoticeText"></span>';
  document.body.appendChild(noticeEl);
  return noticeEl;
}

function showNotice(text) {
  const node = ensureNotice();
  node.querySelector("#tableNoticeText").textContent = text;
  node.classList.add("open");
  clearTimeout(noticeHideTimer);
  noticeHideTimer = setTimeout(() => node.classList.remove("open"), noticeHideAfterMs);
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

  // table_notice от комнаты (см. internal/service/room.go: Announce) —
  // текст для человека, а не служебное «перечитай список»: показываем как
  // есть, никакой обработки.
  document.addEventListener("vtt:tableNotice", (e) => showNotice(e.detail.text));
}
