// pages/board.js — страница одной доски: забрать сцену с сервера, отдать её
// редактору (см. board/editor.js) и складывать правки обратно.
import { fetchBoard, fetchBoardScene, saveBoardScene, saveBoardSceneBeacon } from "../api.js";
import { mountBoardEditor } from "../board/editor.js";

const editorRoot = document.getElementById("editorRoot");
const statusEl = document.getElementById("status");
const nameEl = document.getElementById("boardName");
const metaEl = document.getElementById("boardMeta");
const readonlyBadge = document.getElementById("readonlyBadge");
const saveState = document.getElementById("saveState");

// Доска открывается плавающим окном по ссылке board.html?id=… — см.
// openBoardWindow в board-list.js.
const boardId = new URLSearchParams(location.search).get("id") || "";

function fail(msg) {
  statusEl.textContent = msg;
  statusEl.style.display = "";
}

// Счётчик незавершённых записей: «сохраняю» гаснет по последней.
let saving = 0;

async function save(scene) {
  saving++;
  saveState.classList.remove("err");
  saveState.textContent = "сохраняю…";
  try {
    await saveBoardScene(boardId, scene);
    if (--saving === 0) saveState.textContent = "";
  } catch (err) {
    saving--;
    saveState.classList.add("err");
    saveState.textContent = (err && err.message) || "не сохранилось";
  }
}

(async function boot() {
  if (!boardId) {
    fail("Доска не указана.");
    return;
  }

  let board;
  let scene;
  try {
    board = await fetchBoard(boardId);
    scene = await fetchBoardScene(boardId);
  } catch (err) {
    fail((err && err.message) || "Не удалось открыть доску.");
    return;
  }

  nameEl.textContent = board.name;
  document.title = "Beacon Table — " + board.name;
  const who = board.ownerName ? "автор: " + board.ownerName : "заведена ДМ";
  metaEl.textContent = board.shared ? who + " · общая" : who + " · личная";
  // canEdit считает сервер, см. boardJSON в
  // internal/api/http/board_handlers.go.
  const readOnly = !board.canEdit;
  readonlyBadge.classList.toggle("on", readOnly);

  statusEl.style.display = "none";
  const editor = mountBoardEditor(editorRoot, {
    scene,
    readOnly,
    onSave: save,
  });

  // pagehide, а не beforeunload: срабатывает и когда вкладку убирают в фон
  // на телефоне, откуда она может не вернуться.
  window.addEventListener("pagehide", () => {
    editor.flush((scene) => saveBoardSceneBeacon(boardId, scene));
  });
})();
