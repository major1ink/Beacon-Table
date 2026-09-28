// legacy-dom.js — недостающие DOM-API для старых браузеров телевизоров и
// приставок. Встроенные функции языка (Object.fromEntries, flatMap…) сборка
// трансляции подкладывает сама через core-js (см. web/vite.broadcast.config.js),
// а DOM core-js не покрывает — здесь ровно то, без чего страница трансляции
// не встаёт. Импортируется первым в pages/broadcast.js.

// append — Chromium 54+, replaceChildren — 86+.
for (const proto of [Element.prototype, Document.prototype, DocumentFragment.prototype]) {
  if (!proto.append) {
    proto.append = function (...nodes) {
      for (const n of nodes) this.appendChild(typeof n === "string" ? document.createTextNode(n) : n);
    };
  }
  if (!proto.replaceChildren) {
    proto.replaceChildren = function (...nodes) {
      while (this.lastChild) this.removeChild(this.lastChild);
      this.append(...nodes);
    };
  }
}

// ResizeObserver — Chromium 64+. Без него канвас так и остаётся 300×150 в
// углу экрана: Pixi снимает размер обёртки один раз (см. vtt/index.js).
// Замена грубая — опрос размеров раз в полсекунды и по resize окна, — но
// телевизору большего и не надо: его окно меняется редко.
if (typeof window.ResizeObserver === "undefined") {
  window.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.targets = new Map();
      this.check = () => {
        const changed = [];
        for (const [el, last] of this.targets) {
          const w = el.clientWidth;
          const h = el.clientHeight;
          if (w !== last.w || h !== last.h) {
            last.w = w;
            last.h = h;
            changed.push({ target: el, contentRect: { width: w, height: h } });
          }
        }
        if (changed.length) this.callback(changed, this);
      };
      this.timer = 0;
    }
    observe(el) {
      if (this.targets.has(el)) return;
      this.targets.set(el, { w: -1, h: -1 });
      if (!this.timer) {
        this.timer = setInterval(this.check, 500);
        window.addEventListener("resize", this.check);
      }
      setTimeout(this.check, 0);
    }
    unobserve(el) {
      this.targets.delete(el);
      if (!this.targets.size) this.disconnect();
    }
    disconnect() {
      this.targets.clear();
      clearInterval(this.timer);
      this.timer = 0;
      window.removeEventListener("resize", this.check);
    }
  };
}
