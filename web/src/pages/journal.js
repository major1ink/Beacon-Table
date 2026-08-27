// Журнал стола (web/journal.html) — общая библиотека записей, в которую
// пишут и ДМ, и игроки, с фаундривскими правами на каждую запись: автор сам
// решает, кому её видно и кому можно править (см. domain.JournalEntry,
// service.JournalService). Одна и та же страница обслуживает обе роли —
// разницу задаёт сервер: он присылает вместе с записью уже вычисленные для
// ЭТОГО аккаунта myAccess/canEdit/canManage, клиент права не пересчитывает.
//
// Открывается плавающим окном поверх канваса и у ДМ (рейл «Журнал», см.
// pages/dm.js), и у игрока (иконка в боковом меню, см. pages/player.js).
// ?id=<запись> — открыть сразу на ней (так работает «Показать игрокам»).
import {
  fetchMe,
  fetchJournal,
  fetchJournalEntry,
  fetchJournalMembers,
  fetchJournalFolders,
  createJournalEntry,
  updateJournalEntry,
  setJournalAccess,
  moveJournalEntry,
  deleteJournalEntry,
  createJournalFolder,
  renameJournalFolder,
  deleteJournalFolder,
} from "../api.js";
import { renderNoteHtml, wireWikiLinks, scrollToHeading } from "../notes/markdown.js";
import { mountHeadingNav } from "../notes/heading-nav.js";
import { mountNoteToolbar } from "../notes/toolbar.js";
import { icon } from "../icons.js";
import { wireCatalogLinks } from "../catalog-links.js";
import { enhanceRolls } from "../inline-rolls.js";
import { showConfirm, showPrompt } from "../modal.js";

const treeEl = document.getElementById("tree");
const searchEl = document.getElementById("search");
const filtersEl = document.getElementById("filters");
const emptyHint = document.getElementById("emptyHint");
const entryView = document.getElementById("entryView");
const entryTitle = document.getElementById("entryTitle");
const entryBadge = document.getElementById("entryBadge");
const entryOwner = document.getElementById("entryOwner");
const entryUpdated = document.getElementById("entryUpdated");
const folderPicker = document.getElementById("folderPicker");
const folderSelect = document.getElementById("folderSelect");
const renderEl = document.getElementById("render");
const editWrap = document.getElementById("editWrap");
const editArea = document.getElementById("editArea");
const msgEl = document.getElementById("msg");
const showBtn = document.getElementById("showBtn");
const tocBtn = document.getElementById("tocBtn");
const pinBtn = document.getElementById("pinBtn");
const accessBtn = document.getElementById("accessBtn");
const editBtn = document.getElementById("editBtn");
const deleteBtn = document.getElementById("deleteBtn");
mountNoteToolbar(document.getElementById("toolbar"), editArea);
const headingNav = mountHeadingNav(tocBtn, renderEl);

// ACCESS_LEVELS — те же четыре уровня, что и на сервере
// (domain.JournalAccess), в порядке возрастания прав. Подписи —
// человеческие: «кому видно и что можно», а не имена констант.
const ACCESS_LEVELS = [
  { value: "none", label: "Нет доступа" },
  { value: "limited", label: "Только название" },
  { value: "observer", label: "Чтение" },
  { value: "owner", label: "Чтение и правка" },
];

let me = null;
let isDM = false;
let entries = []; // метаданные всех видимых мне записей (без текста)
let folders = [];
let members = [];
let current = null; // открытая запись целиком
let editing = false;
let filter = "all"; // all | shared | mine | others
// pendingSection — раздел («## Название»), на котором надо открыть запись.
// Страница журнала Foundry у нас становится разделом внутри записи (см.
// internal/foundry/journal.go), и ссылка на неё должна попадать не в начало
// длинного текста, а туда, куда вела. Приезжает хэшем адреса, тем же
// приёмом, что в окне заметки ДМ (pages/note-window.js).
let pendingSection = "";
let currentFolder = ""; // куда ляжет новая запись/папка
const openFolders = new Set();

// ---- список и дерево ----

async function refreshList({ keepMessage = false } = {}) {
  if (!keepMessage) msgEl.textContent = "";
  try {
    [entries, folders] = await Promise.all([fetchJournal(), fetchJournalFolders()]);
  } catch (err) {
    treeEl.innerHTML = "";
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "Не удалось загрузить журнал: " + err.message;
    treeEl.appendChild(hint);
    return;
  }
  renderTree();
  renderFolderSelect();
}

// matchesFilter — чипы над деревом: «Общие» (default открыт всему столу),
// «Мои» (я автор), «Со мной» (чужая запись, до которой мне дали доступ
// персонально или которая общая). ДМ видит вообще всё, поэтому для него
// «Со мной» — это просто «чужие».
function matchesFilter(e) {
  switch (filter) {
    case "shared":
      return e.shared;
    case "mine":
      return e.ownerId === me.id;
    case "others":
      return e.ownerId !== me.id;
    default:
      return true;
  }
}

function visibleEntries() {
  const q = searchEl.value.trim().toLowerCase();
  return entries.filter((e) => {
    if (!matchesFilter(e)) return false;
    if (!q) return true;
    return (e.title || "").toLowerCase().includes(q) || (e.ownerName || "").toLowerCase().includes(q);
  });
}

// folderTree — дерево из плоских путей записей и папок (тот же приём, что и
// в дереве заметок ДМ, см. pages/dm.js: noteFolderTree). Пустые папки
// приезжают отдельным списком — иначе только что созданная папка пропадала
// бы до первой записи в ней.
function folderTree(list) {
  const root = { path: "", name: "", children: new Map(), entries: [] };
  function nodeFor(path) {
    let node = root;
    let acc = "";
    for (const segment of path ? path.split("/") : []) {
      acc = acc ? acc + "/" + segment : segment;
      if (!node.children.has(segment)) {
        node.children.set(segment, { path: acc, name: segment, children: new Map(), entries: [] });
      }
      node = node.children.get(segment);
    }
    return node;
  }
  for (const folder of folders) nodeFor(folder);
  for (const e of list) nodeFor(e.folder || "").entries.push(e);
  return root;
}

function countEntries(node) {
  let total = node.entries.length;
  for (const child of node.children.values()) total += countEntries(child);
  return total;
}

// accessDot — значок слева от заголовка: чем запись является для стола.
// Зелёный — общая (читают все), янтарный — видно только название, пустой
// кружок — личная (кроме автора и ДМ её не видит никто).
function accessDot(e) {
  const dot = document.createElement("span");
  dot.className = "acc-dot " + (e.shared ? "shared" : e.default === "limited" ? "limited" : "private");
  dot.title = e.shared ? "Общая — читает весь стол" : e.default === "limited" ? "Столу видно только название" : "Личная запись";
  return dot;
}

function entryRowEl(e, depth) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "entry-row" + (current && current.id === e.id ? " current" : "");
  row.style.paddingLeft = 8 + depth * 12 + "px";

  const ico = document.createElement("span");
  ico.className = "entry-row-icon";
  ico.innerHTML = icon("scroll", { size: 13 });

  const title = document.createElement("span");
  title.className = "entry-row-title";
  title.textContent = e.title;

  const owner = document.createElement("span");
  owner.className = "entry-row-owner";
  owner.textContent = e.ownerName || (e.ownerId ? "" : "ДМ");
  owner.title = "Автор: " + (e.ownerName || "ДМ");

  row.append(accessDot(e), ico, title, owner);
  row.onclick = () => openEntry(e.id);
  return row;
}

function folderRowEl(node, depth) {
  const open = openFolders.has(node.path);
  const row = document.createElement("div");
  row.className = "folder-row" + (open ? " open" : "") + (currentFolder === node.path ? " current" : "");
  row.style.paddingLeft = 6 + depth * 12 + "px";

  const chevron = document.createElement("span");
  chevron.className = "folder-chevron";
  chevron.innerHTML = icon("chevron-right", { size: 12 });
  const folderIcon = document.createElement("span");
  folderIcon.className = "folder-icon";
  folderIcon.innerHTML = icon("folder", { size: 13 });
  const name = document.createElement("span");
  name.className = "folder-name";
  name.textContent = node.name;
  const count = document.createElement("span");
  count.className = "folder-count";
  count.textContent = countEntries(node) || "";

  row.append(chevron, folderIcon, name, count);
  row.onclick = () => {
    if (open) openFolders.delete(node.path);
    else openFolders.add(node.path);
    currentFolder = node.path;
    renderTree();
  };

  // Переименование и удаление папки задевают чужие записи, поэтому кнопки —
  // только ДМ (сервер откажет игроку и сам, см. JournalService.RenameFolder/
  // DeleteFolder — тут просто не показываем заведомо запрещённое).
  if (isDM) {
    const actions = document.createElement("span");
    actions.className = "folder-actions";
    actions.appendChild(iconBtn("pencil", "Переименовать папку", async (ev) => {
      ev.stopPropagation();
      const next = await showPrompt("Новое имя папки:", { title: "Переименовать папку", value: node.name, okLabel: "Переименовать" });
      if (!next || !next.trim() || next.trim() === node.name) return;
      const parent = node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : "";
      await guard(() => renameJournalFolder(node.path, parent ? parent + "/" + next.trim() : next.trim()));
      await refreshList();
    }));
    actions.appendChild(iconBtn("trash", "Удалить папку со всеми записями", async (ev) => {
      ev.stopPropagation();
      const ok = await showConfirm(`Удалить папку «${node.name}» вместе со всеми записями внутри?`, {
        title: "Удалить папку",
        okLabel: "Удалить",
        danger: true,
        hint: "Это необратимо.",
      });
      if (!ok) return;
      await guard(() => deleteJournalFolder(node.path));
      await refreshList();
    }, "danger"));
    row.appendChild(actions);
  }
  return row;
}

function iconBtn(name, title, onClick, extraClass = "") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "icon-btn " + extraClass;
  btn.title = title;
  btn.innerHTML = icon(name, { size: 12 });
  btn.onclick = onClick;
  return btn;
}

function rootRowEl(node) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "root-row" + (currentFolder === "" ? " current" : "");
  const name = document.createElement("span");
  name.className = "folder-name";
  name.textContent = "Журнал стола";
  const count = document.createElement("span");
  count.className = "folder-count";
  count.textContent = countEntries(node) || "";
  row.append(name, count);
  row.onclick = () => {
    currentFolder = "";
    renderTree();
  };
  return row;
}

function appendNode(container, node, depth) {
  for (const child of [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name, "ru"))) {
    container.appendChild(folderRowEl(child, depth));
    if (openFolders.has(child.path)) appendNode(container, child, depth + 1);
  }
  for (const e of [...node.entries].sort((a, b) => a.title.localeCompare(b.title, "ru"))) {
    container.appendChild(entryRowEl(e, depth));
  }
}

function renderTree() {
  const list = visibleEntries();
  const scrollTop = treeEl.scrollTop;
  const rows = document.createDocumentFragment();

  // Поиск — плоский список по всему журналу: искать «где-то в дереве» и
  // значит не думать о папках (тот же приём, что и в заметках ДМ).
  if (searchEl.value.trim()) {
    if (!list.length) {
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = "Ничего не найдено.";
      rows.appendChild(hint);
    } else {
      for (const e of list) rows.appendChild(entryRowEl(e, 0));
    }
    treeEl.replaceChildren(rows);
    treeEl.scrollTop = 0;
    return;
  }

  const tree = folderTree(list);
  rows.appendChild(rootRowEl(tree));
  appendNode(rows, tree, 0);
  if (!list.length && !folders.length) {
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "Журнал пуст — заведи первую запись кнопкой снизу.";
    rows.appendChild(hint);
  }
  treeEl.replaceChildren(rows);
  treeEl.scrollTop = scrollTop;
}

function renderFolderSelect() {
  folderSelect.innerHTML = "";
  for (const path of ["", ...folders]) {
    const opt = document.createElement("option");
    opt.value = path;
    opt.textContent = path || "корень журнала";
    if (current && (current.folder || "") === path) opt.selected = true;
    folderSelect.appendChild(opt);
  }
}

// ---- открытая запись ----

let openSeq = 0;

async function openEntry(id, { edit = false, section = "" } = {}) {
  const seq = ++openSeq;
  pendingSection = section;
  await flushPendingSave(); // уходя с записи, не теряем недосохранённое
  let entry;
  try {
    entry = await fetchJournalEntry(id);
  } catch (err) {
    if (seq !== openSeq) return;
    msgEl.textContent = err.message;
    return;
  }
  if (seq !== openSeq) return;
  current = entry;
  editing = edit && entry.canEdit;
  revealFolder(entry.folder || "");
  // Адрес окна должен указывать на открытую запись: журнал живёт одним окном
  // на весь стол (см. player.js: openJournalWindow), и ссылка «покажи вот
  // это» переводит его именно сменой url — без replaceState следующий такой
  // переход сравнивал бы новый адрес со старым и решил, что идти некуда.
  history.replaceState(null, "", "/journal.html?id=" + id + (section ? "#" + encodeURIComponent(section) : ""));
  renderEntry();
  renderTree();
}

// scrollToSection — открыть запись сразу на нужном разделе (pendingSection),
// с короткой подсветкой: иначе непонятно, почему текст открылся с середины.
function scrollToSection() {
  const wanted = pendingSection;
  pendingSection = "";
  scrollToHeading(renderEl, wanted);
}

// revealFolder — раскрыть цепочку папок до записи и сделать её папку
// текущей: запись открывают не только кликом по дереву (поиск, ссылка
// [[…]], «Показать игрокам»), и без этого дерево осталось бы свёрнутым.
function revealFolder(folder) {
  currentFolder = folder;
  let acc = "";
  for (const segment of folder ? folder.split("/") : []) {
    acc = acc ? acc + "/" + segment : segment;
    openFolders.add(acc);
  }
}

function renderEntry() {
  emptyHint.style.display = current ? "none" : "block";
  entryView.style.display = current ? "flex" : "none";
  if (!current) return;

  entryTitle.textContent = current.title;
  entryOwner.textContent = "Автор: " + (current.ownerName || "ДМ");
  entryUpdated.textContent = current.updatedAt ? new Date(current.updatedAt).toLocaleString("ru") : "";

  // Плашка справа от заголовка — то, что важно понять про запись с одного
  // взгляда: общая она или её текст мне вообще не отдали.
  if (current.myAccess === "limited") {
    entryBadge.textContent = "Только название";
    entryBadge.className = "badge readonly";
    entryBadge.style.display = "";
  } else if (current.shared) {
    entryBadge.textContent = "Общая";
    entryBadge.className = "badge shared";
    entryBadge.style.display = "";
  } else {
    entryBadge.style.display = "none";
  }

  editBtn.style.display = current.canEdit ? "flex" : "none";
  editBtn.classList.toggle("active", editing);
  editBtn.innerHTML = icon(editing ? "eye" : "pencil", { size: 15 });
  editBtn.title = editing ? "Просмотр" : "Редактировать";
  accessBtn.style.display = current.canManage ? "flex" : "none";
  deleteBtn.style.display = current.canManage ? "flex" : "none";
  folderPicker.style.display = current.canManage ? "flex" : "none";
  showBtn.style.display = isDM ? "flex" : "none";
  // Значки на карте расставляет и видит только ДМ (сервер шлёт
  // scene.noteMarkers одной этой роли, см. service.Room.sceneFor).
  pinBtn.style.display = isDM ? "flex" : "none";
  renderFolderSelect();

  editWrap.style.display = editing ? "flex" : "none";
  renderEl.style.display = editing ? "none" : "block";
  if (editing) {
    editArea.value = current.content || "";
    editArea.focus();
    tocBtn.style.display = "none";
  } else if (current.myAccess === "limited") {
    renderEl.innerHTML = "";
    const hint = document.createElement("p");
    hint.style.opacity = ".6";
    hint.textContent = "Автор открыл тебе только название этой записи.";
    renderEl.appendChild(hint);
    tocBtn.style.display = "none";
  } else {
    renderEl.innerHTML = renderNoteHtml(current.content || "");
    // Формулы в тексте кликабельны, как в карточках библиотек — бросок
    // уходит в общий лог стола (см. inline-rolls.js).
    enhanceRolls(renderEl, sendRoll);
    // Картинки из текста записи — кнопка «Показать игрокам» при наведении
    // (только ДМ), см. wireShowcaseImages ниже.
    wireShowcaseImages();
    headingNav.refresh(); // кнопка «перейти к разделу» — только если разделов ≥2
    scrollToSection();
  }
}

// ---- правка и автосохранение ----
//
// Текст сохраняется сам, по паузе в наборе: журнал за столом пишут по ходу
// игры, и «забыл нажать сохранить» тут стоит дороже лишнего запроса. Права
// при этом не трогаются вообще — у них свой эндпоинт (см. setJournalAccess).

const AUTOSAVE_MS = 1200;
let saveTimer = null;
let savePending = false;

function scheduleSave() {
  savePending = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, AUTOSAVE_MS);
}

async function saveNow() {
  clearTimeout(saveTimer);
  if (!savePending || !current || !current.canEdit) return;
  savePending = false;
  const text = editArea.value;
  try {
    const saved = await updateJournalEntry(current.id, text);
    current = saved;
    msgEl.className = "ok";
    msgEl.textContent = "Сохранено";
    entryTitle.textContent = current.title;
    await refreshList({ keepMessage: true });
  } catch (err) {
    msgEl.className = "";
    msgEl.textContent = err.message;
  }
}

// flushPendingSave — дописать несохранённое перед уходом с записи/закрытием
// окна: таймер автосейва иначе просто не успел бы сработать.
async function flushPendingSave() {
  if (savePending) await saveNow();
}

editArea.addEventListener("input", scheduleSave);
// Уход фокуса из текста — тоже повод дописать: окно журнала закрывают, не
// дожидаясь таймера, куда чаще, чем окно заметки (запись на полстроки —
// нормальный размер здесь).
editArea.addEventListener("blur", flushPendingSave);

editBtn.onclick = async () => {
  if (!current || !current.canEdit) return;
  if (editing) await flushPendingSave();
  editing = !editing;
  msgEl.textContent = "";
  renderEntry();
};

deleteBtn.onclick = async () => {
  if (!current) return;
  const ok = await showConfirm(`Удалить запись «${current.title}»?`, {
    title: "Удалить запись",
    okLabel: "Удалить",
    danger: true,
    hint: "Это необратимо.",
  });
  if (!ok) return;
  await guard(async () => {
    await deleteJournalEntry(current.id);
    current = null;
    renderEntry();
    await refreshList();
  });
};

folderSelect.onchange = async () => {
  if (!current) return;
  await guard(async () => {
    current = await moveJournalEntry(current.id, folderSelect.value);
    revealFolder(current.folder || "");
    msgEl.className = "ok";
    msgEl.textContent = current.folder ? `Перенесено в «${current.folder}».` : "Перенесено в корень журнала.";
    await refreshList({ keepMessage: true });
  });
};

// ---- создание ----

async function createEntry(def) {
  const shared = def === "observer";
  const title = await showPrompt("Заголовок:", {
    title: shared ? "Новая запись в общий журнал" : "Новая запись",
    placeholder: "Тайник у мельницы",
    okLabel: "Создать",
    hint: shared
      ? "Запись сразу прочитает весь стол — права можно изменить потом."
      : "Запись видна только тебе и ДМ, пока не откроешь её другим.",
  });
  if (!title || !title.trim()) return;
  await guard(async () => {
    const created = await createJournalEntry({
      content: `# ${title.trim()}\n\n`,
      folder: currentFolder,
      def,
    });
    await refreshList();
    await openEntry(created.id, { edit: true });
  });
}

document.getElementById("newEntryBtn").onclick = () => createEntry("none");
document.getElementById("newSharedBtn").onclick = () => createEntry("observer");

document.getElementById("newFolderBtn").onclick = async () => {
  const name = await showPrompt("Имя папки:", {
    title: "Новая папка",
    placeholder: "Хроники",
    okLabel: "Создать",
    hint: currentFolder ? `Внутри «${currentFolder}».` : "В корне журнала.",
  });
  if (!name || !name.trim()) return;
  await guard(async () => {
    await createJournalFolder(currentFolder ? currentFolder + "/" + name.trim() : name.trim());
    openFolders.add(currentFolder);
    await refreshList();
  });
};

// ---- фильтры и поиск ----

filtersEl.addEventListener("click", (e) => {
  const chip = e.target.closest(".filter-chip");
  if (!chip) return;
  filter = chip.dataset.filter;
  for (const c of filtersEl.querySelectorAll(".filter-chip")) c.classList.toggle("active", c === chip);
  renderTree();
});
searchEl.oninput = renderTree;

// ---- диалог прав (фаундривское "Configure Ownership") ----

const accessOverlay = document.getElementById("accessOverlay");
const accessBody = document.getElementById("accessBody");
const accessMsg = document.getElementById("accessMsg");

function accessSelect(value, { withInherit }) {
  const sel = document.createElement("select");
  if (withInherit) {
    // «По умолчанию» — отсутствие персональной выдачи (сервер такие просто
    // не хранит, см. normalizeAccess): человеку это понятнее, чем "none",
    // который выглядел бы как запрет поверх открытой всем записи.
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Как у всех";
    sel.appendChild(opt);
  }
  for (const level of ACCESS_LEVELS) {
    const opt = document.createElement("option");
    opt.value = level.value;
    opt.textContent = level.label;
    sel.appendChild(opt);
  }
  sel.value = value;
  return sel;
}

function openAccessDialog() {
  if (!current || !current.canManage) return;
  accessMsg.textContent = "";
  accessBody.innerHTML = "";

  const defaultRow = document.createElement("div");
  defaultRow.className = "access-row";
  const defaultWho = document.createElement("span");
  defaultWho.className = "who";
  defaultWho.innerHTML = "<b>Все за столом</b><small>кому персонально ничего не выдано</small>";
  const defaultSel = accessSelect(current.default || "none", { withInherit: false });
  defaultRow.append(defaultWho, defaultSel);
  accessBody.appendChild(defaultRow);

  const divider = document.createElement("div");
  divider.className = "access-divider";
  accessBody.appendChild(divider);

  const access = current.access || {};
  const perMember = [];
  for (const m of members) {
    if (m.id === current.ownerId) continue; // автор и так владелец, выдавать нечего
    const row = document.createElement("div");
    row.className = "access-row";
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = m.username;
    const sel = accessSelect(access[m.id] || "", { withInherit: true });
    row.append(who, sel);
    accessBody.appendChild(row);
    perMember.push({ id: m.id, sel });
  }
  if (!perMember.length) {
    const note = document.createElement("div");
    note.className = "access-note";
    note.textContent = "За столом пока нет других игроков — доступ выдавать некому.";
    accessBody.appendChild(note);
  }

  const note = document.createElement("div");
  note.className = "access-note";
  note.textContent =
    "ДМ видит и правит журнал целиком, независимо от этих настроек. " +
    "«Чтение и правка» позволяет менять текст, но не раздавать доступ и не удалять запись — это остаётся за тобой.";
  accessBody.appendChild(note);

  accessOverlay.style.display = "flex";
  document.getElementById("accessSaveBtn").onclick = async () => {
    const map = {};
    for (const { id, sel } of perMember) {
      if (sel.value) map[id] = sel.value;
    }
    try {
      current = await setJournalAccess(current.id, defaultSel.value, map);
      accessOverlay.style.display = "none";
      renderEntry();
      await refreshList();
    } catch (err) {
      accessMsg.textContent = err.message;
    }
  };
}

accessBtn.onclick = openAccessDialog;
document.getElementById("accessCloseBtn").onclick = () => (accessOverlay.style.display = "none");
document.getElementById("accessCancelBtn").onclick = () => (accessOverlay.style.display = "none");
accessOverlay.addEventListener("mousedown", (e) => {
  if (e.target === accessOverlay) accessOverlay.style.display = "none";
});

// ---- «Показать игрокам» (ДМ) ----
//
// Ровно фаундривская кнопка: открывает эту запись у всех игроков за столом,
// не заставляя каждого искать её в списке. Доступ она НЕ выдаёт — если
// запись игроку не открыта, у него она просто не откроется (см.
// relayJournalShow в internal/service/room.go).
showBtn.onclick = () => {
  if (!current) return;
  if (!rollWS || rollWS.readyState !== WebSocket.OPEN) {
    // Молчать тут нельзя: снаружи оборванная связь со столом выглядит ровно
    // как «кнопка не работает».
    msgEl.className = "";
    msgEl.textContent = "Нет связи со столом — обнови страницу и попробуй снова.";
    return;
  }
  rollWS.send(JSON.stringify({ type: "show_journal", id: current.id, label: current.title }));
  msgEl.className = "ok";
  msgEl.textContent = "Показываю…"; // окончательный ответ придёт в journal_shown_ack
};

// pinBtn — значок записи на карте, как у заметок ДМ (см. domain.NoteMarker).
// Само окно журнала канваса не видит — оно живёт в iframe поверх него,
// поэтому просит расстановку у страницы-хозяина (pages/dm.js), тем же
// postMessage-мостом, каким открываются плавающие окна.
pinBtn.onclick = () => {
  if (!current) return;
  window.parent.postMessage(
    { type: "beacon:placeJournalMarker", id: current.id, title: current.title },
    location.origin
  );
  msgEl.className = "ok";
  msgEl.textContent = "Кликни на карте, куда поставить значок.";
};

// ---- «Показать игрокам» для картинок из текста записи (только ДМ) ----
//
// В приключении картинка (портрет NPC, карта локации, раздатка) обычно лежит
// прямо в тексте записи — и её нужно быстро вывести игрокам, не выясняя, где
// её файл. При наведении на картинку у ДМ всплывает кнопка: она шлёт ту же
// WS-команду show_image, что и раздел «Показ» у ДМ (см.
// web/src/showcase-overlay.js, broadcastShowcase в internal/service/room.go).
// Идёт через тот же сокет rollWS, что и броски из текста.

let shownImageUrl = ""; // что сейчас на экране у игроков (из сообщений showcase)

// imgShowUrl — что слать в show_image: для своих же файлов путь без хоста
// (как хранит раздел «Показ»), для внешних картинок — абсолютный URL.
function imgShowUrl(img) {
  try {
    const u = new URL(img.currentSrc || img.src, location.href);
    return u.origin === location.origin ? u.pathname + u.search : u.href;
  } catch {
    return img.currentSrc || img.src;
  }
}

function sendShowImage(url) {
  if (!rollWS || rollWS.readyState !== WebSocket.OPEN) {
    msgEl.className = "";
    msgEl.textContent = "Нет связи со столом — обнови страницу и попробуй снова.";
    return;
  }
  rollWS.send(JSON.stringify(url ? { type: "show_image", imageUrl: url } : { type: "hide_image" }));
}

// wireShowcaseImages — оборачивает каждую <img> в тексте записи span'ом с
// кнопкой (появляется по ховеру). Повторный запуск на уже обёрнутых
// картинках пропускает их (renderEntry зовёт нас на каждый ре-рендер).
function wireShowcaseImages() {
  if (!isDM) return;
  for (const img of renderEl.querySelectorAll("img")) {
    if (img.parentElement && img.parentElement.classList.contains("note-img-wrap")) continue;
    const wrap = document.createElement("span");
    wrap.className = "note-img-wrap";
    img.replaceWith(wrap);
    wrap.appendChild(img);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "note-img-show";
    btn.onclick = (e) => {
      e.preventDefault();
      const url = imgShowUrl(img);
      sendShowImage(url === shownImageUrl ? "" : url); // повторный клик по показываемой — снять
    };
    wrap.appendChild(btn);
  }
  refreshShowcaseButtons();
}

// refreshShowcaseButtons — подписи/подсветка кнопок под текущее состояние
// показа (приходит в сообщениях showcase, см. connectRollSocket).
function refreshShowcaseButtons() {
  for (const wrap of renderEl.querySelectorAll(".note-img-wrap")) {
    const img = wrap.querySelector("img");
    const btn = wrap.querySelector(".note-img-show");
    if (!img || !btn) continue;
    const showing = !!shownImageUrl && imgShowUrl(img) === shownImageUrl;
    wrap.classList.toggle("showing", showing);
    btn.innerHTML =
      icon(showing ? "eye-off" : "eye", { size: 13 }) + (showing ? " Убрать с экрана" : " Показать игрокам");
  }
}

// ---- броски из текста записи ----
// Своя WS-связь, как у карточек предмета/заклинания (см. itembook.js):
// страница живёт отдельным окном и общего сокета стола не видит. /ws/player
// требует роль player, поэтому ДМ ходит через /ws/dm.

let rollWS = null;

function connectRollSocket() {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  rollWS = new WebSocket(`${scheme}//${location.host}${isDM ? "/ws/dm" : "/ws/player"}`);
  rollWS.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
    if (data.type === "journal_changed") {
      onJournalChanged(data.id);
      return;
    }
    if (data.type === "showcase") {
      // Что сейчас на экране у игроков (см. broadcastShowcase) — чтобы
      // кнопка на картинке в тексте знала, показывается ли ИМЕННО она, и
      // переключалась на «Убрать с экрана». Приходит и при открытии окна
      // (Room.run досылает свежеподключившемуся).
      shownImageUrl = (data.showcase && data.showcase.url) || "";
      refreshShowcaseButtons();
      return;
    }
    if (data.type === "journal_shown_ack") {
      // Сколько игроков реально получили показ (см. relayJournalShow):
      // «никому» — это не успех, и ДМ должен это видеть, а не гадать,
      // сработала кнопка или нет.
      msgEl.className = data.count ? "ok" : "";
      msgEl.textContent = data.count
        ? `Запись открыта у ${data.count} ${data.count === 1 ? "игрока" : "игроков"}.`
        : "За столом сейчас нет игроков — показывать некому.";
      return;
    }
    if (data.type !== "roll_result") return;
    const mod = data.modifier ? (data.modifier > 0 ? "+" + data.modifier : String(data.modifier)) : "";
    msgEl.className = "ok";
    msgEl.textContent = `${data.formula} → [${(data.rolls || []).join(", ")}]${mod} = ${data.total}`;
  };
}

// ---- живое обновление ----
//
// Журнал общий, а окно у каждого своё: без этого чужая запись появлялась бы
// только после перезагрузки страницы. Сервер шлёт «журнал изменился» всем за
// столом на любую правку (см. RoomService.NotifyJournalChanged), окно
// перечитывает список — и, если поменяли ровно ту запись, что открыта, её
// саму. Событие приходит и на СВОИ правки тоже — лишний перечит списка
// дешевле, чем гадать, чьё это изменение.

const REFRESH_DEBOUNCE_MS = 250;
let refreshTimer = null;

function onJournalChanged(id) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    await refreshList({ keepMessage: true });
    if (!current || !id || id !== current.id) return;
    // Свою же правку перечитывать незачем — она и так только что приехала
    // ответом на сохранение; а в режиме правки перечитывание затёрло бы
    // текст, который человек прямо сейчас набирает.
    if (editing || savePending) return;
    try {
      current = await fetchJournalEntry(current.id);
      renderEntry();
    } catch {
      // Запись удалили или у нас отобрали доступ, пока она была открыта.
      current = null;
      renderEntry();
      renderTree();
      msgEl.className = "";
      msgEl.textContent = "Эта запись больше недоступна.";
    }
  }, REFRESH_DEBOUNCE_MS);
}

function sendRoll(formula, label) {
  if (!rollWS || rollWS.readyState !== WebSocket.OPEN) return;
  const title = current && current.title;
  rollWS.send(JSON.stringify({ type: "roll_dice", formula, label: title ? `${title} — ${label}` : label }));
}

// ---- ссылки внутри текста ----

// prefer: "journal" — запись, на которую ведёт ссылка из журнала, ищется
// сначала в журнале и только потом в заметках ДМ (см. catalog-links.js).
wireCatalogLinks(renderEl, { prefer: "journal" });
wireWikiLinks(renderEl, () => entries, {
  getFolder: () => (current && current.folder) || "",
  onOpen: (id) => openEntry(id),
  onCreateMissing: async (title, folder) => {
    const where = folder ? ` в папке «${folder}»` : " в корне журнала";
    const ok = await showConfirm(`Записи «${title}» нет в журнале. Создать её${where}?`, {
      title: "Новая запись",
      okLabel: "Создать",
    });
    if (!ok) return;
    await guard(async () => {
      const created = await createJournalEntry({ content: `# ${title}\n\n`, folder });
      await refreshList();
      await openEntry(created.id, { edit: true });
    });
  },
});

// guard — общий обработчик «сделал и показал ошибку человеку»: почти каждое
// действие тут может упереться в права (сервер — единственный источник
// правды о них), и молча проглатывать это нельзя.
async function guard(fn) {
  msgEl.className = "";
  msgEl.textContent = "";
  try {
    await fn();
  } catch (err) {
    msgEl.className = "";
    msgEl.textContent = err.message;
  }
}

(async function boot() {
  me = await fetchMe();
  if (!me) {
    location.href = "/";
    return;
  }
  isDM = me.role === "admin";
  connectRollSocket();
  try {
    members = await fetchJournalMembers();
  } catch {
    members = []; // без списка стола диалог прав покажет только «Все за столом»
  }
  await refreshList();
  const wanted = new URLSearchParams(location.search).get("id");
  if (wanted) await openEntry(wanted, { section: decodeURIComponent(location.hash.slice(1)) });
})();

// Смена только хэша (#раздел) не перезагружает iframe — а значки на карте,
// ведущие на разные страницы одной записи журнала (см. domain.NoteMarker),
// как раз меняют один хэш. Догоняем прокрутку руками.
window.addEventListener("hashchange", () => {
  pendingSection = decodeURIComponent(location.hash.slice(1));
  scrollToSection();
});
