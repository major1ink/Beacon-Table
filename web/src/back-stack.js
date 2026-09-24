// back-stack.js — системная «Назад» на телефоне закрывает верхний слой
// (лист, окно, чат, панель, лоток кубов), а не уводит со стола.
//
// Открытый слой кладёт в историю пустую запись (pushState), «Назад»
// снимает её — на popstate закрываем самый верхний слой. Закрыли слой
// кнопкой в интерфейсе — его запись съедаем сами (history.back()), иначе
// история копила бы пустые шаги и «Назад» потом долго «ничего не делал».
// popstate от такого back() ждём и пропускаем (skipPops).
//
// Только на телефоне (брейкпоинт общий, см. theme.css): на компьютере
// «Назад» браузера по-прежнему уходит со страницы, а окна закрывают мышью.
const PHONE = "(max-width: 860px), (max-height: 500px)";
const stack = [];
let skipPops = 0;

// typeof — модуль тянут за собой тесты под node (через floating-window.js).
if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    if (skipPops > 0) {
      skipPops--;
      return;
    }
    const top = stack.pop();
    if (!top) return;
    top.active = false;
    top.onBack();
  });
}

// createBackLayer(onBack) — слой, который «Назад» умеет закрыть.
// set(open) вызывает владелец слоя на каждом открытии/закрытии (повторы
// ничего не делают); onBack — закрыть слой так же, как его ✕.
export function createBackLayer(onBack) {
  const entry = { active: false, onBack };
  return {
    set(open) {
      if (open === entry.active) return;
      if (open) {
        if (!matchMedia(PHONE).matches) return;
        entry.active = true;
        stack.push(entry);
        history.pushState({ beaconLayer: true }, "");
        return;
      }
      entry.active = false;
      const i = stack.indexOf(entry);
      if (i < 0) return;
      stack.splice(i, 1);
      skipPops++;
      history.back();
    },
  };
}

// trackOpenClass — слой, открытость которого — класс на элементе (модалки
// player.html: .open, лоток кубов: body.dice-open). Следим за классом, а не
// за каждым местом, где его ставят и снимают.
export function trackOpenClass(el, className, onBack) {
  const layer = createBackLayer(onBack);
  const sync = () => layer.set(el.classList.contains(className));
  new MutationObserver(sync).observe(el, { attributes: true, attributeFilter: ["class"] });
  sync();
  return layer;
}
