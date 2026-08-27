// Отдельное браузерное окно одной заметки ДМ (открывается через
// window.open() из pages/dm.js — "🗗 Окно"). Тот же origin — cookie сессии ДМ
// браузер прикладывает сам, отдельного логина не нужно. Работает как
// самостоятельный мини-браузер по вики: клик по [[вики-ссылке]] подгружает
// другую заметку в этом же окне (не открывает третье окно), с обновлением
// ?id= в адресной строке через history.replaceState.
import { fetchMe, fetchNotes, fetchNote, createNote, updateNote, deleteNote } from "../api.js";
import { renderNoteHtml, wireWikiLinks, scrollToHeading } from "../notes/markdown.js";
import { mountHeadingNav } from "../notes/heading-nav.js";
import { mountNoteToolbar } from "../notes/toolbar.js";
import { icon } from "../icons.js";
import { wireCatalogLinks } from "../catalog-links.js";
import { enhanceRolls } from "../inline-rolls.js";
import { showAlert, showConfirm } from "../modal.js";

const titleBar = document.getElementById("noteTitleBar");
const editToggleBtn = document.getElementById("editToggleBtn");
const saveBtn = document.getElementById("saveBtn");
const deleteBtn = document.getElementById("deleteBtn");
const msg = document.getElementById("msg");
const loadingHint = document.getElementById("loadingHint");
const contentArea = document.getElementById("contentArea");
const body = document.getElementById("body");
const editWrap = document.getElementById("editWrap");
const editArea = document.getElementById("editArea");
const tocBtn = document.getElementById("tocBtn");
mountNoteToolbar(document.getElementById("editToolbar"), editArea);
const headingNav = mountHeadingNav(tocBtn, body);

let notesList = [];
// pendingSection — раздел, на котором надо открыть заметку (см. scrollToSection).
let pendingSection = "";
let note = null;
let editing = false;

function currentId() {
  return new URLSearchParams(location.search).get("id");
}

function render() {
  titleBar.textContent = note ? note.title : "—";
  editToggleBtn.innerHTML = icon(editing ? "eye" : "pencil", { size: 14 });
  editToggleBtn.title = editing ? "Просмотр" : "Редактировать";
  editToggleBtn.classList.toggle("active", editing);
  saveBtn.style.display = editing ? "flex" : "none";
  body.style.display = editing ? "none" : "block";
  editWrap.style.display = editing ? "flex" : "none";
  if (editing) {
    editArea.value = note.content;
    editArea.focus();
    tocBtn.style.display = "none";
  } else {
    body.innerHTML = renderNoteHtml(note.content);
    // Формулы в тексте — кликабельные, как в карточках библиотек (см.
    // inline-rolls.js). Обход текста, а не делегированный обработчик, —
    // поэтому на каждую перерисовку.
    enhanceRolls(body, sendRoll);
    headingNav.refresh();
    scrollToSection();
  }
}

// scrollToSection — открыть заметку сразу на нужном разделе (pendingSection).
// Раздел приходит хэшем в адресе (#Название): так ссылка на СТРАНИЦУ журнала
// Foundry, которая у нас стала разделом «## Название» внутри заметки,
// попадает не в начало длинного текста, а куда вела (см.
// web/src/catalog-links.js: openEntry).
function scrollToSection() {
  const wanted = pendingSection;
  pendingSection = "";
  scrollToHeading(body, wanted);
}

// ---- броски из текста заметки ----
// Своя WS-связь, как у карточек предмета/заклинания (см. itembook.js:
// connectRollSocket): эта страница живёт отдельным окном и общего сокета
// стола не видит. Результат уходит в общий лог стола (его увидят все) и
// показывается тут же строкой — своего лога у окна заметки нет.
let rollWS = null;

function connectRollSocket() {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  rollWS = new WebSocket(`${scheme}//${location.host}/ws/dm`);
  rollWS.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
    if (data.type !== "roll_result") return;
    const mod = data.modifier ? (data.modifier > 0 ? "+" + data.modifier : String(data.modifier)) : "";
    msg.textContent = `${data.formula} → [${(data.rolls || []).join(", ")}]${mod} = ${data.total}`;
  };
}

function sendRoll(formula, label) {
  if (!rollWS || rollWS.readyState !== WebSocket.OPEN) return;
  const title = note && note.title;
  rollWS.send(JSON.stringify({ type: "roll_dice", formula, label: title ? `${title} — ${label}` : label }));
}

async function loadNote(id, { edit = false, section = "" } = {}) {
  pendingSection = section;
  msg.textContent = "";
  try {
    note = await fetchNote(id);
  } catch (err) {
    loadingHint.textContent = "Не удалось загрузить заметку: " + err.message;
    return;
  }
  loadingHint.style.display = "none";
  contentArea.style.display = "block";
  history.replaceState(null, "", "/note-window.html?id=" + id + (section ? "#" + encodeURIComponent(section) : ""));
  editing = edit;
  render();
  // Список нужен только для резолва вики-ссылок — не блокируем сам показ
  // заметки на нём, подтягиваем отдельно.
  fetchNotes()
    .then((list) => (notesList = list))
    .catch(() => {});
}

// Ссылки .catalog-ref (импорт модуля Foundry переводит в них свои @UUID[…],
// см. internal/foundry/links.go) — на карточки библиотек и другие заметки.
wireCatalogLinks(body);

wireWikiLinks(body, () => notesList, {
  // Как и в боковой панели: относительные ссылки считаются от папки
  // открытой заметки (см. resolveWikiTarget).
  getFolder: () => (note && note.folder) || "",
  onOpen: (id) => loadNote(id),
  onCreateMissing: async (title, folder) => {
    const where = folder ? ` в папке «${folder}»` : " в корне библиотеки";
    if (!(await showConfirm(`Заметки «${title}» не существует. Создать её${where}?`, { title: "Новая заметка", okLabel: "Создать" }))) return;
    try {
      const n = await createNote(`# ${title}\n\n`, folder);
      notifyHost("beacon:noteSaved", n.id);
      await loadNote(n.id, { edit: true });
    } catch (err) {
      showAlert("Не удалось создать заметку: " + err.message);
    }
  },
});

editToggleBtn.onclick = () => {
  editing = !editing;
  render();
};

// notifyHost — сообщить странице, которая открыла это окно (dm.js), что
// библиотека заметок изменилась: там свой список в левой панели, и без
// этого он оставался со старым заголовком/составом до перезагрузки. Тот же
// приём, что у карточек компендиума ("beacon:*Saved", см. catalog.js).
// Окно, вынесенное в отдельную вкладку браузера (window.parent === window),
// шлёт сообщение самому себе — там слушателя нет, и это не ошибка.
function notifyHost(type, id) {
  if (window.parent === window) return;
  window.parent.postMessage({ type, id }, location.origin);
}

saveBtn.onclick = async () => {
  msg.textContent = "";
  try {
    note = await updateNote(note.id, editArea.value);
    editing = false;
    render();
    notifyHost("beacon:noteSaved", note.id);
  } catch (err) {
    msg.textContent = err.message;
  }
};

deleteBtn.onclick = async () => {
  if (!note) return;
  if (!(await showConfirm(`Удалить заметку «${note.title}»?`, { title: "Удалить заметку", okLabel: "Удалить", danger: true, hint: "Это необратимо." }))) return;
  try {
    await deleteNote(note.id);
    notifyHost("beacon:noteDeleted", note.id);
    // По умолчанию эта страница живёт в плавающем окне поверх канваса, а не
    // в отдельной вкладке (см. web/src/floating-window.js) — там это
    // iframe, и window.close() у него молча ничего не делает. Родитель
    // слушает postMessage и закрывает плавающее окно сам; если же страницу
    // всё-таки вынесли в настоящее окно браузера (window.parent === window),
    // ведём себя как раньше.
    if (window.parent !== window) {
      window.parent.postMessage({ type: "beacon:closeFloatingWindow" }, location.origin);
    } else {
      window.close(); // если окно не открыто скриптом (напрямую по URL) — close() просто не сработает, это не ошибка
    }
  } catch (err) {
    showAlert("Не удалось удалить: " + err.message);
  }
};

(async function boot() {
  const me = await fetchMe();
  if (!me || me.role !== "admin") {
    location.href = "/";
    return;
  }
  const id = currentId();
  if (!id) {
    loadingHint.textContent = "Не указан id заметки (?id=...).";
    return;
  }
  connectRollSocket();
  await loadNote(id, { section: decodeURIComponent(location.hash.slice(1)) });
})();

// Смена только хэша (#раздел) окно не перезагружает — догоняем прокрутку
// руками (та же причина, что и в pages/journal.js).
window.addEventListener("hashchange", () => {
  pendingSection = decodeURIComponent(location.hash.slice(1));
  scrollToSection();
});
