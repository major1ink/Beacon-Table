import { RenderGroup, TextureSource, UPDATE_PRIORITY } from "pixi.js";

// Кадр рисуется, только когда сцена изменилась. По умолчанию Pixi рисует всю
// сцену на каждом тике — 60 раз в секунду даже на неподвижной карте, и
// слабая видеокарта (или WebKitGTK) тонет в этом ещё до всяких токенов и
// кубиков. Изменения ловим там, куда их сводит сам Pixi: любая правка графа
// (позиция, альфа, текстура, Graphics, добавление/удаление) проходит через
// RenderGroup, а новый кадр видео — через TextureSource.update. Расставлять
// «перерисуй» по всем слоям не нужно, и новый слой не забудет его вызвать.

let wake = null;

function hookPixi() {
  for (const name of ["onChildUpdate", "onChildViewUpdate", "addChild", "removeChild"]) {
    const orig = RenderGroup.prototype[name];
    RenderGroup.prototype[name] = function (...args) {
      if (wake) wake();
      return orig.apply(this, args);
    };
  }
  const origUpdate = TextureSource.prototype.update;
  TextureSource.prototype.update = function () {
    if (wake) wake();
    return origUpdate.call(this);
  };
}

// renderOnDemand — заменяет безусловный app.render в тикере на отрисовку по
// требованию.
export function renderOnDemand(app) {
  if (!wake) hookPixi();

  let pending = true;
  let rendering = false;
  // Правки изнутри самого render() — служебные (сброс флагов, пересчёт
  // трансформаций), новый кадр из-за них не нужен: иначе вечный цикл.
  wake = () => {
    if (!rendering) pending = true;
  };

  app.ticker.remove(app.render, app);
  app.ticker.add(
    () => {
      if (!pending) return;
      pending = false;
      rendering = true;
      try {
        app.render();
      } finally {
        rendering = false;
      }
    },
    null,
    UPDATE_PRIORITY.LOW,
  );

  // После потери контекста текстуры заливаются заново только на отрисовке.
  app.canvas.addEventListener("webglcontextrestored", wake);
}
