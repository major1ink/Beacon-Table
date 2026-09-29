// Полифилы DOM для старых браузеров телевизоров и приставок. Функции языка
// добавляет core-js при сборке (vite.broadcast.config.js), DOM он не покрывает.

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

// ResizeObserver через опрос размера раз в полсекунды.
if (typeof window.ResizeObserver === "undefined") {
  window.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.sizes = new Map();
      this.timer = 0;
    }

    observe(el) {
      this.sizes.set(el, "");
      if (!this.timer) this.timer = setInterval(() => this.check(), 500);
    }

    unobserve(el) {
      this.sizes.delete(el);
    }

    disconnect() {
      this.sizes.clear();
      clearInterval(this.timer);
      this.timer = 0;
    }

    check() {
      const changed = [];
      for (const [el, last] of this.sizes) {
        const size = el.clientWidth + "x" + el.clientHeight;
        if (size !== last) {
          this.sizes.set(el, size);
          changed.push({ target: el });
        }
      }
      if (changed.length) this.callback(changed, this);
    }
  };
}
