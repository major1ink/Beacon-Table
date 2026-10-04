// compendium-menu.js — дерево навигации панели "Справочник" (см.
// vtt/side-menu.js: addIcon — панель монтируется туда же, где 🔊/🎲, с
// opts.sticky: true — не закрывается по клику мимо/Esc, только своей
// кнопкой ✕ в шапке ниже, см. mountCompendiumMenu). Корень на каждый модуль
// мира и «Пользовательские», под каждым — плоский список категорий + вложенный "Снаряжение" с подкатегориями (из
// list.categories схемы системы). Дерево само ничего не грузит с сервера (ни
// счётчиков, ни списков) — просто открывает список конкретной категории
// отдельным плавающим окном (см. catalog.js), тем же способом, что карточки
// монстра/заклинания/предмета/справочника уже открываются из dm.js/player.js.
import { icon } from "./icons.js";
import { openFloatingWindow } from "./floating-window.js";
import { loadSchemas, schemaFor } from "./schemas.js";
import { loadSystemProfile, worldModules } from "./system-profile.js";

// USER_SOURCE — источник «Пользовательские»: карточки библиотеки мира.
export const USER_SOURCE = "user";

// FLAT_CATEGORIES — порядок как на референсе (TTG Club). Справочник и
// «Предметы» достраиваются отдельно (см. buildRoot): их подразделы задаёт
// схема системы.
const FLAT_CATEGORIES = [
  { id: "creatures", label: "Существа", type: "creatures", dmOnly: true },
  { id: "spells", label: "Заклинания", type: "spells" },
  // «Состояния» (см. domain.Condition) — свой узел, а не часть справочника:
  // это не текст для чтения, а карточки, которые вешаются метками на токены
  // (см. web/src/status-palette.js). Доступны не только ДМ — игроку нужно
  // прочитать, что на нём висит.
  { id: "conditions", label: "Состояния", type: "conditions" },
];

function catalogUrl({ type, source, category, role, label }) {
  const params = new URLSearchParams({ type, source, role, title: label });
  if (category) params.set("category", category);
  return "/catalog.html?" + params.toString();
}

function openCategory({ type, source, category, role, label }) {
  openFloatingWindow({
    key: `catalog-${source}-${type}-${category || ""}`,
    title: label,
    url: catalogUrl({ type, source, category, role, label }),
    width: 760,
    height: 640,
  });
}

function leafNode(label, onOpen) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "compendium-node";
  btn.textContent = label;
  btn.onclick = onOpen;
  return btn;
}

// collapsible — общий тоггл-заголовок (chevron + подпись) поверх вложенного
// контейнера, используется и для корней (модули/Пользовательские), и
// для "Снаряжение" внутри корня — тот же приём, другой уровень вложенности.
function collapsible(label, { className, startOpen }) {
  const wrap = document.createElement("div");
  wrap.className = className;
  const header = document.createElement("button");
  header.type = "button";
  header.className = className + "-header";
  const chevron = document.createElement("span");
  chevron.className = "compendium-chevron";
  chevron.innerHTML = icon("chevron-right", { size: 12 });
  header.append(chevron, document.createTextNode(label));
  const body = document.createElement("div");
  body.className = className + "-body";
  function setOpen(open) {
    wrap.classList.toggle("open", open);
    body.style.display = open ? "flex" : "none";
  }
  header.onclick = () => setOpen(!wrap.classList.contains("open"));
  setOpen(!!startOpen);
  wrap.append(header, body);
  return { wrap, body };
}

// categoryLabels — подписи категорий схемы вида (list.categories): по
// порядку правил, «остальное» последним.
function categoryLabels(kind) {
  const c = schemaFor(kind) && schemaFor(kind).list && schemaFor(kind).list.categories;
  return c ? [...c.rules.map((r) => r.label), c.other].filter(Boolean) : [];
}

// kindNodes — справочник или предметы: пункт на всё или подразделы схемы
// (предметы — вложенным «Снаряжением»).
function kindNodes(body, source, role, { kind, type, single, group }) {
  if (!schemaFor(kind)) return;
  const labels = categoryLabels(kind);
  if (!labels.length) {
    body.appendChild(leafNode(single, () => openCategory({ type, source, role, label: single })));
    return;
  }
  let into = body;
  if (group) {
    const gear = collapsible(group, { className: "compendium-group", startOpen: false });
    body.appendChild(gear.wrap);
    into = gear.body;
  }
  for (const name of labels) into.appendChild(leafNode(name, () => openCategory({ type, source, category: name, role, label: name })));
}

function buildRoot(source, label, role, startOpen) {
  const { wrap, body } = collapsible(label, { className: "compendium-root", startOpen });
  for (const cat of FLAT_CATEGORIES) {
    if (cat.dmOnly && role !== "dm") continue;
    body.appendChild(leafNode(cat.label, () => openCategory({ type: cat.type, source, role, label: cat.label })));
    if (cat.id === "spells") kindNodes(body, source, role, { kind: "reference", type: "reference", single: "Справочник" });
  }
  kindNodes(body, source, role, { kind: "item", type: "items", single: "Предметы", group: "Снаряжение" });
  return wrap;
}

// foundryImportNode — импорт целого пакета Foundry VTT по ссылке на манифест
// (см. web/foundry-import.html). Только у ДМ: импорт ходит с сервера в
// интернет, пишет файлы в библиотеку загрузок и заводит сцены — тот же
// набор прав, что и у остальных ДМ-инструментов (сервер откажет игроку
// 403-м, см. handleFoundryInspect).
function foundryImportNode() {
  return leafNode("＋ Импорт из Foundry VTT", () =>
    openFloatingWindow({
      key: "foundry-import",
      title: "Импорт из Foundry VTT",
      url: "/foundry-import.html",
      width: 560,
      height: 640,
    })
  );
}

// mountCompendiumMenu — наполняет panelEl (см. sideMenu.addIcon) шапкой
// (заголовок + ✕, см. panel.close() в side-menu.js) и деревом. role: "dm" |
// "player" — только чтобы скрыть "Существа" у игрока (сервер всё равно
// отказал бы 403 на /api/monsters, см. requireAdminAccount).
export function mountCompendiumMenu(panelEl, { role, canImport = true }) {
  panelEl.classList.add("compendium-tree");

  const header = document.createElement("div");
  header.className = "compendium-panel-header";
  const title = document.createElement("span");
  title.textContent = "Справочник";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "icon-btn";
  closeBtn.title = "Закрыть";
  closeBtn.innerHTML = icon("close", { size: 13 });
  closeBtn.onclick = () => panelEl.close && panelEl.close();
  header.append(title, closeBtn);
  panelEl.appendChild(header);

  const treeWrap = document.createElement("div");
  panelEl.appendChild(treeWrap);

  function renderTree() {
    treeWrap.innerHTML = "";
    for (const m of worldModules()) treeWrap.appendChild(buildRoot(m.id, m.title, role, false));
    treeWrap.appendChild(buildRoot(USER_SOURCE, "Пользовательские", role, true));
    if (role === "dm" && canImport) treeWrap.appendChild(foundryImportNode());
  }
  renderTree();
  // Схемы системы мира решают, какие подразделы показывать (см. buildRoot).
  Promise.all([loadSchemas(), loadSystemProfile()]).then(renderTree);
}
