// pages/board.js — страница одной доски: забрать холст с сервера, отдать его
// редактору (см. board/editor.js) и показать, кто ещё за ней сидит.
//
// Сохранением страница не занимается вовсе: правки уходят по WebSocket, на
// диск пишет сервер.
import { createElement } from "react";
import { fetchMe, fetchBoard, fetchBoardScene, fetchJournal, fetchJournalEntry, uploadFile } from "../api.js";
import { mountBoardEditor } from "../board/editor.js";
import { parseWikilink, wikilink, findEntryByTitle } from "../board/links.js";
import { openModal, showAlert } from "../modal.js";
import { renderNoteHtml } from "../notes/markdown.js";
import { openFloatingWindow } from "../floating-window.js";

const editorRoot = document.getElementById("editorRoot");
const statusEl = document.getElementById("status");
const nameEl = document.getElementById("boardName");
const metaEl = document.getElementById("boardMeta");
const readonlyBadge = document.getElementById("readonlyBadge");
const linkState = document.getElementById("linkState");
const linkBtn = document.getElementById("linkBtn");
const peersEl = document.getElementById("peers");

// Доска открывается плавающим окном по ссылке board.html?id=… — см.
// openBoardWindow в board-list.js.
const boardId = new URLSearchParams(location.search).get("id") || "";

function fail(msg) {
  statusEl.textContent = msg;
  statusEl.style.display = "";
}

let me = "";
// Записи журнала для связывания. Читаются один раз при открытии доски:
// заводят их редко, а ходить в сеть на каждый клик по ссылке незачем.
let entries = [];
let selected = null;
// Текст записей для врезок. Держим отдельно от списка: список приходит без
// текста (см. handleJournalList), а врезка рисуется на каждый кадр — ходить
// в сеть оттуда нельзя.
const noteHtml = new Map();

// loadNote кладёт в кэш готовый HTML записи. Возвращает, изменилось ли что-то
// — по этому редактор решает, надо ли перерисовывать врезки.
async function loadNote(entry) {
  try {
    const full = await fetchJournalEntry(entry.id);
    const html = renderNoteHtml(full.content || "");
    if (noteHtml.get(entry.id) === html) return false;
    noteHtml.set(entry.id, html);
    return true;
  } catch {
    return false; // нет доступа или запись удалили — врезка покажет, что пусто
  }
}

// renderNote — содержимое врезки. Excalidraw зовёт это на отрисовку, поэтому
// только чтение из кэша, никакой сети.
function renderNote(element) {
  const title = parseWikilink(element.link);
  if (!title) return null;
  const entry = findEntryByTitle(entries, title);
  const html = entry ? noteHtml.get(entry.id) : null;
  return createElement("div", { className: "board-note" }, [
    createElement("div", { className: "board-note-title", key: "t" }, title),
    html
      ? createElement("div", {
          className: "board-note-body",
          key: "b",
          dangerouslySetInnerHTML: { __html: html },
        })
      : createElement("div", { className: "board-note-empty", key: "b" },
          entry ? "Запись пока пуста." : "Такой записи в журнале нет."),
  ]);
}

// openJournal — то же окно журнала, что открывают значки заметок на карте и
// боковое меню (key "journal", см. pages/dm.js).
function openJournal(entryId) {
  openFloatingWindow({
    key: "journal",
    title: "Журнал стола",
    url: "/journal.html?id=" + encodeURIComponent(entryId),
    navigate: true,
    width: 900,
    height: 640,
    popoutFeatures: "width=900,height=640",
  });
}

// followLink — true, если ссылку разобрали и открыли сами. Всё, что не
// [[Заметка]], пусть открывает Excalidraw как обычный адрес.
function followLink(link) {
  const title = parseWikilink(link);
  if (!title) return false;
  const entry = findEntryByTitle(entries, title);
  if (!entry) {
    showAlert("Записи «" + title + "» в журнале нет. Ссылка ведёт на заметку ваулта Obsidian.");
    return true;
  }
  openJournal(entry.id);
  return true;
}

// Кнопка живёт в шапке, а не в меню Excalidraw: своё меню он подменяет
// целиком, вместе со всеми стандартными пунктами.
function showSelection(el) {
  selected = el;
  linkBtn.hidden = !el;
  if (!el) return;
  const title = parseWikilink(el.link);
  linkBtn.textContent = title ? "Связано: " + title : "Связать с журналом";
}

async function pickEntry(current) {
  let select = null;
  let asNote = null;
  const ok = await openModal({
    title: "Связать с записью журнала",
    okLabel: "Связать",
    buildBody: (body) => {
      const hint = document.createElement("p");
      hint.className = "bt-modal-text";
      hint.textContent =
        "Ссылка хранится названием записи, как в Obsidian: та же доска в ваулте откроет одноимённую заметку.";
      body.appendChild(hint);
      select = document.createElement("select");
      select.className = "bt-modal-input";
      const none = document.createElement("option");
      none.value = "";
      none.textContent = "— без ссылки —";
      select.appendChild(none);
      for (const e of entries) {
        const opt = document.createElement("option");
        opt.value = e.title;
        opt.textContent = e.title + (e.folder ? " · " + e.folder : "");
        select.appendChild(opt);
      }
      select.value = current || "";
      body.appendChild(select);

      // Врезка — это уже не фигура со ссылкой, а рамка с текстом записи:
      // формы у неё не остаётся. Поэтому выбор явный, а не по умолчанию.
      asNote = document.createElement("label");
      asNote.className = "bt-modal-text";
      asNote.style.cssText = "display:flex;align-items:center;gap:8px;";
      const box = document.createElement("input");
      box.type = "checkbox";
      const cap = document.createElement("span");
      cap.textContent = "Показывать текст записи прямо на доске";
      asNote.append(box, cap);
      asNote.check = box;
      body.appendChild(asNote);

      const note = document.createElement("p");
      note.className = "bt-modal-text";
      note.textContent = "Тогда фигура станет рамкой с текстом — своей формы у неё не останется. Текст живой: правка записи видна на доске, в файле доски он не хранится.";
      body.appendChild(note);
    },
    onOk: () => ({ title: select.value, asNote: asNote.check.checked }),
    onCancel: () => null,
  });
  return ok;
}

// Пока связь есть, писать об этом нечего — а вот её отсутствие надо
// увидеть: правки в это время никуда не уходят.
function showStatus(state) {
  linkState.textContent = state === "online" ? "" : "нет связи";
  linkState.classList.toggle("err", state !== "online");
}

function showPeers(list) {
  const others = list.filter((p) => p.id !== me);
  peersEl.textContent = others.length ? "тут ещё: " + others.map((p) => p.name).join(", ") : "";
}

// uploadImage — картинку с доски кладём в загрузки стола, а в файле доски
// остаётся только адрес (см. board_files в internal/service/boardroom.go).
// Excalidraw отдаёт её data-адресом, поэтому переводим обратно в файл.
async function uploadImage(file) {
  try {
    const blob = await (await fetch(file.dataURL)).blob();
    const name = "board-" + (file.id || Date.now()) + extFor(blob.type);
    const { url } = await uploadFile(new File([blob], name, { type: blob.type }), "boards");
    return url;
  } catch (err) {
    showAlert("Не удалось загрузить картинку: " + ((err && err.message) || "ошибка"));
    return null;
  }
}

function extFor(mime) {
  if (mime === "image/png") return ".png";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/gif") return ".gif";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/svg+xml") return ".svg";
  return "";
}

(async function boot() {
  if (!boardId) {
    fail("Доска не указана.");
    return;
  }

  let board;
  let scene;
  try {
    // Свой id нужен, чтобы не показывать себя же в списке соседей.
    me = (await fetchMe())?.id || "";
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

  // Журнал нужен и на чтение ссылок, и на их раздачу. Не приехал — ссылки
  // просто не разрешатся по названию, доска от этого не ломается.
  entries = await fetchJournal().catch(() => []);

  statusEl.style.display = "none";
  const editor = mountBoardEditor(editorRoot, {
    boardId,
    scene,
    readOnly,
    onStatus: showStatus,
    onPeers: showPeers,
    onSelection: readOnly ? undefined : showSelection,
    onLinkOpen: followLink,
    renderNote,
    isNoteLink: (link) => parseWikilink(link) !== null,
    uploadImage,
  });

  // Тексты врезок перечитываем при возврате в окно: запись правят в журнале,
  // и доска не должна показывать вчерашний текст.
  async function refreshNotes() {
    const wanted = new Set();
    for (const e of scene.elements || []) {
      const title = e && parseWikilink(e.link);
      const entry = title && findEntryByTitle(entries, title);
      if (entry) wanted.add(entry);
    }
    for (const link of editor.linkedNotes()) {
      const title = parseWikilink(link);
      const entry = title && findEntryByTitle(entries, title);
      if (entry) wanted.add(entry);
    }
    const changed = await Promise.all([...wanted].map(loadNote));
    if (changed.some(Boolean)) editor.repaint();
  }
  await refreshNotes();
  window.addEventListener("focus", refreshNotes);

  linkBtn.onclick = async () => {
    if (!selected) return;
    const picked = await pickEntry(parseWikilink(selected.link));
    if (picked === null) return;
    const { title, asNote } = picked;
    const entry = title && findEntryByTitle(entries, title);
    if (entry) await loadNote(entry);
    editor.setLink(selected.id, title ? wikilink(title) : null, title, asNote && !!title);
    showSelection(editor.selectedElement());
  };

  // pagehide, а не beforeunload: срабатывает и когда вкладку убирают в фон
  // на телефоне, откуда она может не вернуться.
  window.addEventListener("pagehide", () => editor.flush());
})();
