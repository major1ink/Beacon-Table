// board/editor.js — редактор доски: обёртка над Excalidraw (MIT, см.
// third_party/excalidraw). React только здесь, у board.html свой вход в сборке.
//
// Правки уезжают поэлементно по WebSocket (см. sync.js), сводит их сервер.
// На диск пишет тоже он — своего сохранения у страницы нет.
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  Excalidraw,
  reconcileElements,
  newElementWith,
  convertToExcalidrawElements,
  CaptureUpdateAction,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { connectBoard } from "./sync.js";

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

// Пауза перед отправкой: onChange срабатывает на каждое движение указателя,
// а правку соседу лучше показать быстро — отсюда десятки миллисекунд, а не
// секунды, как было у записи в файл.
const SEND_DELAY_MS = 60;
// Курсор шлём реже: он никуда не сохраняется и на глаз разницы нет.
const CURSOR_DELAY_MS = 100;

// PEER_COLORS — чем подписаны соседи. Excalidraw рисует курсор и имя сам,
// цвет надо дать; берём по устойчивому хэшу id, чтобы человек не менял цвет
// при каждом переподключении.
const PEER_COLORS = ["#7c6cf0", "#e0913a", "#3aa76d", "#d1495b", "#3a86c8", "#a44fb4"];

function colorFor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const c = PEER_COLORS[h % PEER_COLORS.length];
  return { background: c, stroke: c };
}

// LABEL_SHAPES — во что Excalidraw умеет вкладывать подпись. У стрелки и
// линии подпись тоже бывает, но там она посреди линии и смысл другой.
const LABEL_SHAPES = new Set(["rectangle", "ellipse", "diamond"]);

// needsLabel — фигура, которую есть смысл подписать: подходящая формой и ещё
// не подписанная. Чужой текст не трогаем.
function needsLabel(el, all) {
  if (!LABEL_SHAPES.has(el.type)) return false;
  const bound = el.boundElements || [];
  if (bound.some((b) => b.type === "text")) return false;
  return !all.some((e) => e.containerId === el.id && !e.isDeleted);
}

// makeBoundText — подпись внутри фигуры. Считает её не наш код, а сам
// Excalidraw: convertToExcalidrawElements меряет текст шрифтом и возвращает
// пару «контейнер + текст» с готовой привязкой. Контейнер оттуда мы
// выбрасываем — свой элемент правим сами, чтобы не растерять его поля.
function makeBoundText(el, text) {
  const made = convertToExcalidrawElements([
    {
      type: el.type,
      id: el.id,
      x: el.x,
      y: el.y,
      width: el.width,
      height: el.height,
      strokeColor: el.strokeColor,
      backgroundColor: el.backgroundColor,
      label: { text, textAlign: "center", verticalAlign: "middle" },
    },
  ]);
  const label = made.find((e) => e.type === "text");
  if (!label) return null;
  // containerId переписываем на всякий случай: конвертер волен выдать пару со
  // своим id контейнера, а привязка нужна к НАШЕМУ элементу.
  return label.containerId === el.id ? label : newElementWith(label, { containerId: el.id });
}

// mountBoardEditor монтирует редактор в el. scene — холст, прочитанный по
// HTTP для первой отрисовки; дальше всё идёт через WebSocket.
export function mountBoardEditor(el, { boardId, scene, readOnly = false, onStatus, onPeers, onSelection, onLinkOpen } = {}) {
  const root = createRoot(el);

  let api = null;
  // sent — версия каждого элемента, которую сервер уже знает: своя
  // отправленная или его же присланная. По ней и считается, что слать.
  const sent = new Map();
  const peers = new Map();
  let sendTimer = null;
  let cursorTimer = null;

  const conn = connectBoard(boardId, {
    onStatus,
    onSnapshot: (msg) => applyRemote(msg.elements || []),
    onChange: (elements) => applyRemote(elements),
    onPeers: (list) => {
      // Себя в списке соседей не показываем — курсор под своей же рукой не
      // нужен, а сервер шлёт список целиком.
      for (const id of [...peers.keys()]) {
        if (!list.some((p) => p.id === id)) peers.delete(id);
      }
      onPeers?.(list);
    },
    onCursor: (msg) => {
      peers.set(msg.id, {
        username: msg.name,
        pointer: { x: msg.x, y: msg.y, tool: "pointer" },
        selectedElementIds: Object.fromEntries((msg.selected || []).map((id) => [id, true])),
        color: colorFor(msg.id),
      });
      pushPeers();
    },
    onPeerLeft: (id) => {
      peers.delete(id);
      pushPeers();
    },
  });

  function pushPeers() {
    api?.updateScene({ collaborators: new Map(peers) });
  }

  // applyRemote — свести пришедшее с тем, что на экране. reconcileElements —
  // их собственная сводка: то же правило по version/versionNonce, что и на
  // сервере, плюс порядок элементов.
  function applyRemote(remote) {
    if (!api || !remote.length) return;
    const local = api.getSceneElementsIncludingDeleted();
    const reconciled = reconcileElements(local, remote, api.getAppState());
    api.updateScene({ elements: reconciled, captureUpdate: CaptureUpdateAction.NEVER });
    // Помечаем отправленным только то, что реально победило: если сводка
    // оставила НАШУ версию элемента, её ещё предстоит отослать.
    const byID = new Map(reconciled.map((e) => [e.id, e]));
    for (const r of remote) {
      const now = byID.get(r.id);
      if (now && now.version === r.version) sent.set(r.id, r.version);
    }
  }

  // flushChanges шлёт всё, чья версия разошлась с известной серверу. Идём по
  // getSceneElementsIncludingDeleted, а не по списку из onChange: удалённые
  // элементы туда не попадают, и удаление иначе не уехало бы никуда.
  function flushChanges() {
    sendTimer = null;
    if (!api || readOnly) return;
    const out = [];
    for (const e of api.getSceneElementsIncludingDeleted()) {
      if (sent.get(e.id) === e.version) continue;
      sent.set(e.id, e.version);
      out.push(e);
    }
    conn.sendChange(out);
  }

  function handleChange() {
    // onChange срабатывает и на смене выделения — этим же и пользуемся,
    // чтобы страница знала, есть ли что связывать.
    onSelection?.(selectedElement());
    if (readOnly || sendTimer) return;
    sendTimer = setTimeout(flushChanges, SEND_DELAY_MS);
  }

  // selectedElement — выделенный элемент, если он ровно один. Связывать с
  // заметкой скопом нечего: ссылка у элемента одна.
  function selectedElement() {
    if (!api) return null;
    const ids = Object.keys(api.getAppState().selectedElementIds || {});
    if (ids.length !== 1) return null;
    return api.getSceneElements().find((e) => e.id === ids[0]) || null;
  }

  function handlePointer({ pointer }) {
    if (readOnly || cursorTimer) return;
    cursorTimer = setTimeout(() => {
      cursorTimer = null;
      const selected = Object.keys(api?.getAppState().selectedElementIds || {});
      conn.sendCursor(pointer.x, pointer.y, selected);
    }, CURSOR_DELAY_MS);
  }

  root.render(
    createElement(Excalidraw, {
      initialData: {
        elements: (scene && scene.elements) || [],
        appState: (scene && scene.appState) || {},
        files: (scene && scene.files) || {},
      },
      files: (scene && scene.files) || {},
      excalidrawAPI: (instance) => {
        api = instance;
        for (const e of instance.getSceneElementsIncludingDeleted()) sent.set(e.id, e.version);
        // Вписываем содержимое в экран. initialData.scrollToContent не
        // годится: он доводит камеру до содержимого, но масштаб оставляет
        // как есть.
        const elements = instance.getSceneElements();
        if (elements.length) {
          instance.scrollToContent(elements, { fitToContent: true, animate: false, maxZoom: 1 });
        }
      },
      onChange: handleChange,
      onPointerUpdate: handlePointer,
      // Ссылку вида [[Заметка]] открываем сами (см. board/links.js), адрес —
      // пусть открывает как обычно.
      onLinkOpen: (element, event) => {
        if (onLinkOpen?.(element.link)) event.preventDefault();
      },
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
      // Сначала дописать, потом рвать связь: правка последней доли секунды
      // иначе никуда не уедет.
      if (sendTimer) clearTimeout(sendTimer);
      flushChanges();
      conn.close();
      root.unmount();
    },
    flush() {
      if (sendTimer) clearTimeout(sendTimer);
      flushChanges();
    },
    selectedElement,
    // setLink вешает ссылку на элемент и, если фигура пустая, подписывает её
    // названием: сама ссылка рисуется одним значком в углу, и без подписи на
    // холсте остаётся немой кружок. Так же это выглядит и в ваулте — там
    // подпись тоже обычный текст внутри фигуры, а не свойство ссылки.
    //
    // newElementWith сам поднимает version и versionNonce, поэтому правка
    // уезжает соседям обычным порядком.
    setLink(id, link, label) {
      if (!api || readOnly) return;
      const all = api.getSceneElementsIncludingDeleted();
      const target = all.find((e) => e.id === id);
      if (!target) return;

      const text = label && needsLabel(target, all) ? makeBoundText(target, label) : null;
      const next = all.map((e) => {
        if (e.id !== id) return e;
        const updates = { link };
        if (text) updates.boundElements = [...(e.boundElements || []), { type: "text", id: text.id }];
        return newElementWith(e, updates);
      });
      if (text) next.push(text);
      api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      handleChange();
    },
  };
}
