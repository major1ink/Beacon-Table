// board/editor.js — редактор доски: обёртка над Excalidraw (MIT, см.
// third_party/excalidraw). React только здесь, у board.html свой вход в сборке.
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { Excalidraw, serializeAsJSON, getSceneVersion } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";

// Откуда брать шрифты. Без этого редактор грузит их с esm.sh. Кладёт их в
// статику сборка — см. excalidrawAssets в web/vite.config.js. Запасной адрес
// на esm.sh он дописывает сам, поэтому board.html ещё и режет внешние шрифты
// через Content-Security-Policy.
window.EXCALIDRAW_ASSET_PATH = "/excalidraw-assets/";

const UI_OPTIONS = {
  canvasActions: {
    // Открыть/сохранить файл — у доски своё место на сервере.
    loadScene: false,
    saveToActiveFile: false,
    export: false,
    saveAsImage: false,
    // Тема общая со столом.
    toggleTheme: false,
    changeViewBackgroundColor: true,
    clearCanvas: true,
  },
  // Excalidraw кладёт картинки в файл data-адресом. Нужны — через общую
  // загрузку стола, отдельной работой.
  tools: { image: false },
};

// Пауза перед записью: onChange срабатывает на каждое движение указателя.
const SAVE_DELAY_MS = 800;

// Поле формата source. Должно совпадать с NewDocument в internal/excalidraw.
const BOARD_SOURCE = "https://github.com/major1ink/Beacon-Table";

// mountBoardEditor монтирует редактор в el. scene — сцена с сервера (может
// быть null), onSave — вызывается готовым объектом сцены при изменении.
export function mountBoardEditor(el, { scene, readOnly = false, onSave } = {}) {
  const root = createRoot(el);

  let timer = null;
  // Версия сцены, которая уже уехала на сервер. Считается по элементам, так
  // что движение камеры и смена выделения записью не оборачиваются.
  let savedVersion = scene ? getSceneVersion(scene.elements || []) : 0;
  let pending = null;

  // send — отправить не через onSave: при закрытии окна fetch могут оборвать,
  // и страница шлёт то же самое через sendBeacon.
  function flush(send) {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!pending) return false;
    const data = pending;
    pending = null;
    (send || onSave)(data);
    return true;
  }

  function handleChange(elements, appState, files) {
    if (readOnly || !onSave) return;
    const version = getSceneVersion(elements);
    if (version === savedVersion) return;
    savedVersion = version;
    // serializeAsJSON вычищает из appState состояние сеанса (выделение,
    // камеру, открытые панели) и оставляет то, что кладётся в файл.
    pending = JSON.parse(serializeAsJSON(elements, appState, files || {}, "local"));
    // Иначе в source окажется адрес страницы, и файл будет меняться от того,
    // открыли стол с localhost или по адресу в сети.
    pending.source = BOARD_SOURCE;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, SAVE_DELAY_MS);
  }

  root.render(
    createElement(Excalidraw, {
      initialData: {
        elements: (scene && scene.elements) || [],
        appState: (scene && scene.appState) || {},
        files: (scene && scene.files) || {},
      },
      files: (scene && scene.files) || {},
      // Вписываем содержимое в экран. initialData.scrollToContent не годится:
      // он доводит камеру до содержимого, но масштаб оставляет как есть.
      excalidrawAPI: (api) => {
        const elements = api.getSceneElements();
        if (!elements.length) return;
        api.scrollToContent(elements, { fitToContent: true, animate: false, maxZoom: 1 });
      },
      onChange: handleChange,
      viewModeEnabled: readOnly,
      theme: "dark",
      langCode: "ru-RU",
      name: "",
      UIOptions: UI_OPTIONS,
      // Ходит на oss-ai.excalidraw.com.
      aiEnabled: false,
      // Встроенные объекты тянут чужие страницы в iframe. В файле остаются,
      // просто не отрисовываются.
      validateEmbeddable: false,
    })
  );

  return {
    destroy() {
      // Сначала дописать, потом снимать: иначе правка последней секунды
      // пропадёт.
      flush();
      root.unmount();
    },
    flush,
  };
}
