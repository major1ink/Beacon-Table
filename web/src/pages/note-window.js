// Отдельное браузерное окно одной заметки ДМ (открывается через
// window.open() из pages/dm.js — "🗗 Окно"). Тот же origin — cookie сессии ДМ
// браузер прикладывает сам, отдельного логина не нужно. Работает как
// самостоятельный мини-браузер по вики: клик по [[вики-ссылке]] подгружает
// другую заметку в этом же окне (не открывает третье окно), с обновлением
// ?id= в адресной строке через history.replaceState.
import { fetchMe, fetchNotes, fetchNote, createNote, updateNote, deleteNote } from "../api.js";
import { renderNoteHtml, wireWikiLinks } from "../notes/markdown.js";
import { mountNoteToolbar } from "../notes/toolbar.js";
import { icon } from "../icons.js";

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
mountNoteToolbar(document.getElementById("editToolbar"), editArea);

let notesList = [];
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
  } else {
    body.innerHTML = renderNoteHtml(note.content);
  }
}

async function loadNote(id, { edit = false } = {}) {
  msg.textContent = "";
  try {
    note = await fetchNote(id);
  } catch (err) {
    loadingHint.textContent = "Не удалось загрузить заметку: " + err.message;
    return;
  }
  loadingHint.style.display = "none";
  contentArea.style.display = "block";
  history.replaceState(null, "", "/note-window.html?id=" + id);
  editing = edit;
  render();
  // Список нужен только для резолва вики-ссылок — не блокируем сам показ
  // заметки на нём, подтягиваем отдельно.
  fetchNotes()
    .then((list) => (notesList = list))
    .catch(() => {});
}

wireWikiLinks(body, () => notesList, {
  // Как и в боковой панели: относительные ссылки считаются от папки
  // открытой заметки (см. resolveWikiTarget).
  getFolder: () => (note && note.folder) || "",
  onOpen: (id) => loadNote(id),
  onCreateMissing: async (title, folder) => {
    const where = folder ? ` в папке «${folder}»` : " в корне библиотеки";
    if (!confirm(`Заметки «${title}» не существует. Создать${where}?`)) return;
    try {
      const n = await createNote(`# ${title}\n\n`, folder);
      await loadNote(n.id, { edit: true });
    } catch (err) {
      alert("Не удалось создать заметку: " + err.message);
    }
  },
});

editToggleBtn.onclick = () => {
  editing = !editing;
  render();
};

saveBtn.onclick = async () => {
  msg.textContent = "";
  try {
    note = await updateNote(note.id, editArea.value);
    editing = false;
    render();
  } catch (err) {
    msg.textContent = err.message;
  }
};

deleteBtn.onclick = async () => {
  if (!note) return;
  if (!confirm(`Удалить заметку «${note.title}»? Это необратимо.`)) return;
  try {
    await deleteNote(note.id);
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
    alert("Не удалось удалить: " + err.message);
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
  await loadNote(id);
})();
