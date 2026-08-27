// Оверлей «Показать игрокам»: ДМ выводит картинку поверх всего на экраны
// игроков и трансляции (см. broadcastShowcase в internal/service/room.go,
// domain.ShowcaseState). Модуль общий для всех трёх ролей — картинка
// приходит по DOM-событию "vtt:showcase" (см. web/src/vtt/net.js), которое
// диспатчится одинаково у ДМ, игрока и трансляции; серверу всё равно, кто
// смотрит.
//
// На экране самого ДМ оверлей работает как ПРЕДПРОСМОТР (ровно то же, что
// видят игроки) плюс кнопка «✕» и клик по тёмному фону — оба шлют
// "hide_image" и убирают показ у всех. У игрока и на трансляции закрыть
// нельзя: показом управляет только ДМ.

let styleInjected = false;
function injectStyle() {
  if (styleInjected) return;
  styleInjected = true;
  const s = document.createElement("style");
  // z-index 600 — выше плавающих окон (Z_BASE=200, см. floating-window.js) и
  // модалок (500, см. modal.js): «поверх всего», как и просили. Ниже только
  // полноэкранного «сессия слетела» (см. #authFailedOverlay), который и
  // должен перебивать всё.
  s.textContent = `
  .showcase-overlay {
    position: fixed; inset: 0; z-index: 600;
    display: flex; align-items: center; justify-content: center;
    background: rgba(6, 6, 10, 0.94);
    opacity: 0; pointer-events: none; transition: opacity 0.22s ease;
  }
  .showcase-overlay.open { opacity: 1; pointer-events: auto; }
  .showcase-overlay img {
    max-width: 96vw; max-height: 96vh; object-fit: contain;
    border-radius: 4px; box-shadow: 0 12px 64px rgba(0, 0, 0, 0.6);
  }
  .showcase-overlay-close {
    position: absolute; top: 16px; right: 16px;
    width: 40px; height: 40px; padding: 0;
    border: none; border-radius: 50%; cursor: pointer;
    background: rgba(255, 255, 255, 0.14); color: #fff;
    font-size: 20px; line-height: 1;
    display: flex; align-items: center; justify-content: center;
    transition: background 0.12s ease;
  }
  .showcase-overlay-close:hover { background: rgba(255, 255, 255, 0.26); }
  `;
  document.head.appendChild(s);
}

// initShowcaseOverlay({ role, send }) — role: "dm" | "player" | "tv".
// send нужен только роли "dm" (кнопка/фон закрывают показ у всех через
// "hide_image"); игрок/трансляция управления не имеют.
export function initShowcaseOverlay({ role, send } = {}) {
  injectStyle();
  const isDM = role === "dm";

  const el = document.createElement("div");
  el.className = "showcase-overlay";
  const img = document.createElement("img");
  img.alt = "";
  el.appendChild(img);

  if (isDM) {
    const close = document.createElement("button");
    close.type = "button";
    close.className = "showcase-overlay-close";
    close.title = "Убрать с экрана игроков";
    close.textContent = "✕";
    close.onclick = () => send && send({ type: "hide_image" });
    el.appendChild(close);
    // Клик по тёмному фону (мимо картинки) — тоже снять показ. По самой
    // картинке — нет, чтобы ДМ мог кликнуть по ней, ничего не уронив.
    el.addEventListener("mousedown", (e) => {
      if (e.target === el && send) send({ type: "hide_image" });
    });
  }

  document.body.appendChild(el);

  let currentUrl = "";
  document.addEventListener("vtt:showcase", (e) => {
    const url = (e.detail && e.detail.url) || "";
    if (url === currentUrl) return;
    currentUrl = url;
    if (url) {
      img.src = url;
      el.classList.add("open");
    } else {
      el.classList.remove("open");
      // src убираем только после fade-out — иначе картинка мигает пустотой
      // на время анимации закрытия.
      setTimeout(() => {
        if (!currentUrl) img.removeAttribute("src");
      }, 260);
    }
  });
}
