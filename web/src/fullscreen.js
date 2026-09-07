// fullscreen.js — кнопка «во весь экран». Адресная строка съедает у карты
// ~110px, а установка PWA этого не решает: display у Android работает только
// при установке по https. Fullscreen API работает и по http.
//
// На iPhone его нет вовсе — там кнопка убирается, режим даёт «На экран
// „Домой“» из Safari.
//
// renderContent(active) — содержимое кнопки задаёт вызывающий: у игрока с
// подписью, у ДМ значок рейла.
const KEY = "beacon:fullscreen";

export function initFullscreenButton(btn, renderContent) {
  const root = document.documentElement;
  if (!root.requestFullscreen) {
    btn.remove();
    return;
  }

  function sync() {
    const active = !!document.fullscreenElement;
    btn.innerHTML = renderContent(active);
    btn.title = active ? "Выйти из полноэкранного режима" : "Во весь экран — скрыть адресную строку браузера";
    btn.classList.toggle("open", active);
  }

  btn.onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else root.requestFullscreen().catch(() => {}); // отказали — остаёмся как были
  };

  // Состояние и флаг — из события, а не из клика: выйти можно системным
  // жестом «назад». relayout — канвасу перемериться на новую высоту.
  document.addEventListener("fullscreenchange", () => {
    try {
      localStorage.setItem(KEY, document.fullscreenElement ? "1" : "");
    } catch {
      /* приватный режим — просто не запомним */
    }
    sync();
    document.dispatchEvent(new CustomEvent("vtt:relayout"));
  });

  sync();
  restore(root);
}

// restore — вернуть режим тому, кто его уже включал. Прямо на загрузке нельзя:
// requestFullscreen требует пользовательского жеста, поэтому ждём первый клик.
// Клик, а не pointerdown: экран вырос бы посреди начатого драга токена.
function restore(root) {
  let saved = "";
  try {
    saved = localStorage.getItem(KEY) || "";
  } catch {
    return;
  }
  if (!saved || document.fullscreenElement) return;
  document.addEventListener(
    "click",
    () => {
      if (!document.fullscreenElement) root.requestFullscreen().catch(() => {});
    },
    { once: true, capture: true }
  );
}
