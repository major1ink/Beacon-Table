// compendium-menu.js — дерево навигации панели "Справочник" (см.
// vtt/side-menu.js: addIcon — панель монтируется туда же, где 🔊/🎲, с
// opts.sticky: true — не закрывается по клику мимо/Esc, только своей
// кнопкой ✕ в шапке ниже, см. mountCompendiumMenu). Два корня (Beacon Table
// = System:true записи, Пользовательские = System:false), под каждым —
// плоский список категорий + вложенный "Снаряжение" с подкатегориями (см.
// compendium-taxonomy.js). Дерево само ничего не грузит с сервера (ни
// счётчиков, ни списков) — просто открывает список конкретной категории
// отдельным плавающим окном (см. catalog.js), тем же способом, что карточки
// монстра/заклинания/предмета/справочника уже открываются из dm.js/player.js.
import { icon } from "./icons.js";
import { openFloatingWindow } from "./floating-window.js";
import { ITEM_SUBCATEGORIES } from "./compendium-taxonomy.js";

// FLAT_CATEGORIES — порядок как на референсе (TTG Club): Существа,
// Заклинания, потом разбор Reference.Kind на 4 узла (см.
// compendium-taxonomy.js: REFERENCE_GROUPS). "Снаряжение" достраивается
// отдельно (см. buildRoot) — у него есть свои подкатегории, у остальных нет.
const FLAT_CATEGORIES = [
  { id: "creatures", label: "Существа", type: "creatures", dmOnly: true },
  { id: "spells", label: "Заклинания", type: "spells" },
  { id: "class", label: "Классы", type: "reference", kind: "class" },
  { id: "species", label: "Виды", type: "reference", kind: "species" },
  { id: "background", label: "Предыстории", type: "reference", kind: "background" },
  { id: "trait", label: "Черты", type: "reference", kind: "trait" },
  // «Состояния» (см. domain.Condition) — свой узел, а не часть справочника:
  // это не текст для чтения, а карточки, которые вешаются метками на токены
  // (см. web/src/status-palette.js). Доступны не только ДМ — игроку нужно
  // прочитать, что на нём висит.
  { id: "conditions", label: "Состояния", type: "conditions" },
];

function catalogUrl({ type, system, kind, category, role, label }) {
  const params = new URLSearchParams({ type, system: system ? "1" : "0", role, title: label });
  if (kind) params.set("kind", kind);
  if (category) params.set("category", category);
  return "/catalog.html?" + params.toString();
}

function openCategory({ type, system, kind, category, role, label }) {
  openFloatingWindow({
    key: `catalog-${system ? 1 : 0}-${type}-${kind || category || ""}`,
    title: label,
    url: catalogUrl({ type, system, kind, category, role, label }),
    width: 480,
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
// контейнера, используется и для корней (Beacon Table/Пользовательские), и
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

function buildRoot(system, label, role, startOpen) {
  const { wrap, body } = collapsible(label, { className: "compendium-root", startOpen });
  for (const cat of FLAT_CATEGORIES) {
    if (cat.dmOnly && role !== "dm") continue;
    body.appendChild(
      leafNode(cat.label, () => openCategory({ type: cat.type, system, kind: cat.kind, role, label: cat.label }))
    );
  }
  const gear = collapsible("Снаряжение", { className: "compendium-group", startOpen: false });
  for (const sub of ITEM_SUBCATEGORIES) {
    gear.body.appendChild(leafNode(sub, () => openCategory({ type: "items", system, category: sub, role, label: sub })));
  }
  body.appendChild(gear.wrap);
  return wrap;
}

// mountCompendiumMenu — наполняет panelEl (см. sideMenu.addIcon) шапкой
// (заголовок + ✕, см. panel.close() в side-menu.js) и деревом. role: "dm" |
// "player" — только чтобы скрыть "Существа" у игрока (сервер всё равно
// отказал бы 403 на /api/monsters, см. requireAdminAccount).
export function mountCompendiumMenu(panelEl, { role }) {
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

  panelEl.appendChild(buildRoot(true, "Beacon Table", role, true));
  panelEl.appendChild(buildRoot(false, "Пользовательские", role, false));
}
