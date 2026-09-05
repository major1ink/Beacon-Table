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
  tools: { image: true },
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

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
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
export function mountBoardEditor(el, { boardId, scene, readOnly = false, onStatus, onPeers, onSelection, onLinkOpen, renderNote, isNoteLink, uploadImage } = {}) {
  const root = createRoot(el);

  let api = null;
  // sent — версия каждого элемента, которую сервер уже знает: своя
  // отправленная или его же присланная. По ней и считается, что слать.
  const sent = new Map();
  const peers = new Map();
  // knownFiles — картинки, чей адрес в загрузках стола уже известен: свои
  // выгруженные и чужие присланные. Заодно защита от повторной выгрузки —
  // onChange срабатывает много раз подряд.
  const knownFiles = new Map();
  const uploading = new Set();
  let sendTimer = null;
  let cursorTimer = null;

  const conn = connectBoard(boardId, {
    onStatus,
    onSnapshot: (msg) => {
      takeFiles(msg.files || []);
      applyRemote(msg.elements || []);
    },
    onFiles: takeFiles,
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

  // takeFiles — картинки, о которых сказал сервер: подкладываем их
  // Excalidraw, чтобы он нарисовал элементы image.
  function takeFiles(files) {
    for (const f of files) {
      if (!f || !f.fileId || knownFiles.has(f.fileId)) continue;
      knownFiles.set(f.fileId, f.url);
      addFileToScene(f.fileId, f.url);
    }
  }

  // addFileToScene — картинка со стола в виде, который понимает Excalidraw.
  // Он ждёт data-адрес, поэтому файл сначала выкачиваем: сам адрес остаётся
  // в файле доски, а тяжёлые байты живут только в памяти вкладки.
  async function addFileToScene(fileId, url) {
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const dataURL = await blobToDataURL(blob);
      api?.addFiles([{ id: fileId, dataURL, mimeType: blob.type, created: Date.now() }]);
    } catch {
      // Картинку удалили или нет доступа — элемент останется пустой рамкой.
    }
  }

  // pushLocalImages — картинки, которые вставил ЭТОТ человек. Excalidraw
  // кладёт их в сцену data-адресом; в файл доски такое пускать нельзя (пара
  // фотографий — и доска весит мегабайты), поэтому выгружаем в загрузки
  // стола и запоминаем адрес.
  function pushLocalImages() {
    if (readOnly || !api || !uploadImage) return;
    const files = api.getFiles() || {};
    for (const [fileId, file] of Object.entries(files)) {
      if (knownFiles.has(fileId) || uploading.has(fileId)) continue;
      if (!file || typeof file.dataURL !== "string" || !file.dataURL.startsWith("data:")) continue;
      uploading.add(fileId);
      uploadImage(file)
        .then((url) => {
          if (!url) return;
          knownFiles.set(fileId, url);
          markFileSaved(fileId);
          conn.sendFiles([{ fileId, url }]);
        })
        .finally(() => uploading.delete(fileId));
    }
  }

  // Только что вставленную картинку Excalidraw держит в состоянии pending —
  // «приложение файл ещё не сохранило». Сохранили: снимаем пометку, иначе
  // элемент так и уедет соседям недоделанным.
  function markFileSaved(fileId) {
    if (!api) return;
    let touched = false;
    const next = api.getSceneElementsIncludingDeleted().map((e) => {
      if (e.fileId !== fileId || e.status === "saved") return e;
      touched = true;
      return newElementWith(e, { status: "saved" });
    });
    if (touched) api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.NEVER });
  }

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
    pushLocalImages();
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
        // Снимок мог приехать раньше, чем редактор поднялся: подкладываем
        // картинки ещё раз, теперь уже есть кому.
        for (const [fileId, url] of knownFiles) addFileToScene(fileId, url);
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
      // Врезки пускаем только свои — ссылки на записи журнала. Всё чужое
      // (YouTube, Figma) осталось запрещённым: тянуть посторонние страницы в
      // iframe столу незачем. В файле такие элементы сохраняются, просто не
      // отрисовываются.
      validateEmbeddable: (link) => !!isNoteLink?.(link),
      // Содержимое врезки рисуем сами — см. renderNote в pages/board.js.
      renderEmbeddable: (element) => renderNote?.(element) ?? null,
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
    // linkedNotes — названия записей, на которые ссылается доска: страница по
    // ним перечитывает тексты врезок.
    linkedNotes() {
      if (!api) return [];
      const out = [];
      for (const e of api.getSceneElements()) {
        if (typeof e.link === "string" && e.link) out.push(e.link);
      }
      return out;
    },
    // repaint — перерисовать врезки после того, как их текст обновился.
    // Своей сцены это не меняет, поэтому captureUpdate NEVER: в отмену такое
    // попадать не должно.
    repaint() {
      if (!api) return;
      api.updateScene({
        elements: api.getSceneElementsIncludingDeleted(),
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    },
    // setLink вешает ссылку на элемент и, если фигура пустая, подписывает её
    // названием: сама ссылка рисуется одним значком в углу, и без подписи на
    // холсте остаётся немой кружок. Так же это выглядит и в ваулте — там
    // подпись тоже обычный текст внутри фигуры, а не свойство ссылки.
    //
    // newElementWith сам поднимает version и versionNonce, поэтому правка
    // уезжает соседям обычным порядком.
    setLink(id, link, label, asNote) {
      if (!api || readOnly) return;
      const all = api.getSceneElementsIncludingDeleted();
      const target = all.find((e) => e.id === id);
      if (!target) return;

      // Врезка — это тип embeddable: только его Excalidraw отдаёт нам на
      // отрисовку. Фигура при этом становится рамкой с текстом записи, и
      // своей формы (круг, ромб) у неё больше нет.
      const text = !asNote && label && needsLabel(target, all) ? makeBoundText(target, label) : null;
      const next = all.map((e) => {
        if (e.id !== id) return e;
        const updates = { link };
        if (asNote) updates.type = "embeddable";
        if (text) updates.boundElements = [...(e.boundElements || []), { type: "text", id: text.id }];
        return newElementWith(e, updates);
      });
      if (text) next.push(text);
      api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      handleChange();
    },
  };
}
