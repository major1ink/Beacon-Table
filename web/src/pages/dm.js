// Перенос inline-скрипта static/dm.html — механически, DOM/HTTP-логика не
// менялась, только глобальные вызовы app.js заменены на импорты, и
// initVTT(...) стал await initVTT(...) (см. vtt/index.js — единственное
// вынужденное отличие от прежнего classic-script вызова).
import { initVTT } from "../vtt/index.js";
import { initDiceRoller } from "../dice.js";
import { openFloatingWindow, postToOpenWindows } from "../floating-window.js";
import { initCombatPanel } from "../combat-panel.js";
import { openStatusPalette, refreshStatusPalette } from "../status-palette.js";
import {
  fetchMe,
  apiLogout,
  fetchVersion,
  fetchAssets,
  uploadFile,
  createAssetFolder,
  deleteAssetFolder,
  deleteAsset,
  fetchAdminCharacters,
  updateAdminCharacter,
  fetchAdminAccounts,
  createAdminAccount,
  approveAdminAccount,
  deleteAdminAccount,
  setAdminAccountPassword,
  fetchAdminPlaylists,
  createPlaylist,
  renamePlaylist,
  deletePlaylist,
  addPlaylistTrack,
  updatePlaylistTrack,
  deletePlaylistTrack,
  movePlaylistTrack,
  fetchNotes,
  fetchNote,
  createNote,
  updateNote,
  moveNote,
  deleteNote,
  fetchNoteFolders,
  createNoteFolder,
  renameNoteFolder,
  deleteNoteFolder,
  fetchMonster,
} from "../api.js";
import { renderNoteHtml, wireWikiLinks } from "../notes/markdown.js";
import { mountNoteToolbar } from "../notes/toolbar.js";
import { icon } from "../icons.js";
import { wireCatalogLinks } from "../catalog-links.js";
import { enhanceRolls } from "../inline-rolls.js";
import { initItemPicker } from "../item-picker.js";
import { showLootTakeModal } from "../loot-take-modal.js";
import { mountCompendiumMenu } from "../compendium-menu.js";

// ================= сессия ДМ =================
// /ws/dm, /upload, /assets проверяют cookie сессии на сервере
// (internal/api/http, internal/api/ws). Если сессии нет или роль не admin —
// сразу уводим на страницу входа, до всякой попытки подключиться по WS.
let vtt;
(async function boot() {
  const me = await fetchMe();
  if (!me || me.role !== "admin") {
    location.href = "/";
    return;
  }
  document.getElementById("dmUsername").textContent = me.username;
  // Всё остальное в этом файле — обычные top-level обработчики
  // (onclick/addEventListener), выполняются один раз при загрузке страницы
  // и лишь ССЫЛАЮТСЯ на vtt внутри колбэков — к моменту, когда пользователь
  // реально на что-то нажмёт, boot() уже успеет отработать.
  vtt = await initVTT({ canvasId: "scene", role: "dm" });
  // Плейлист двигает вперёд сам клиент ДМ (см. handleCueEnded ниже) —
  // vtt.cueAudio появляется только сейчас, поэтому слушатель вешаем здесь.
  vtt.cueAudio.addEventListener("ended", handleCueEnded);
  // Кубы — отдельная иконка 🎲 в той же боковой колонке, что и 🔊 громкость
  // (см. vtt/side-menu.js — vtt.sideMenu тоже появляется только теперь).
  // Сама панель — только лоток (кнопки-счётчики кубиков, модификатор, поле
  // формулы, "Бросить", см. dice.js); лог результатов остаётся отдельно, в
  // #diceLog сверху канваса (см. dm.html) — initDiceRoller поддерживает
  // раздельные контейнеры именно ради этого случая.
  const dicePanel = vtt.sideMenu.addIcon(icon("dice", { size: 16 }), "Кубы", { width: 240 });
  const diceControls = document.createElement("div");
  diceControls.className = "dice-controls-menu";
  dicePanel.appendChild(diceControls);
  initDiceRoller(diceControls, (msg) => vtt.send(msg), document.getElementById("diceLog"));
  // Справочник — та же боковая колонка, следующая иконка после кубов (см.
  // compendium-menu.js: дерево категорий, само содержимое — отдельные
  // плавающие окна web/catalog.html). sticky — не закрывается кликом мимо
  // (пользователь кликает по только что открытым спискам/карточкам, это не
  // "мимо"), только своей кнопкой ✕ в шапке.
  const compendiumPanel = vtt.sideMenu.addIcon(icon("book-open", { size: 16 }), "Справочник", { width: 320, sticky: true });
  mountCompendiumMenu(compendiumPanel, { role: "dm" });
})();
document.addEventListener("vtt:authFailed", () => {
  document.getElementById("authFailedOverlay").classList.add("open");
  setTimeout(() => (location.href = "/"), 1500);
});
document.getElementById("logoutBtn").onclick = async () => {
  await apiLogout();
  location.href = "/";
};
// worldsBtn — назад на экран выбора мира (worlds.html), не разлогиниваясь —
// переключиться на другой мир или создать новый (см. web/src/pages/worlds.js).
document.getElementById("worldsBtn").onclick = () => {
  location.href = "/worlds.html";
};

// ================= выезжающая панель: реестр "открыть → подгрузить данные" =================
// Разделы "Аккаунты"/"Плейлисты"/"Настроить сцену" регистрируют сюда коллбэк
// сразу при определении (выше по файлу, чем сама механика рейла+панели ниже),
// поэтому panelOpenHandlers/onPanelOpen объявлены здесь, в самом начале.
const panelOpenHandlers = {};
function onPanelOpen(name, fn) {
  panelOpenHandlers[name] = fn;
}

let counter = 0;

// ================= библиотека загруженных файлов =================
// fillLibrary — общий рендер select'ов "из библиотеки" (сейчас остался
// только у аудио-треков, см. newTrackLibrary ниже — токен-арт ушёл в
// раздел "Ассеты" с сеткой плиток, см. renderAssetsGrid).
function fillLibrary(select, items) {
  const current = select.value;
  select.innerHTML = '<option value="">— из библиотеки —</option>';
  for (const item of items) {
    const opt = document.createElement("option");
    opt.value = item.url;
    opt.textContent = item.name;
    select.appendChild(opt);
  }
  select.value = current && [...select.options].some((o) => o.value === current) ? current : "";
}

let latestAssets = { maps: [], tokens: [], audio: [], props: [], folders: {} };
async function refreshLibrary() {
  try {
    latestAssets = await fetchAssets();
    if (bgTab.classList.contains("active")) renderAssetTable();
    if (audioTab.classList.contains("active")) renderAudioAssetTable();
    refreshNewTrackLibrary();
    if (assetsPanelSection.classList.contains("active")) renderAssetsGrid();
  } catch (err) {
    console.error("не удалось загрузить библиотеку ассетов:", err);
  }
}
refreshLibrary();

// ================= раздел "Ассеты" (декорации карты: костры, бочки, лодки
// и т.п.) =================
// Своя библиотека (domain.AssetKindProps = "props"), отдельная от токен-арта
// монстров/аватаров персонажей (kind "tokens") — те у своих карточек уже
// есть, здесь только то, что перетаскивается на карту как новый токен.
// Единственный kind с подпапками (см. latestAssets.folders.props).
const ASSET_KIND = "props";
const assetsPanelSection = document.querySelector('.panel-section[data-panel="assets"]');
const assetsBreadcrumb = document.getElementById("assetsBreadcrumb");
const assetsGrid = document.getElementById("assetsGrid");
let currentAssetFolder = ""; // "" — корень; иначе posix-путь "Огонь/Костры"

function assetFolderName(path) {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

function renderAssetsBreadcrumb() {
  assetsBreadcrumb.innerHTML = "";
  const segments = currentAssetFolder ? currentAssetFolder.split("/") : [];
  const crumbs = [{ label: "Ассеты", path: "" }, ...segments.map((seg, i) => ({ label: seg, path: segments.slice(0, i + 1).join("/") }))];
  crumbs.forEach((c, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "assets-breadcrumb-sep";
      sep.textContent = "/";
      assetsBreadcrumb.appendChild(sep);
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = c.label;
    const isCurrent = i === crumbs.length - 1;
    btn.className = isCurrent ? "current" : "";
    if (!isCurrent) {
      btn.onclick = () => {
        currentAssetFolder = c.path;
        renderAssetsGrid();
      };
    }
    assetsBreadcrumb.appendChild(btn);
  });
}

function renderAssetsGrid() {
  // Папка могла исчезнуть (удалена в другой вкладке/сессии) — откатываемся
  // к корню, а не показываем вечно пустую сетку без выхода.
  const folders = latestAssets.folders?.[ASSET_KIND] || [];
  const files = latestAssets[ASSET_KIND] || [];
  if (currentAssetFolder && !folders.some((f) => f.path === currentAssetFolder) && !files.some((f) => f.path === currentAssetFolder)) {
    currentAssetFolder = "";
  }
  renderAssetsBreadcrumb();
  assetsGrid.innerHTML = "";

  const prefix = currentAssetFolder ? currentAssetFolder + "/" : "";
  const subfolders = folders.filter((f) => f.path.startsWith(prefix) && !f.path.slice(prefix.length).includes("/"));
  const items = files.filter((f) => (f.path || "") === currentAssetFolder);

  if (subfolders.length === 0 && items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "assets-empty-hint";
    empty.textContent = "Пока пусто — загрузи файл или создай папку";
    assetsGrid.appendChild(empty);
    return;
  }

  for (const f of subfolders) {
    const tile = document.createElement("div");
    tile.className = "asset-tile folder-tile";
    tile.title = assetFolderName(f.path);
    tile.innerHTML = icon("folder", { size: 26 });
    const name = document.createElement("span");
    name.className = "asset-tile-name folder-tile-name";
    name.textContent = assetFolderName(f.path);
    tile.appendChild(name);
    tile.onclick = () => {
      currentAssetFolder = f.path;
      renderAssetsGrid();
    };
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "asset-tile-del";
    delBtn.title = "Удалить папку со всем содержимым";
    delBtn.innerHTML = icon("trash", { size: 12 });
    delBtn.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Удалить папку «${assetFolderName(f.path)}» со всем содержимым?`)) return;
      try {
        await deleteAssetFolder(ASSET_KIND, f.path);
        await refreshLibrary();
        renderAssetsGrid();
      } catch (err) {
        alert("Не удалось удалить папку: " + err.message);
      }
    };
    tile.appendChild(delBtn);
    assetsGrid.appendChild(tile);
  }

  for (const a of items) {
    const tile = document.createElement("div");
    tile.className = "asset-tile item-tile";
    tile.title = "Перетащи на карту, чтобы поставить токен";
    tile.draggable = true;
    if (isVideoUrl(a.url)) {
      const v = document.createElement("video");
      v.src = a.url;
      v.muted = true;
      v.loop = true;
      v.autoplay = true;
      v.playsInline = true;
      tile.appendChild(v);
    } else {
      tile.style.backgroundImage = `url("${a.url}")`;
    }
    tile.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("application/x-beacon-asset", JSON.stringify({ url: a.url, name: a.name }));
      e.dataTransfer.effectAllowed = "copy";
    });
    const name = document.createElement("span");
    name.className = "asset-tile-name";
    name.textContent = a.name;
    tile.appendChild(name);
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "asset-tile-del";
    delBtn.title = "Удалить ассет";
    delBtn.innerHTML = icon("trash", { size: 12 });
    delBtn.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Удалить «${a.name}» из библиотеки?`)) return;
      try {
        await deleteAsset(ASSET_KIND, a.url);
        await refreshLibrary();
        renderAssetsGrid();
      } catch (err) {
        alert("Не удалось удалить ассет: " + err.message);
      }
    };
    tile.appendChild(delBtn);
    assetsGrid.appendChild(tile);
  }
}
onPanelOpen("assets", renderAssetsGrid);

document.getElementById("assetsNewFolderBtn").onclick = async () => {
  const name = prompt("Название новой папки:");
  if (!name || !name.trim()) return;
  const path = (currentAssetFolder ? currentAssetFolder + "/" : "") + name.trim();
  try {
    await createAssetFolder(ASSET_KIND, path);
    await refreshLibrary();
    renderAssetsGrid();
  } catch (err) {
    alert("Не удалось создать папку: " + err.message);
  }
};

document.getElementById("assetUpload").onchange = async (e) => {
  const files = [...e.target.files];
  if (files.length === 0) return;
  try {
    for (const file of files) {
      await uploadFile(file, ASSET_KIND, currentAssetFolder);
    }
  } catch (err) {
    alert("Не удалось загрузить файл: " + err.message);
  } finally {
    e.target.value = "";
    await refreshLibrary();
    renderAssetsGrid();
  }
};

// ================= зум =================
document.getElementById("zoomInBtn").onclick = () => document.dispatchEvent(new CustomEvent("vtt:zoomBy", { detail: 1.3 }));
document.getElementById("zoomOutBtn").onclick = () => document.dispatchEvent(new CustomEvent("vtt:zoomBy", { detail: 1 / 1.3 }));
document.getElementById("zoomResetBtn").onclick = () => document.dispatchEvent(new CustomEvent("vtt:resetView"));

// ================= единый инструмент: Атака / Стены / Здание / Туман =================
const attackBtn = document.getElementById("attackBtn");
const wallBtn = document.getElementById("wallBtn");
const buildingBtn = document.getElementById("buildingBtn");
const fogBtn = document.getElementById("fogBtn");
const rulerBtn = document.getElementById("rulerBtn");

function toggleTool(name) {
  const current = document.querySelector("[data-tool].active");
  const next = current && current.dataset.tool === name ? "select" : name;
  document.dispatchEvent(new CustomEvent("vtt:setTool", { detail: next }));
}
attackBtn.dataset.tool = "attack";
wallBtn.dataset.tool = "wall";
buildingBtn.dataset.tool = "building";
fogBtn.dataset.tool = "fog";
rulerBtn.dataset.tool = "ruler";
attackBtn.onclick = () => toggleTool("attack");
wallBtn.onclick = () => toggleTool("wall");
buildingBtn.onclick = () => toggleTool("building");
fogBtn.onclick = () => toggleTool("fog");
rulerBtn.onclick = () => toggleTool("ruler");

const gridEditDone = document.getElementById("gridEditDone");
document.addEventListener("vtt:toolChanged", (e) => {
  attackBtn.classList.toggle("active", e.detail === "attack");
  wallBtn.classList.toggle("active", e.detail === "wall");
  buildingBtn.classList.toggle("active", e.detail === "building");
  fogBtn.classList.toggle("active", e.detail === "fog");
  rulerBtn.classList.toggle("active", e.detail === "ruler");
  gridEditDone.classList.toggle("open", e.detail === "grid-edit");
  // подсказка в панели "Инструменты" — только для выбранного инструмента (см. dm.html:data-hint-tool)
  // "" тут не сработает — .hint[data-hint-tool]{display:none} в <style> и
  // так победит пустую инлайн-строку, нужен явный display, отличный от none
  document.querySelectorAll("[data-hint-tool]").forEach((el) => {
    el.style.display = el.dataset.hintTool === e.detail ? "block" : "none";
  });
});
gridEditDone.onclick = () => {
  document.dispatchEvent(new CustomEvent("vtt:setTool", { detail: "select" }));
  setSidePanelSection("sceneSettings"); // вернуться в раздел с уже актуальными offsetX/Y
  openSceneSettings("grid");
};

// ================= глобальный свет "на всю карту" =================
// Не тумблер fogOfWar (который решает, считать ли вообще LOS/свет) — это
// отдельный источник света масштабом на всю сцену, складывается с
// расставленными на токенах источниками (see internal/service/room.go:
// applyMutation "set_global_light"). Кнопки — переключатели, повторный клик
// по активной снимает её (globalLight = "").
const globalLightBrightBtn = document.getElementById("globalLightBrightBtn");
const globalLightDimBtn = document.getElementById("globalLightDimBtn");

function setGlobalLight(value) {
  vtt.send({ type: "set_global_light", globalLight: value });
}
globalLightBrightBtn.onclick = () => {
  const scene = vtt.getScene();
  setGlobalLight(scene.globalLight === "bright" ? "" : "bright");
};
globalLightDimBtn.onclick = () => {
  const scene = vtt.getScene();
  setGlobalLight(scene.globalLight === "dim" ? "" : "dim");
};
document.addEventListener("vtt:sceneUpdated", (e) => {
  const globalLight = e.detail.globalLight || "";
  globalLightBrightBtn.classList.toggle("active", globalLight === "bright");
  globalLightDimBtn.classList.toggle("active", globalLight === "dim");
  // Палитра состояний живёт вне канваса (document.body) и своей истины не
  // держит — перерисовываем её по каждой свежей сцене, иначе только что
  // наложенная метка не подсветится в сетке (см. status-palette.js).
  refreshStatusPalette();
});

// ================= контекстное меню токена =================
const tokenMenu = document.getElementById("tokenMenu");
const tokenMenuLightHeader = document.getElementById("tokenMenuLightHeader");
const tokenMenuSheetBtn = document.getElementById("tokenMenuSheetBtn");
const tokenMenuBestiaryBtn = document.getElementById("tokenMenuBestiaryBtn");
const tokenMenuAddInitiativeBtn = document.getElementById("tokenMenuAddInitiativeBtn");
const tokenMenuLootBtn = document.getElementById("tokenMenuLootBtn");
const tokenMenuHiddenRow = document.getElementById("tokenMenuHiddenRow");
const tokenMenuShapeRow = document.getElementById("tokenMenuShapeRow");
const tokenMenuLightRow = document.getElementById("tokenMenuLightRow");
const tokenMenuLightLabel = document.getElementById("tokenMenuLightLabel");
const tokenMenuHidden = document.getElementById("tokenMenuHidden");
const tokenMenuShape = document.getElementById("tokenMenuShape");
const tokenMenuLight = document.getElementById("tokenMenuLight");
const tokenMenuLightBright = document.getElementById("tokenMenuLightBright");
const tokenMenuLightDim = document.getElementById("tokenMenuLightDim");
const tokenMenuLightBrightField = document.getElementById("tokenMenuLightBrightField");
const tokenMenuLightDimField = document.getElementById("tokenMenuLightDimField");
const tokenMenuLightToggleBtn = document.getElementById("tokenMenuLightToggleBtn");
const tokenMenuStatusBtn = document.getElementById("tokenMenuStatusBtn");
const tokenMenuDelete = document.getElementById("tokenMenuDelete");
let menuTokenId = null;
let menuCharacterId = ""; // characterId токена в открытом сейчас меню — "" у обычных NPC-токенов
let menuCharacterLabel = ""; // token.label того же токена — для заголовка плавающего окна листа
let menuMonsterId = ""; // monsterId токена в открытом сейчас меню — "" у токенов без привязки к бестиарию
// Токен света (domain.Token.LightOnly) не имеет владельца/формы/чекбокса
// "скрыт" — у него вместо этого кнопка вкл/выкл прямо в меню (см.
// vtt:tokenContextMenu ниже). menuIsLightOnly/menuLightEnabled — состояние
// ТЕКУЩЕГО открытого меню, sendTokenMenuLight() читает их вместо
// tokenMenuLight.checked, когда меню в этом режиме.
let menuIsLightOnly = false;
let menuLightEnabled = false;
// menuTokenLoot — снимок Token.Loot (см. domain.InventoryEntry) токена в
// открытом сейчас меню — "Лутить" виден, только если тут реально есть что
// разобрать (token.dead && loot.length), см. handler ниже.
let menuTokenLoot = [];

function closeTokenMenu() {
  tokenMenu.style.display = "none";
  menuTokenId = null;
  menuCharacterId = "";
  menuCharacterLabel = "";
  menuMonsterId = "";
  menuTokenLoot = [];
}

// Поля "ярк."/"тускл." в меню токена видимы только пока включён источник
// света — переключается тем же чекбоксом (см. вызовы ниже).
function syncLightFieldsVisibility(checkbox, brightField, dimField) {
  const on = checkbox.checked;
  brightField.classList.toggle("visible", on);
  dimField.classList.toggle("visible", on);
}

// ================= меню точки стены (ПКМ по концу стены) =================
// "Точка" — не отдельная сущность, а координата, где сходится конец одной
// или нескольких стен (общий угол) — см. geometry.js:wallVertices и
// vtt:wallPointContextMenu в interaction.js. menuWallIds — id всех стен,
// у которых там конец; удаление точки = удаление их всех разом.
const wallPointMenu = document.getElementById("wallPointMenu");
const wallPointMenuDelete = document.getElementById("wallPointMenuDelete");
let menuWallIds = [];

function closeWallPointMenu() {
  wallPointMenu.style.display = "none";
  menuWallIds = [];
}

document.addEventListener("vtt:wallPointContextMenu", (e) => {
  closeTokenMenu();
  closeNoteMarkerMenu();
  closeFogAreaMenu();
  closeWallMenu();
  closeBuildingMenu();
  menuWallIds = [...new Set(e.detail.refs.map((r) => r.wallId))];
  wallPointMenu.style.left = e.detail.pageX + "px";
  wallPointMenu.style.top = e.detail.pageY + "px";
  wallPointMenu.style.display = "block";
});

wallPointMenuDelete.onclick = () => {
  document.dispatchEvent(new CustomEvent("vtt:removeWallPoint", { detail: { wallIds: menuWallIds } }));
  closeWallPointMenu();
};

// ================= меню фигуры ручного тумана (ПКМ внутри контура) =================
// Раньше ПКМ сразу удалял фигуру без подтверждения — теперь фигуру можно ещё
// и двигать/переформовывать (см. interaction.js), поэтому снос вынесен в
// меню, как у токена/значка заметки, а не остаётся единственным ПКМ-действием.
const fogAreaMenu = document.getElementById("fogAreaMenu");
const fogAreaMenuDelete = document.getElementById("fogAreaMenuDelete");
let menuFogAreaId = null;

function closeFogAreaMenu() {
  fogAreaMenu.style.display = "none";
  menuFogAreaId = null;
}

document.addEventListener("vtt:fogAreaContextMenu", (e) => {
  closeTokenMenu();
  closeWallPointMenu();
  closeNoteMarkerMenu();
  closeWallMenu();
  closeBuildingMenu();
  menuFogAreaId = e.detail.id;
  fogAreaMenu.style.left = e.detail.pageX + "px";
  fogAreaMenu.style.top = e.detail.pageY + "px";
  fogAreaMenu.style.display = "block";
});

fogAreaMenuDelete.onclick = () => {
  if (!menuFogAreaId) return;
  document.dispatchEvent(new CustomEvent("vtt:removeFogArea", { detail: { id: menuFogAreaId } }));
  closeFogAreaMenu();
};

// ================= меню стены (ПКМ по линии, не по концу) =================
// Раньше ПКМ рядом со стеной сразу сносил её без подтверждения — теперь
// середину стены можно ещё и кликнуть, чтобы вставить точку (см.
// interaction.js:splitWallAt), так что снос вынесен в меню, как у фигуры
// тумана выше. Плюс тут же — классификация сегмента (дверь/окно/секретная) и
// управление дверью (открыть-закрыть/запереть-отпереть, см.
// domain.Wall.Door/DoorState/Window) — набор видимых кнопок зависит от
// текущего состояния стены (menuWall, из detail — см. interaction.js:
// vtt:wallContextMenu, передаёт объект стены тем же приёмом, что и
// vtt:tokenContextMenu передаёт токен).
const wallMenu = document.getElementById("wallMenu");
const wallMenuToggleOpen = document.getElementById("wallMenuToggleOpen");
const wallMenuToggleLock = document.getElementById("wallMenuToggleLock");
const wallMenuMakeDoor = document.getElementById("wallMenuMakeDoor");
const wallMenuMakeWindow = document.getElementById("wallMenuMakeWindow");
const wallMenuMakeSecret = document.getElementById("wallMenuMakeSecret");
const wallMenuMakeNormalDoor = document.getElementById("wallMenuMakeNormalDoor");
const wallMenuUnsetSpecial = document.getElementById("wallMenuUnsetSpecial");
const wallMenuDelete = document.getElementById("wallMenuDelete");
let menuWallId = null;
let menuWall = null;

function closeWallMenu() {
  wallMenu.style.display = "none";
  menuWallId = null;
  menuWall = null;
}

document.addEventListener("vtt:wallContextMenu", (e) => {
  closeTokenMenu();
  closeWallPointMenu();
  closeNoteMarkerMenu();
  closeFogAreaMenu();
  closeBuildingMenu();
  menuWallId = e.detail.id;
  menuWall = e.detail.wall || null;

  const isDoor = !!(menuWall && menuWall.door);
  const isSecret = isDoor && menuWall.door === "secret";
  const isWindow = !!(menuWall && menuWall.window);
  const isPlain = !isDoor && !isWindow;
  // Одно и то же меню открывается из двух разных инструментов (см.
  // interaction.js: vtt:wallContextMenu, поле tool) — структурные пункты
  // (классификация/удаление сегмента) доступны ТОЛЬКО в "Стена" (там же
  // interaction.js вообще не открывает это меню в других инструментах,
  // кроме "Выбор" — и то только когда на сегменте уже есть дверь); пункты
  // состояния двери (открыть/закрыть/запереть) — только в "Выбор", т.к.
  // управление уже существующей дверью не гейтится режимом стены (см. план
  // задачи: "Управление уже созданными дверями осуществляется... без
  // изменений").
  const isWallMode = e.detail.tool === "wall";
  const isSelectMode = e.detail.tool === "select";

  wallMenuToggleOpen.style.display = isSelectMode && isDoor ? "flex" : "none";
  wallMenuToggleOpen.textContent = menuWall && menuWall.doorState === "open" ? "🚪 Закрыть" : "🚪 Открыть";
  wallMenuToggleLock.style.display = isSelectMode && isDoor ? "flex" : "none";
  wallMenuToggleLock.textContent = menuWall && menuWall.doorState === "locked" ? "🔓 Отпереть" : "🔒 Запереть";
  wallMenuMakeDoor.style.display = isWallMode && isPlain ? "flex" : "none";
  wallMenuMakeWindow.style.display = isWallMode && isPlain ? "flex" : "none";
  wallMenuMakeSecret.style.display = isWallMode && isDoor && !isSecret ? "flex" : "none";
  wallMenuMakeNormalDoor.style.display = isWallMode && isSecret ? "flex" : "none";
  wallMenuUnsetSpecial.style.display = isWallMode && (isDoor || isWindow) ? "flex" : "none";
  wallMenuDelete.style.display = isWallMode ? "flex" : "none";

  wallMenu.style.left = e.detail.pageX + "px";
  wallMenu.style.top = e.detail.pageY + "px";
  wallMenu.style.display = "block";
});

wallMenuToggleOpen.onclick = () => {
  if (!menuWallId) return;
  document.dispatchEvent(new CustomEvent("vtt:toggleDoor", { detail: { id: menuWallId } }));
  closeWallMenu();
};
wallMenuToggleLock.onclick = () => {
  if (!menuWallId || !menuWall) return;
  const locked = menuWall.doorState !== "locked";
  document.dispatchEvent(new CustomEvent("vtt:setDoorLock", { detail: { id: menuWallId, locked } }));
  closeWallMenu();
};
wallMenuMakeDoor.onclick = () => {
  if (!menuWallId) return;
  document.dispatchEvent(new CustomEvent("vtt:setWallDoor", { detail: { id: menuWallId, door: "door" } }));
  closeWallMenu();
};
wallMenuMakeWindow.onclick = () => {
  if (!menuWallId) return;
  document.dispatchEvent(new CustomEvent("vtt:setWallWindow", { detail: { id: menuWallId, window: true } }));
  closeWallMenu();
};
wallMenuMakeSecret.onclick = () => {
  if (!menuWallId) return;
  document.dispatchEvent(new CustomEvent("vtt:setWallDoor", { detail: { id: menuWallId, door: "secret" } }));
  closeWallMenu();
};
wallMenuMakeNormalDoor.onclick = () => {
  if (!menuWallId) return;
  document.dispatchEvent(new CustomEvent("vtt:setWallDoor", { detail: { id: menuWallId, door: "door" } }));
  closeWallMenu();
};
wallMenuUnsetSpecial.onclick = () => {
  if (!menuWallId) return;
  // Стена могла быть либо дверью (Door!==""), либо окном (Window===true) —
  // не знаем какой именно, поэтому сбрасываем оба поля разом (см.
  // room.go:applyMutation — установка одного и так сбрасывает другое, тут
  // просто гарантируем чистый результат независимо от исходного состояния).
  document.dispatchEvent(new CustomEvent("vtt:setWallDoor", { detail: { id: menuWallId, door: "" } }));
  document.dispatchEvent(new CustomEvent("vtt:setWallWindow", { detail: { id: menuWallId, window: false } }));
  closeWallMenu();
};
wallMenuDelete.onclick = () => {
  if (!menuWallId) return;
  document.dispatchEvent(new CustomEvent("vtt:removeWall", { detail: { id: menuWallId } }));
  closeWallMenu();
};

// ================= меню здания (ПКМ внутри контура) =================
// Раньше ПКМ сразу удалял здание без подтверждения — теперь, как и у фигуры
// тумана/стены, снос вынесен в меню (см. interaction.js:
// vtt:buildingContextMenu), чтобы случайный ПКМ во время осмотра карты в
// режиме "Здание" не сносил контур мгновенно.
const buildingMenu = document.getElementById("buildingMenu");
const buildingMenuDelete = document.getElementById("buildingMenuDelete");
let menuBuildingId = null;

function closeBuildingMenu() {
  buildingMenu.style.display = "none";
  menuBuildingId = null;
}

document.addEventListener("vtt:buildingContextMenu", (e) => {
  closeTokenMenu();
  closeWallPointMenu();
  closeNoteMarkerMenu();
  closeFogAreaMenu();
  closeWallMenu();
  menuBuildingId = e.detail.id;
  buildingMenu.style.left = e.detail.pageX + "px";
  buildingMenu.style.top = e.detail.pageY + "px";
  buildingMenu.style.display = "block";
});

buildingMenuDelete.onclick = () => {
  if (!menuBuildingId) return;
  document.dispatchEvent(new CustomEvent("vtt:removeBuilding", { detail: { id: menuBuildingId } }));
  closeBuildingMenu();
};

// ================= меню значка заметки (ПКМ по свитку на карте) =================
const noteMarkerMenu = document.getElementById("noteMarkerMenu");
const noteMarkerResizeBtn = document.getElementById("noteMarkerResizeBtn");
const noteMarkerDeleteBtn = document.getElementById("noteMarkerDeleteBtn");
let menuNoteMarkerId = null;

function closeNoteMarkerMenu() {
  noteMarkerMenu.style.display = "none";
  menuNoteMarkerId = null;
}

document.addEventListener("vtt:noteMarkerContextMenu", (e) => {
  closeTokenMenu();
  closeWallPointMenu();
  closeFogAreaMenu();
  closeWallMenu();
  closeBuildingMenu();
  menuNoteMarkerId = e.detail.id;
  noteMarkerMenu.style.left = e.detail.pageX + "px";
  noteMarkerMenu.style.top = e.detail.pageY + "px";
  noteMarkerMenu.style.display = "flex";
});

noteMarkerResizeBtn.onclick = () => {
  if (!menuNoteMarkerId) return;
  document.dispatchEvent(new CustomEvent("vtt:armNoteMarkerResize", { detail: { id: menuNoteMarkerId } }));
  closeNoteMarkerMenu();
  alert("Теперь потяни от значка на карте — дальше от него он растёт, ближе — уменьшается.");
};

noteMarkerDeleteBtn.onclick = () => {
  if (!menuNoteMarkerId) return;
  document.dispatchEvent(new CustomEvent("vtt:removeNoteMarker", { detail: { id: menuNoteMarkerId } }));
  closeNoteMarkerMenu();
};

function updateLightToggleBtnLabel() {
  tokenMenuLightToggleBtn.innerHTML = icon("bulb", { size: 14 }) + " " + (menuLightEnabled ? "Выключить свет" : "Включить свет");
}

document.addEventListener("vtt:tokenContextMenu", (e) => {
  closeWallPointMenu();
  closeNoteMarkerMenu();
  closeFogAreaMenu();
  closeWallMenu();
  closeBuildingMenu();
  const { id, token, pageX, pageY } = e.detail;
  menuTokenId = id;
  menuCharacterId = token.characterId || "";
  menuCharacterLabel = token.label || "";
  menuMonsterId = token.monsterId || "";
  menuIsLightOnly = !!token.lightOnly;
  tokenMenuLightHeader.style.display = menuIsLightOnly ? "flex" : "none";
  // редактировать карточку персонажа прямо из его токена, не только
  // из панели "Персонажи". У токена света персонажа не бывает (см.
  // domain.Token.LightOnly), поэтому эта кнопка с ним не пересекается.
  tokenMenuSheetBtn.style.display = menuCharacterId ? "flex" : "none";
  // тот же приём для монстров бестиария (см. domain.Token.MonsterID) —
  // токены персонажей и монстров не пересекаются (характер и бестиарий не
  // ставятся на один токен), поэтому оба флага независимы.
  tokenMenuBestiaryBtn.style.display = menuMonsterId ? "flex" : "none";
  // "Добавить в инициативу" — у токена света своего "хода" не бывает (см.
  // domain.Token.LightOnly), в остальном доступно любому существу — и
  // игрока, и монстра, и голому NPC-токену без карточки бестиария/листа.
  tokenMenuAddInitiativeBtn.style.display = menuIsLightOnly ? "none" : "flex";
  // "Состояния" — по тому же признаку, что и инициатива: у токена-лампочки
  // (domain.Token.LightOnly) состояний не бывает, он не существо.
  tokenMenuStatusBtn.style.display = menuIsLightOnly ? "none" : "flex";
  // "Лутить" — только у мёртвого токена (кости, см. domain.Token.Dead) с
  // непустым Loot; тумблер CombatState.LootingEnabled тут не проверяем — он
  // ограничивает только ИГРОКОВ (см. authorize в room.go), ДМ раздаёт лут
  // вручную в любой момент.
  menuTokenLoot = Array.isArray(token.loot) ? token.loot : [];
  tokenMenuLootBtn.style.display = token.dead && menuTokenLoot.length ? "flex" : "none";
  tokenMenuHiddenRow.style.display = menuIsLightOnly ? "none" : "flex";
  tokenMenuShapeRow.style.display = menuIsLightOnly ? "none" : "flex";
  tokenMenuLightRow.style.display = menuIsLightOnly ? "none" : "flex";
  tokenMenuLightToggleBtn.style.display = menuIsLightOnly ? "flex" : "none";
  // У токена персонажа игрока свет — это не "токен-лампочка", а факел/фонарь
  // у него в руках, поэтому формулировка чекбокса другая (сама механика
  // радиусов ниже та же самая, см. TokenLight).
  tokenMenuLightLabel.textContent = menuCharacterId ? "Держит факел" : "источник света";

  tokenMenuLightBright.value = (token.light && token.light.bright) || 0;
  tokenMenuLightDim.value = (token.light && token.light.dim) || 0;

  if (menuIsLightOnly) {
    menuLightEnabled = !!(token.light && token.light.enabled);
    updateLightToggleBtnLabel();
    tokenMenuLightBrightField.classList.add("visible");
    tokenMenuLightDimField.classList.add("visible");
  } else {
    tokenMenuHidden.checked = !!token.hidden;
    tokenMenuShape.value = token.shape === "square" ? "square" : "circle";
    tokenMenuLight.checked = !!(token.light && token.light.enabled);
    syncLightFieldsVisibility(tokenMenuLight, tokenMenuLightBrightField, tokenMenuLightDimField);
  }

  tokenMenu.style.left = pageX + "px";
  tokenMenu.style.top = pageY + "px";
  tokenMenu.style.display = "block";
});

tokenMenuSheetBtn.onclick = () => {
  if (!menuCharacterId) return;
  openFloatingWindow({ key: "char-" + menuCharacterId, title: menuCharacterLabel, url: `/character-sheet.html?id=${menuCharacterId}` });
  closeTokenMenu();
};

tokenMenuBestiaryBtn.onclick = () => {
  if (!menuMonsterId) return;
  openFloatingWindow({ key: "monster-" + menuMonsterId, title: menuCharacterLabel, url: `/bestiary.html?id=${menuMonsterId}` });
  closeTokenMenu();
};

tokenMenuAddInitiativeBtn.onclick = () => {
  if (!menuTokenId) return;
  vtt.send({ type: "add_combatant", tokenId: menuTokenId });
  closeTokenMenu();
};

// tokenMenuStatusBtn — "Состояния": палитра наложения метки прямо с карты,
// аналог палитры статусов в Token HUD у Foundry (см. status-palette.js —
// тот же модуль, что и "+" в карточке бойца трекера). Меню токена при этом
// закрывается: палитра встаёт на его место и дальше живёт сама.
tokenMenuStatusBtn.onclick = (e) => {
  if (!menuTokenId) return;
  const tokenId = menuTokenId; // menuTokenId обнулится в closeTokenMenu ниже
  const title = menuCharacterLabel;
  closeTokenMenu();
  openStatusPalette({
    x: e.clientX,
    y: e.clientY,
    target: { tokenId },
    send: vtt.send,
    title,
    // Читаем метки из ЖИВОЙ сцены на каждый рендер палитры, а не из снимка
    // токена, с которым открывали меню, — та же причина, что и у
    // "vtt:toggleTokenLight" ниже: пока палитра открыта, сцена приходит с
    // сервера ещё много раз.
    statusesFor: () => {
      const t = (vtt.getScene().tokens || {})[tokenId];
      return (t && t.statuses) || [];
    },
  });
};

// tokenMenuLootBtn — "Лутить" (только когда видима, см.
// vtt:tokenContextMenu выше): открывает общее модальное окно "забрать
// предметы" (loot-take-modal.js) по снимку Token.Loot этого трупа. ДМ, в
// отличие от игрока, не ограничен своими персонажами — выбирает получателя
// из ВСЕХ персонажей стола (тот же список, что и поиск "+ Добавить" в
// трекере инициативы, см. combat-panel.js: fetchAdminCharacters).
tokenMenuLootBtn.onclick = async () => {
  if (!menuTokenId || !menuTokenLoot.length) return;
  const tokenId = menuTokenId;
  const entries = menuTokenLoot;
  const label = menuCharacterLabel;
  closeTokenMenu();
  let chars = [];
  try {
    chars = await fetchAdminCharacters();
  } catch (err) {
    alert("Не удалось загрузить список персонажей: " + err.message);
    return;
  }
  const characters = chars.map((c) => ({ id: c.id, name: c.accountUsername ? `${c.name} (${c.accountUsername})` : c.name }));
  showLootTakeModal({
    title: "Труп: " + (label || "монстр"),
    entries,
    characters,
    onTake: (entryId, quantity, characterId) => {
      vtt.send({ type: "loot_take_item", tokenId, entryId, characterId, quantity });
      return Promise.resolve();
    },
  });
};

tokenMenuHidden.onchange = () => {
  if (!menuTokenId) return;
  document.dispatchEvent(
    new CustomEvent("vtt:setTokenHidden", { detail: { id: menuTokenId, hidden: tokenMenuHidden.checked } })
  );
};

tokenMenuShape.onchange = () => {
  if (!menuTokenId) return;
  document.dispatchEvent(
    new CustomEvent("vtt:setTokenShape", {
      detail: { id: menuTokenId, shape: tokenMenuShape.value === "square" ? "square" : "" },
    })
  );
};

function sendTokenMenuLight() {
  if (!menuTokenId) return;
  const enabled = menuIsLightOnly ? menuLightEnabled : tokenMenuLight.checked;
  const light = { enabled, bright: +tokenMenuLightBright.value || 0, dim: +tokenMenuLightDim.value || 0 };
  document.dispatchEvent(new CustomEvent("vtt:setTokenLight", { detail: { id: menuTokenId, light } }));
}
tokenMenuLight.onchange = () => {
  syncLightFieldsVisibility(tokenMenuLight, tokenMenuLightBrightField, tokenMenuLightDimField);
  sendTokenMenuLight();
};
tokenMenuLightBright.onchange = sendTokenMenuLight;
tokenMenuLightDim.onchange = sendTokenMenuLight;
tokenMenuLightToggleBtn.onclick = () => {
  if (!menuTokenId) return;
  // Не шлём "просто инвертированный menuLightEnabled" — эта локальная
  // переменная может разъехаться с реальным состоянием токена, если свет
  // переключили ДРУГИМ путём (двойной клик по токену на канвасе, см.
  // interaction.js toggleTokenLight), пока меню оставалось открытым: тогда
  // инверсия локального флага отправила бы то же самое значение, что уже
  // стоит на токене, то есть клик по кнопке визуально ничего бы не менял.
  // vtt:toggleTokenLight читает АКТУАЛЬНОЕ состояние токена в момент клика.
  document.dispatchEvent(new CustomEvent("vtt:toggleTokenLight", { detail: { id: menuTokenId } }));
  menuLightEnabled = !menuLightEnabled; // оптимистично — только для подписи кнопки
  updateLightToggleBtnLabel();
};

tokenMenuDelete.onclick = () => {
  if (!menuTokenId) return;
  document.dispatchEvent(new CustomEvent("vtt:removeToken", { detail: { id: menuTokenId } }));
  closeTokenMenu();
};

// ================= подключённые игроки (счётчик в тулбаре) =================
document.addEventListener("vtt:playerList", (e) => {
  const players = e.detail || [];
  const hint = document.getElementById("playersHint");
  hint.innerHTML = icon("users", { size: 13 }) + " игроков онлайн: " + players.length;
  hint.title = players.map((p) => p.name).join(", ") || "пока никто не подключился";
});

// ================= управление аккаунтами =================
const accountsList = document.getElementById("accountsList");
const accountsBadge = document.getElementById("accountsBadge");

async function refreshAccountsBadge() {
  try {
    const accs = await fetchAdminAccounts();
    const pending = accs.filter((a) => a.status === "pending").length;
    accountsBadge.textContent = pending;
    accountsBadge.classList.toggle("show", pending > 0);
  } catch (err) {
    console.error("не удалось проверить заявки на аккаунты:", err);
  }
}
refreshAccountsBadge();
setInterval(refreshAccountsBadge, 30000); // на случай, если саморегистрация пришла, пока модалка закрыта

function formatAccDate(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}

async function renderAccounts() {
  let accs, chars;
  try {
    [accs, chars] = await Promise.all([fetchAdminAccounts(), fetchAdminCharacters()]);
  } catch (err) {
    accountsList.innerHTML = `<p class="hint">Ошибка: ${err.message}</p>`;
    return;
  }
  const charsByAccount = new Map();
  for (const c of chars) {
    if (!charsByAccount.has(c.accountId)) charsByAccount.set(c.accountId, []);
    charsByAccount.get(c.accountId).push(c);
  }
  accountsList.innerHTML = "";
  for (const a of accs) {
    const row = document.createElement("div");
    row.className = "account-row";
    const roleLabel = a.role === "admin" ? "ДМ" : "Игрок";
    row.innerHTML = `
      <div class="account-top">
        <span class="account-name">${a.username}</span>
        <span class="account-role">${roleLabel}</span>
        <span class="status-pill ${a.status}">${a.status === "pending" ? "ждёт одобрения" : "активен"}</span>
      </div>
      <div class="hint" style="margin-bottom:6px;">создан ${formatAccDate(a.createdAt)}</div>
    `;
    // Персонажи этого аккаунта — быстрый доступ к листу прямо отсюда;
    // полный список всех персонажей + перетаскивание на карту — в отдельной
    // панели "🧑‍🎤 Персонажи" (см. renderDmCharacters выше).
    const ownChars = charsByAccount.get(a.id) || [];
    if (ownChars.length > 0) {
      const charsWrap = document.createElement("div");
      charsWrap.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;";
      for (const c of ownChars) {
        const btn = document.createElement("button");
        btn.innerHTML = icon("scroll", { size: 12 });
        btn.append(" " + c.name);
        btn.title = "Лист персонажа";
        btn.onclick = () => openFloatingWindow({ key: "char-" + c.id, title: c.name, url: `/character-sheet.html?id=${c.id}` });
        charsWrap.appendChild(btn);
      }
      row.appendChild(charsWrap);
    }
    const actions = document.createElement("div");
    actions.className = "account-actions";
    if (a.status === "pending") {
      const approveBtn = document.createElement("button");
      approveBtn.className = "approve";
      approveBtn.textContent = "Одобрить";
      approveBtn.onclick = async () => {
        await approveAdminAccount(a.id);
        await renderAccounts();
        await refreshAccountsBadge();
      };
      actions.appendChild(approveBtn);
    }
    const pwBtn = document.createElement("button");
    pwBtn.textContent = "Сменить пароль";
    pwBtn.onclick = async () => {
      const pw = prompt(`Новый пароль для «${a.username}» (минимум 6 символов):`);
      if (!pw) return;
      try {
        await setAdminAccountPassword(a.id, pw);
        alert("Пароль изменён, старые сессии этого аккаунта разлогинены.");
      } catch (err) {
        alert("Не удалось сменить пароль: " + err.message);
      }
    };
    actions.appendChild(pwBtn);
    const delBtn = document.createElement("button");
    delBtn.className = "danger";
    delBtn.textContent = "Удалить";
    delBtn.onclick = async () => {
      if (!confirm(`Удалить аккаунт «${a.username}» вместе с его персонажами? Это необратимо.`)) return;
      try {
        await deleteAdminAccount(a.id);
        await renderAccounts();
        await refreshAccountsBadge();
      } catch (err) {
        alert("Не удалось удалить: " + err.message);
      }
    };
    actions.appendChild(delBtn);
    row.appendChild(actions);
    accountsList.appendChild(row);
  }
}

onPanelOpen("accounts", renderAccounts);

// ================= раздел "Настройки" =================
// Пока единственное поле — версия сервера (short commit hash, см.
// cmd/beacon-table/version.go); раздел заведён отдельно от "Аккаунтов",
// чтобы будущим общим настройкам приложения было куда встать, не мешая
// уже существующим разделам.
onPanelOpen("settings", async () => {
  const el = document.getElementById("appVersion");
  try {
    const { version } = await fetchVersion();
    el.textContent = version;
  } catch {
    el.textContent = "неизвестна";
  }
});

const newAccountMsg = document.getElementById("newAccountMsg");
document.getElementById("newAccountForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  newAccountMsg.textContent = "";
  try {
    await createAdminAccount(
      document.getElementById("newAccUsername").value.trim(),
      document.getElementById("newAccPassword").value,
      document.getElementById("newAccRole").value
    );
    e.target.reset();
    await renderAccounts();
    await refreshAccountsBadge();
  } catch (err) {
    newAccountMsg.textContent = err.message;
  }
});

// ================= персонажи (панель "Персонажи") =================
// Список персонажей ВСЕХ игроков — ДМ смотрит их, правит имя/аватар и
// перетаскивает на карту (создаёт токен с сразу проставленными
// ownerId/characterId, см. drag&drop на #scene ниже). Полноценный лист
// (характеристики, HP и т.п.) правится отдельно, в character-sheet.html —
// ДМ там теперь тоже редактирует, а не только смотрит (см.
// web/src/pages/character-sheet.js: isAdminView).
const dmCharactersList = document.getElementById("dmCharactersList");
const dmCharEditForm = document.getElementById("dmCharEditForm");
const dmCharEditName = document.getElementById("dmCharEditName");
const dmCharEditAvatarUpload = document.getElementById("dmCharEditAvatarUpload");
const dmCharEditPreviewWrap = document.getElementById("dmCharEditPreviewWrap");
const dmCharEditPreview = document.getElementById("dmCharEditPreview");
const dmCharEditPreviewVideo = document.getElementById("dmCharEditPreviewVideo");
const dmCharEditMsg = document.getElementById("dmCharEditMsg");

let dmCharacters = []; // [{id, accountId, accountUsername, name, avatarUrl}] — кэш для drag&drop-постановки на карту
let dmCharEditingId = null;
let dmCharPendingAvatarUrl = "";

// showDmCharAvatarPreview — isVideoUrl уже есть чуть ниже в этом же файле
// (библиотека токен-арта переиспользует ту же проверку по расширению).
function showDmCharAvatarPreview(url) {
  if (!url) {
    dmCharEditPreviewWrap.style.display = "none";
    return;
  }
  if (isVideoUrl(url)) {
    dmCharEditPreview.style.display = "none";
    dmCharEditPreviewVideo.style.display = "block";
    dmCharEditPreviewVideo.src = url;
  } else {
    dmCharEditPreviewVideo.style.display = "none";
    dmCharEditPreviewVideo.removeAttribute("src");
    dmCharEditPreview.style.display = "block";
    dmCharEditPreview.src = url;
  }
  dmCharEditPreviewWrap.style.display = "block";
}

function closeDmCharEditForm() {
  dmCharEditingId = null;
  dmCharEditForm.style.display = "none";
  dmCharEditMsg.textContent = "";
}

function openDmCharEditForm(c) {
  dmCharEditingId = c.id;
  dmCharPendingAvatarUrl = c.avatarUrl || "";
  dmCharEditName.value = c.name;
  dmCharEditAvatarUpload.value = "";
  showDmCharAvatarPreview(c.avatarUrl || "");
  dmCharEditMsg.textContent = "";
  dmCharEditForm.style.display = "block";
}

async function renderDmCharacters() {
  try {
    dmCharacters = await fetchAdminCharacters();
  } catch (err) {
    dmCharactersList.innerHTML = `<p class="hint">Ошибка: ${err.message}</p>`;
    return;
  }
  closeDmCharEditForm();
  dmCharactersList.innerHTML = "";
  if (dmCharacters.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "Персонажей пока нет — игроки заводят их сами на своей стороне.";
    dmCharactersList.appendChild(empty);
    return;
  }
  const byAccount = new Map();
  for (const c of dmCharacters) {
    if (!byAccount.has(c.accountUsername)) byAccount.set(c.accountUsername, []);
    byAccount.get(c.accountUsername).push(c);
  }
  for (const [username, chars] of byAccount) {
    const group = document.createElement("div");
    group.className = "dmchar-owner-group";
    group.textContent = username;
    dmCharactersList.appendChild(group);
    for (const c of chars) {
      const row = document.createElement("div");
      row.className = "dmchar-row";
      row.draggable = true;
      row.title = "Перетащи на карту, чтобы поставить токен";
      // vtt:tokenContextMenu и остальной drag внутри канваса используют
      // свои DOM-обработчики — свой тип данных не пересекается с ними, и
      // preventDefault на dragover (см. ниже) не даёт браузеру попытаться
      // "открыть" перетаскиваемый текст как ссылку/файл.
      row.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("application/x-beacon-character", c.id);
        e.dataTransfer.effectAllowed = "copy";
      });
      const handle = document.createElement("span");
      handle.className = "drag-handle";
      handle.innerHTML = icon("grip-vertical", { size: 14 });
      const avatar = document.createElement("div");
      avatar.className = "dmchar-avatar";
      if (c.avatarUrl) avatar.style.backgroundImage = `url("${c.avatarUrl}")`;
      else avatar.textContent = "—";
      const name = document.createElement("div");
      name.className = "dmchar-name";
      name.textContent = c.name;
      const sheetBtn = document.createElement("button");
      sheetBtn.className = "icon-btn";
      sheetBtn.innerHTML = icon("scroll", { size: 14 });
      sheetBtn.title = "Лист персонажа";
      sheetBtn.onclick = () => openFloatingWindow({ key: "char-" + c.id, title: c.name, url: `/character-sheet.html?id=${c.id}` });
      const editBtn = document.createElement("button");
      editBtn.className = "icon-btn";
      editBtn.innerHTML = icon("pencil", { size: 14 });
      editBtn.title = "Имя / аватар";
      editBtn.onclick = () => openDmCharEditForm(c);
      row.append(handle, avatar, name, sheetBtn, editBtn);
      dmCharactersList.appendChild(row);
    }
  }
}
onPanelOpen("characters", renderDmCharacters);

dmCharEditAvatarUpload.onchange = async () => {
  const file = dmCharEditAvatarUpload.files[0];
  if (!file) return;
  try {
    const { url } = await uploadFile(file, "tokens");
    dmCharPendingAvatarUrl = url;
    showDmCharAvatarPreview(url);
  } catch (err) {
    dmCharEditMsg.textContent = "Не удалось загрузить аватар: " + err.message;
  }
};

document.getElementById("dmCharEditSaveBtn").onclick = async () => {
  if (!dmCharEditingId) return;
  const name = dmCharEditName.value.trim();
  if (!name) {
    dmCharEditMsg.textContent = "Введи имя персонажа.";
    return;
  }
  try {
    await updateAdminCharacter(dmCharEditingId, name, dmCharPendingAvatarUrl);
    await renderDmCharacters();
  } catch (err) {
    dmCharEditMsg.textContent = err.message;
  }
};
document.getElementById("dmCharEditCancelBtn").onclick = closeDmCharEditForm;

// ---- перетаскивание персонажа из панели на карту — создаёт токен ----
// Тот же формат токена, что и у остальных drag&drop-источников (монстр,
// ассет — см. ниже), но с сразу проставленными ownerId/characterId/label/
// image — единственный способ связать токен с персонажем теперь (контекстное
// меню токена больше не умеет назначать владельца задним числом).
const sceneCanvasEl = document.getElementById("scene");
sceneCanvasEl.addEventListener("dragover", (e) => {
  if (!e.dataTransfer.types.includes("application/x-beacon-character")) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});
sceneCanvasEl.addEventListener("drop", (e) => {
  const charId = e.dataTransfer.getData("application/x-beacon-character");
  if (!charId) return;
  e.preventDefault();
  const char = dmCharacters.find((c) => c.id === charId);
  if (!char) return;
  const { x, y } = vtt.pointToWorld(e);
  counter++;
  const id = "tok-" + Date.now() + "-" + counter;
  const gridSize = (vtt.getScene().grid && vtt.getScene().grid.size) || 48;
  vtt.send({
    type: "add_token",
    token: {
      id,
      x,
      y,
      label: char.name,
      image: char.avatarUrl || "",
      size: gridSize / 2,
      shape: "",
      hidden: false,
      ownerId: char.accountId,
      characterId: char.id,
    },
  });
});

// ---- перетаскивание карточки бестиария на карту — создаёт токен NPC ----
// Тот же жест/API, что и у персонажа выше, но без ownerId/characterId (это
// не токен игрока) и с monsterId вместо него — открывает статблок обратно
// через "📖 Статблок" в контекстном меню токена (см. tokenMenuBestiaryBtn).
sceneCanvasEl.addEventListener("dragover", (e) => {
  if (!e.dataTransfer.types.includes("application/x-beacon-monster")) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});
sceneCanvasEl.addEventListener("drop", async (e) => {
  const monsterId = e.dataTransfer.getData("application/x-beacon-monster");
  if (!monsterId) return;
  e.preventDefault();
  const { x, y } = vtt.pointToWorld(e); // читаем координаты СРАЗУ — e затухает после конца обработчика, а fetch ниже асинхронный
  // Свежий fetch, а не bestiaryList.find(...): список в панели обновляется
  // только при открытии панели (onPanelOpen), а редактирование монстра
  // (включая загрузку токен-арта) идёт в отдельном плавающем окне
  // (bestiary.html) — без этого перетащенный токен мог получить пустой/
  // устаревший imageUrl, если DM поменял арт после последнего открытия
  // панели, не закрывая её.
  let m;
  try {
    m = await fetchMonster(monsterId);
  } catch (err) {
    alert("Не удалось загрузить монстра: " + err.message);
    return;
  }
  counter++;
  const id = "tok-" + Date.now() + "-" + counter;
  const gridSize = (vtt.getScene().grid && vtt.getScene().grid.size) || 48;
  vtt.send({
    type: "add_token",
    token: {
      id,
      x,
      y,
      label: m.name,
      image: m.imageUrl || "",
      size: gridSize / 2,
      shape: "",
      hidden: false,
      monsterId: m.id,
    },
  });
});

// ---- перетаскивание плитки ассета (раздел "Ассеты") на карту — создаёт
// обычный токен-декорацию ----
// Тот же жест/API, что у персонажа/монстра выше, но без owner/character/
// monster id — просто картинка. Форма/скрыт от игроков/источник света
// правятся после постановки через ПКМ → меню токена (см. #tokenMenu),
// отдельной формы настроек перед постановкой намеренно нет — так же, как у
// персонажей и монстров.
sceneCanvasEl.addEventListener("dragover", (e) => {
  if (!e.dataTransfer.types.includes("application/x-beacon-asset")) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});
sceneCanvasEl.addEventListener("drop", (e) => {
  const raw = e.dataTransfer.getData("application/x-beacon-asset");
  if (!raw) return;
  e.preventDefault();
  let asset;
  try {
    asset = JSON.parse(raw);
  } catch {
    return;
  }
  const { x, y } = vtt.pointToWorld(e);
  counter++;
  const id = "tok-" + Date.now() + "-" + counter;
  const gridSize = (vtt.getScene().grid && vtt.getScene().grid.size) || 48;
  vtt.send({
    type: "add_token",
    token: {
      id,
      x,
      y,
      label: asset.name || "",
      image: asset.url || "",
      size: gridSize / 2,
      shape: "",
      hidden: false,
    },
  });
});

// ---- перетаскивание карточки бойца из трекера инициативы на карту ----
// Актуально для бойца, добавленного через "+ Добавить из бестиария" —
// такой сразу попадает в инициативу БЕЗ токена на карте (см.
// combat-panel.js: draggable ставится, только если у бойца ещё нет
// tokenId). В отличие от персонажа/монстра/ассета выше, токен здесь
// собирает и создаёт СЕРВЕР из уже сохранённого в Combatant снимка
// (имя/арт/цвет/владелец/characterId/monsterId, см. room.go:
// handlePlaceCombatantToken) — клиенту незачем заново тащить с сервера
// карточку монстра или искать персонажа в dmCharacters, он просто говорит
// "вот этого бойца и вот сюда".
sceneCanvasEl.addEventListener("dragover", (e) => {
  if (!e.dataTransfer.types.includes("application/x-beacon-combatant")) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});
sceneCanvasEl.addEventListener("drop", (e) => {
  const combatantId = e.dataTransfer.getData("application/x-beacon-combatant");
  if (!combatantId) return;
  e.preventDefault();
  const { x, y } = vtt.pointToWorld(e);
  vtt.send({ type: "place_combatant_token", combatantId, tokenX: x, tokenY: y });
});

// ================= плейлисты (канал ДМ) =================
// Раньше список плейлистов и треки текущего лежали рядом (модалка шире
// панели). В узкой выезжающей панели это мастер-детейл: playlistListView
// (список) ⇄ playlistTracksView (треки одного плейлиста), переключаются
// целиком, назад — кнопкой "‹ Все плейлисты".
const playlistListView = document.getElementById("playlistListView");
const playlistTracksView = document.getElementById("playlistTracksView");
const playlistRows = document.getElementById("playlistRows");
const trackPanelTitle = document.getElementById("trackPanelTitle");
const trackList = document.getElementById("trackList");
const addTrackForm = document.getElementById("addTrackForm");
const addTrackMsg = document.getElementById("addTrackMsg");
const newTrackLibrary = document.getElementById("newTrackLibrary");
const newTrackName = document.getElementById("newTrackName");
const nowPlayingLabel = document.getElementById("nowPlayingLabel");
const cueVolumeSlider = document.getElementById("cueVolumeSlider");

let playlists = [];
let selectedPlaylistId = null;
let playlistsView = "list"; // "list" | "tracks"
let currentCue = null;
let pendingNewTrackUrl = ""; // из аплоада/библиотеки, для формы "+ Добавить трек"

function refreshNewTrackLibrary() {
  fillLibrary(newTrackLibrary, latestAssets.audio || []);
}

async function refreshPlaylists() {
  try {
    playlists = await fetchAdminPlaylists();
  } catch (err) {
    console.error("не удалось загрузить плейлисты:", err);
    playlists = [];
  }
  renderPlaylistsPanel();
}

function openPlaylistTracks(id) {
  selectedPlaylistId = id;
  playlistsView = "tracks";
  renderPlaylistsPanel();
}
function backToPlaylistList() {
  playlistsView = "list";
  renderPlaylistsPanel();
}
document.getElementById("playlistBackBtn").onclick = backToPlaylistList;

function renderPlaylistsPanel() {
  const showTracks = playlistsView === "tracks" && playlists.some((p) => p.id === selectedPlaylistId);
  playlistListView.style.display = showTracks ? "none" : "block";
  playlistTracksView.style.display = showTracks ? "block" : "none";
  renderPlaylistRows();
  if (showTracks) renderTrackPanel();
}

function renderPlaylistRows() {
  playlistRows.innerHTML = "";
  for (const p of playlists) {
    const row = document.createElement("div");
    row.className = "playlist-row" + (p.id === selectedPlaylistId ? " active" : "");
    const name = document.createElement("span");
    name.className = "pl-name";
    name.textContent = `${p.name} (${(p.tracks || []).length})`;
    name.onclick = () => openPlaylistTracks(p.id);
    const renameBtn = document.createElement("button");
    renameBtn.innerHTML = icon("pencil", { size: 13 });
    renameBtn.title = "Переименовать";
    renameBtn.onclick = async (e) => {
      e.stopPropagation();
      const newName = prompt("Новое название плейлиста:", p.name);
      if (!newName) return;
      try {
        await renamePlaylist(p.id, newName);
        await refreshPlaylists();
      } catch (err) {
        alert(err.message);
      }
    };
    const delBtn = document.createElement("button");
    delBtn.innerHTML = icon("trash", { size: 13 });
    delBtn.title = "Удалить плейлист";
    delBtn.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Удалить плейлист «${p.name}» вместе со всеми треками?`)) return;
      try {
        await deletePlaylist(p.id);
        if (selectedPlaylistId === p.id) selectedPlaylistId = null;
        await refreshPlaylists();
      } catch (err) {
        alert(err.message);
      }
    };
    row.appendChild(name);
    row.appendChild(renameBtn);
    row.appendChild(delBtn);
    playlistRows.appendChild(row);
  }
}

function renderTrackPanel() {
  const playlist = playlists.find((p) => p.id === selectedPlaylistId);
  if (!playlist) return;
  trackPanelTitle.textContent = playlist.name;
  trackList.innerHTML = "";
  const tracks = playlist.tracks || [];
  tracks.forEach((t, i) => {
    const isPlaying = !!(currentCue && currentCue.url === t.url);
    const row = document.createElement("div");
    row.className = "track-row" + (isPlaying ? " playing" : "");
    const playBtn = document.createElement("button");
    playBtn.innerHTML = icon("play", { size: 13 });
    playBtn.title = isPlaying ? "Играет сейчас — нажми, чтобы перезапустить" : "Играть";
    playBtn.onclick = () => vtt.send({ type: "play_cue", cue: { url: t.url, name: t.name, volume: t.volume, loop: t.loop } });
    const name = document.createElement("span");
    name.className = "track-name";
    name.textContent = t.name;
    const volSlider = document.createElement("input");
    volSlider.type = "range";
    volSlider.min = 0;
    volSlider.max = 100;
    volSlider.value = Math.round(t.volume * 100);
    volSlider.title = "Громкость трека";
    volSlider.onchange = async () => {
      const vol = volSlider.value / 100;
      try {
        await updatePlaylistTrack(playlist.id, t.id, t.name, vol, t.loop);
        t.volume = vol;
        // трек играет прямо сейчас — обновляем громкость на лету, не
        // дожидаясь следующего запуска.
        if (currentCue && currentCue.url === t.url) vtt.send({ type: "set_cue_volume", cue: { volume: vol } });
      } catch (err) {
        alert(err.message);
      }
    };
    const loopBtn = document.createElement("button");
    const setLoopBtnLabel = () => {
      loopBtn.innerHTML = icon(t.loop ? "repeat" : "minus", { size: 13 });
      loopBtn.append(t.loop ? " Луп" : " Один раз");
      loopBtn.title = t.loop
        ? "Трек зациклен — нажми, чтобы играть один раз"
        : "Трек играет один раз — нажми, чтобы зациклить";
    };
    setLoopBtnLabel();
    loopBtn.onclick = async () => {
      const newLoop = !t.loop;
      try {
        await updatePlaylistTrack(playlist.id, t.id, t.name, t.volume, newLoop);
        t.loop = newLoop;
        setLoopBtnLabel();
      } catch (err) {
        alert(err.message);
      }
    };
    const upBtn = document.createElement("button");
    upBtn.innerHTML = icon("arrow-up", { size: 13 });
    upBtn.title = "Передвинуть выше";
    upBtn.disabled = i === 0;
    upBtn.onclick = async () => {
      await movePlaylistTrack(playlist.id, t.id, "up");
      await refreshPlaylists();
    };
    const downBtn = document.createElement("button");
    downBtn.innerHTML = icon("arrow-down", { size: 13 });
    downBtn.title = "Передвинуть ниже";
    downBtn.disabled = i === tracks.length - 1;
    downBtn.onclick = async () => {
      await movePlaylistTrack(playlist.id, t.id, "down");
      await refreshPlaylists();
    };
    const delBtn = document.createElement("button");
    delBtn.innerHTML = icon("trash", { size: 13 });
    delBtn.onclick = async () => {
      if (!confirm(`Удалить трек «${t.name}»?`)) return;
      try {
        await deletePlaylistTrack(playlist.id, t.id);
        await refreshPlaylists();
      } catch (err) {
        alert(err.message);
      }
    };
    delBtn.title = "Удалить трек";
    row.append(playBtn, name, volSlider, loopBtn, upBtn, downBtn, delBtn);
    trackList.appendChild(row);
  });
}

onPanelOpen("playlists", async () => {
  backToPlaylistList(); // всегда открываемся на списке, не на треках прошлой сессии
  refreshNewTrackLibrary();
  await refreshPlaylists();
});

document.getElementById("newPlaylistForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nameInput = document.getElementById("newPlaylistName");
  const name = nameInput.value.trim();
  if (!name) return;
  try {
    await createPlaylist(name);
    nameInput.value = "";
    await refreshPlaylists();
  } catch (err) {
    alert(err.message);
  }
});

// stripExt — "тема_боя.mp3" → "тема_боя", чтобы автоподставленное имя трека
// не тащило за собой расширение файла.
function stripExt(fileName) {
  const idx = fileName.lastIndexOf(".");
  return idx > 0 ? fileName.slice(0, idx) : fileName;
}
document.getElementById("newTrackUpload").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const { url } = await uploadFile(file, "audio");
    pendingNewTrackUrl = url;
    if (!newTrackName.value.trim()) newTrackName.value = stripExt(file.name);
    await refreshLibrary(); // заодно обновит newTrackLibrary через refreshNewTrackLibrary()
  } catch (err) {
    addTrackMsg.textContent = "Не удалось загрузить: " + err.message;
  }
};
newTrackLibrary.onchange = () => {
  if (!newTrackLibrary.value) return;
  pendingNewTrackUrl = newTrackLibrary.value;
  if (!newTrackName.value.trim()) {
    newTrackName.value = newTrackLibrary.options[newTrackLibrary.selectedIndex].textContent;
  }
};

addTrackForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  addTrackMsg.textContent = "";
  const name = newTrackName.value.trim();
  const url = pendingNewTrackUrl || newTrackLibrary.value;
  if (!name || !url) {
    addTrackMsg.textContent = "Нужны имя и файл/трек из библиотеки.";
    return;
  }
  try {
    await addPlaylistTrack(
      selectedPlaylistId,
      url,
      name,
      document.getElementById("newTrackVolume").value / 100,
      document.getElementById("newTrackLoop").checked
    );
    newTrackName.value = "";
    document.getElementById("newTrackUpload").value = "";
    newTrackLibrary.value = "";
    document.getElementById("newTrackLoop").checked = false;
    pendingNewTrackUrl = "";
    await refreshPlaylists();
  } catch (err) {
    addTrackMsg.textContent = err.message;
  }
});

// ---- "Сейчас играет" + автопереход плейлиста ----
function renderNowPlaying() {
  if (!currentCue) {
    nowPlayingLabel.textContent = "Ничего не играет";
    cueVolumeSlider.value = 80;
  } else {
    nowPlayingLabel.textContent = "▶ " + currentCue.name;
    cueVolumeSlider.value = Math.round(currentCue.volume * 100);
  }
}
document.addEventListener("vtt:cueChanged", (e) => {
  currentCue = e.detail;
  renderNowPlaying();
  if (openPanelSection === "playlists" && playlistsView === "tracks") renderTrackPanel(); // подсветить playing-трек
});
document.getElementById("cueStopBtn").onclick = () => vtt.send({ type: "stop_cue" });
cueVolumeSlider.oninput = () => {
  if (!currentCue) return;
  vtt.send({ type: "set_cue_volume", cue: { volume: cueVolumeSlider.value / 100 } });
};

// Автопереключение плейлиста ведёт клиент ДМ: сервер не декодирует аудио и
// не знает длительность трека, поэтому следующий трек шлём сами по событию
// "ended" на канале ДМ (vtt.cueAudio, слушатель вешается в boot() выше,
// когда vtt уже существует). Работает, пока открыта вкладка ДМ.
function handleCueEnded() {
  if (!currentCue) return;
  const playlist = playlists.find((p) => (p.tracks || []).some((t) => t.url === currentCue.url));
  if (!playlist) return;
  const tracks = playlist.tracks;
  const idx = tracks.findIndex((t) => t.url === currentCue.url);
  const next = tracks[idx + 1];
  if (next) {
    vtt.send({ type: "play_cue", cue: { url: next.url, name: next.name, volume: next.volume, loop: next.loop } });
  } else {
    vtt.send({ type: "stop_cue" });
  }
}

// ================= кубы =================
// initDiceRoller теперь зовётся внутри boot() (см. выше), а не здесь на
// верхнем уровне — ей нужен vtt.sideMenu, который появляется только после
// initVTT().

// ================= заметки ДМ =================
// Мастер-детейл в стиле "Плейлистов" (noteListView ⇄ noteDetailView), плюс
// рендер markdown + вики-ссылки [[...]] (см. notes/markdown.js — общий модуль
// с web/src/pages/note-window.js, отдельным окном заметки).
const noteListView = document.getElementById("noteListView");
const noteDetailView = document.getElementById("noteDetailView");
const noteRows = document.getElementById("noteRows");
const noteSearch = document.getElementById("noteSearch");
const noteCurrentFolderEl = document.getElementById("noteCurrentFolder");
const noteFolderResetBtn = document.getElementById("noteFolderResetBtn");
const noteFolderSelect = document.getElementById("noteFolderSelect");
const noteDetailTitle = document.getElementById("noteDetailTitle");
const noteRenderView = document.getElementById("noteRenderView");
const noteEditView = document.getElementById("noteEditView");
const noteEditArea = document.getElementById("noteEditArea");
const noteEditToggleBtn = document.getElementById("noteEditToggleBtn");
const noteMsg = document.getElementById("noteMsg");
mountNoteToolbar(document.getElementById("noteToolbar"), noteEditArea);

let notesList = []; // [{id,title,folder,updatedAt}] — метаданные, для дерева и резолва вики-ссылок
let noteFolders = []; // ["Приключение", "Приключение/Глава 1", ...] — включая пустые
let notesView = "list"; // "list" | "detail"
let selectedNote = null; // {id,title,folder,content,updatedAt} заметки, открытой в детейле
let noteEditing = false;
// openNoteFolders — какие ветки дерева раскрыты; currentNoteFolder — в какую
// папку попадёт следующая созданная заметка/подпапка ("" — корень).
const openNoteFolders = new Set();
let currentNoteFolder = "";

async function refreshNotesList() {
  try {
    [notesList, noteFolders] = await Promise.all([fetchNotes(), fetchNoteFolders()]);
  } catch (err) {
    console.error("не удалось загрузить список заметок:", err);
    notesList = [];
    noteFolders = [];
  }
  renderNoteRows();
}

// noteFolderTree — дерево из плоских путей заметок и папок. Узел:
// {path, name, children: Map, notes: []}. Пустые папки приезжают отдельным
// списком (см. fetchNoteFolders) — иначе только что созданная папка
// пропадала бы до первой заметки в ней.
function noteFolderTree() {
  const root = { path: "", name: "", children: new Map(), notes: [] };
  const nodeFor = (path) => {
    let node = root;
    if (!path) return node;
    let acc = "";
    for (const segment of path.split("/")) {
      acc = acc ? acc + "/" + segment : segment;
      if (!node.children.has(segment)) {
        node.children.set(segment, { path: acc, name: segment, children: new Map(), notes: [] });
      }
      node = node.children.get(segment);
    }
    return node;
  };
  for (const folder of noteFolders) nodeFor(folder);
  for (const n of notesList) nodeFor(n.folder || "").notes.push(n);
  return root;
}

function noteRowEl(n, { showFolder = false } = {}) {
  const row = document.createElement("div");
  row.className = "note-row";
  const title = document.createElement("span");
  title.className = "note-title";
  title.textContent = n.title;
  const meta = document.createElement("span");
  meta.className = "note-meta";
  meta.textContent = showFolder && n.folder ? n.folder : formatDate(n.updatedAt);
  meta.title = showFolder && n.folder ? "Папка: " + n.folder : "";
  row.append(title, meta);
  row.onclick = () => openNote(n.id);
  return row;
}

function noteFolderRowEl(node) {
  const open = openNoteFolders.has(node.path);
  const row = document.createElement("div");
  row.className = "note-folder-row" + (currentNoteFolder === node.path ? " current" : "");

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "note-folder-toggle";
  toggle.innerHTML = icon(open ? "chevron-down" : "chevron-right", { size: 12 });
  const name = document.createElement("span");
  name.className = "note-folder-name";
  name.textContent = node.name;
  const count = document.createElement("span");
  count.className = "note-folder-count";
  count.textContent = String(countNotesIn(node));

  // Клик по папке делает две вещи сразу — раскрывает её и делает "текущей"
  // (новая заметка/подпапка создаётся именно в ней): это то же поведение,
  // что у файловых менеджеров, и избавляет от отдельного «выбрать папку».
  const select = () => {
    currentNoteFolder = node.path;
    if (open) openNoteFolders.delete(node.path);
    else openNoteFolders.add(node.path);
    renderNoteRows();
  };

  const actions = document.createElement("span");
  actions.className = "note-folder-actions";
  actions.append(
    folderActionBtn("plus", "Создать подпапку", () => createNoteFolderPrompt(node.path)),
    folderActionBtn("pencil", "Переименовать папку", () => renameNoteFolderPrompt(node)),
    folderActionBtn("trash", "Удалить папку вместе с заметками", () => deleteNoteFolderPrompt(node))
  );
  row.append(toggle, name, count, actions);
  row.onclick = select;
  return row;
}

function folderActionBtn(iconName, title, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "note-icon-btn";
  btn.title = title;
  btn.innerHTML = icon(iconName, { size: 12 });
  btn.onclick = (e) => {
    e.stopPropagation();
    onClick();
  };
  return btn;
}

function countNotesIn(node) {
  let total = node.notes.length;
  for (const child of node.children.values()) total += countNotesIn(child);
  return total;
}

function renderNoteTree(node, container, depth) {
  const folders = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name, "ru"));
  for (const child of folders) {
    const row = noteFolderRowEl(child);
    row.style.paddingLeft = 4 + depth * 12 + "px";
    container.appendChild(row);
    if (openNoteFolders.has(child.path)) renderNoteTree(child, container, depth + 1);
  }
  for (const n of node.notes) {
    const row = noteRowEl(n);
    row.style.marginLeft = depth * 12 + "px";
    container.appendChild(row);
  }
}

let noteRowsKey = null;

function noteRowsStateKey(filter) {
  return JSON.stringify([
    filter,
    currentNoteFolder,
    [...openNoteFolders].sort(),
    notesList.map((n) => [n.id, n.title, n.folder || "", n.updatedAt]),
    noteFolders,
  ]);
}

function renderNoteRows() {
  const filter = noteSearch.value.trim().toLowerCase();

  noteCurrentFolderEl.textContent = currentNoteFolder ? "в папке: " + currentNoteFolder : "в корне библиотеки";
  noteFolderResetBtn.style.display = currentNoteFolder ? "" : "none";

  const key = noteRowsStateKey(filter);
  if (key === noteRowsKey) return;
  noteRowsKey = key;

  const rows = document.createDocumentFragment();

  // Поиск показывает плоский список по всей библиотеке: искать заметку,
  // раскрывая ветки руками, — ровно то, от чего поиск и избавляет. Папка
  // при этом видна в строке справа.
  if (filter) {
    const found = notesList.filter(
      (n) => n.title.toLowerCase().includes(filter) || (n.folder || "").toLowerCase().includes(filter)
    );
    if (!found.length) rows.appendChild(hintEl("Ничего не найдено."));
    else for (const n of found) rows.appendChild(noteRowEl(n, { showFolder: true }));
    noteRows.replaceChildren(rows);
    return;
  }

  renderNoteTree(noteFolderTree(), rows, 0);
  if (!notesList.length && !noteFolders.length) {
    rows.appendChild(hintEl("Заметок пока нет. Создай первую ниже — или целую папку кнопкой «Папка»."));
  }
  noteRows.replaceChildren(rows);
}

function hintEl(text) {
  const p = document.createElement("p");
  p.className = "hint";
  p.textContent = text;
  return p;
}
noteSearch.oninput = renderNoteRows;

// ---- папки: создание/переименование/удаление ----

async function createNoteFolderPrompt(parent) {
  const name = prompt(parent ? `Название подпапки внутри «${parent}»:` : "Название новой папки:");
  if (!name || !name.trim()) return;
  const path = parent ? parent + "/" + name.trim() : name.trim();
  try {
    await createNoteFolder(path);
    openNoteFolders.add(parent);
    currentNoteFolder = path;
    await refreshNotesList();
  } catch (err) {
    alert("Не удалось создать папку: " + err.message);
  }
}

async function renameNoteFolderPrompt(node) {
  const name = prompt("Новое название папки:", node.name);
  if (!name || !name.trim() || name.trim() === node.name) return;
  const parent = node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : "";
  const target = parent ? parent + "/" + name.trim() : name.trim();
  try {
    await renameNoteFolder(node.path, target);
    // Раскрытые ветки и «текущая папка» ссылались на старый путь — переносим
    // их на новый, иначе дерево схлопнется прямо под руками.
    for (const open of [...openNoteFolders]) {
      if (open === node.path || open.startsWith(node.path + "/")) {
        openNoteFolders.delete(open);
        openNoteFolders.add(target + open.slice(node.path.length));
      }
    }
    if (currentNoteFolder === node.path || currentNoteFolder.startsWith(node.path + "/")) {
      currentNoteFolder = target + currentNoteFolder.slice(node.path.length);
    }
    await refreshNotesList();
  } catch (err) {
    alert("Не удалось переименовать: " + err.message);
  }
}

async function deleteNoteFolderPrompt(node) {
  const total = countNotesIn(node);
  const what = total ? `папку «${node.path}» и ${total} заметок внутри` : `пустую папку «${node.path}»`;
  if (!confirm(`Удалить ${what}? Это необратимо.`)) return;
  try {
    await deleteNoteFolder(node.path);
    if (currentNoteFolder === node.path || currentNoteFolder.startsWith(node.path + "/")) currentNoteFolder = "";
    await refreshNotesList();
  } catch (err) {
    alert("Не удалось удалить папку: " + err.message);
  }
}

document.getElementById("newNoteFolderBtn").onclick = () => createNoteFolderPrompt(currentNoteFolder);
noteFolderResetBtn.onclick = () => {
  currentNoteFolder = "";
  renderNoteRows();
};

function renderNotesPanel() {
  const showDetail = notesView === "detail" && selectedNote;
  noteListView.style.display = showDetail ? "none" : "block";
  noteDetailView.style.display = showDetail ? "block" : "none";
  if (showDetail) renderNoteDetail();
}

// renderNoteFolderSelect — «в какой папке лежит эта заметка» в карточке.
// Список — все существующие папки плюс корень; выбор сразу переносит файл
// (см. moveNote), отдельной кнопки «сохранить» тут не нужно.
function renderNoteFolderSelect() {
  noteFolderSelect.innerHTML = "";
  const options = ["", ...noteFolders];
  if (selectedNote.folder && !options.includes(selectedNote.folder)) options.push(selectedNote.folder);
  for (const folder of options) {
    const opt = document.createElement("option");
    opt.value = folder;
    opt.textContent = folder || "— корень библиотеки —";
    opt.selected = folder === (selectedNote.folder || "");
    noteFolderSelect.appendChild(opt);
  }
}

noteFolderSelect.onchange = async () => {
  if (!selectedNote) return;
  const target = noteFolderSelect.value;
  try {
    selectedNote = await moveNote(selectedNote.id, target);
    noteMsg.textContent = target ? `Перенесено в «${target}».` : "Перенесено в корень библиотеки.";
    refreshNotesList();
  } catch (err) {
    noteMsg.textContent = err.message;
    renderNoteFolderSelect(); // вернуть селект к реальному состоянию
  }
};

function renderNoteDetail() {
  noteMsg.textContent = "";
  noteDetailTitle.textContent = selectedNote.title;
  renderNoteFolderSelect();
  noteEditView.style.display = noteEditing ? "block" : "none";
  noteRenderView.style.display = noteEditing ? "none" : "block";
  noteEditToggleBtn.innerHTML = icon(noteEditing ? "eye" : "pencil", { size: 14 });
  noteEditToggleBtn.title = noteEditing ? "Просмотр" : "Редактировать";
  noteEditToggleBtn.classList.toggle("active", noteEditing);
  if (noteEditing) {
    noteEditArea.value = selectedNote.content;
    noteEditArea.focus();
  } else {
    noteRenderView.innerHTML = renderNoteHtml(selectedNote.content);
    enhanceRolls(noteRenderView, sendNoteRoll);
  }
}

// sendNoteRoll — бросок из текста заметки уходит в общий лог стола тем же
// сообщением, что и кнопки панели кубов (см. dice.js).
function sendNoteRoll(formula, label) {
  if (!vtt) return;
  const title = selectedNote && selectedNote.title;
  vtt.send({ type: "roll_dice", formula, label: title ? `${title} — ${label}` : label });
}

let noteOpenSeq = 0;

async function openNote(id, { edit = false } = {}) {
  const seq = ++noteOpenSeq;
  notesView = "detail";
  let note;
  try {
    note = await fetchNote(id);
  } catch (err) {
    if (seq !== noteOpenSeq) return;
    alert("Не удалось открыть заметку: " + err.message);
    notesView = "list";
    renderNotesPanel();
    return;
  }
  if (seq !== noteOpenSeq) return;
  selectedNote = note;
  noteEditing = edit;
  renderNotesPanel();
}

function backToNoteList() {
  notesView = "list";
  selectedNote = null;
  renderNotesPanel();
  refreshNotesList(); // заголовок мог поменяться после правки
}
document.getElementById("noteBackBtn").onclick = backToNoteList;

// Ссылки .catalog-ref внутри текста заметки — на карточки библиотек и на
// другие заметки; их эмитит импорт модуля Foundry вместо своих @UUID[…]
// (см. internal/foundry/links.go). Открываются плавающим окном, как и из
// описаний карточек.
wireCatalogLinks(noteRenderView);

// клик по вики-ссылке [[...]] внутри рендера — существующая заметка
// открывается тут же; для несуществующей предлагаем создать с этим заголовком.
wireWikiLinks(noteRenderView, () => notesList, {
  // Папка открытой заметки — точка отсчёта для ссылок вида [[NPC/Марго]] и
  // для [[Заголовок]] без пути (см. resolveWikiTarget).
  getFolder: () => (selectedNote && selectedNote.folder) || "",
  onOpen: (id) => openNote(id),
  onCreateMissing: async (title, folder) => {
    const where = folder ? ` в папке «${folder}»` : " в корне библиотеки";
    if (!confirm(`Заметки «${title}» не существует. Создать${where}?`)) return;
    try {
      const n = await createNote(`# ${title}\n\n`, folder);
      await refreshNotesList();
      await openNote(n.id, { edit: true });
    } catch (err) {
      alert("Не удалось создать заметку: " + err.message);
    }
  },
});

noteEditToggleBtn.onclick = () => {
  noteEditing = !noteEditing;
  renderNoteDetail();
};

document.getElementById("noteSaveBtn").onclick = async () => {
  noteMsg.textContent = "";
  try {
    selectedNote = await updateNote(selectedNote.id, noteEditArea.value);
    noteEditing = false;
    renderNoteDetail();
    refreshNotesList();
  } catch (err) {
    noteMsg.textContent = err.message;
  }
};

document.getElementById("noteDeleteBtn").onclick = async () => {
  if (!selectedNote) return;
  if (!confirm(`Удалить заметку «${selectedNote.title}»? Это необратимо (значки на карте, ссылающиеся на неё, останутся, но перестанут открываться).`)) return;
  try {
    await deleteNote(selectedNote.id);
    backToNoteList();
  } catch (err) {
    alert("Не удалось удалить: " + err.message);
  }
};

document.getElementById("notePlaceBtn").onclick = () => {
  if (!selectedNote) return;
  closeSidePanel();
  document.dispatchEvent(
    new CustomEvent("vtt:placeNoteMarker", { detail: { noteId: selectedNote.id, label: selectedNote.title } })
  );
  alert("Теперь кликни на карте, куда поставить свиток.");
};

document.getElementById("noteWindowBtn").onclick = () => {
  if (!selectedNote) return;
  // Как и лист персонажа: сначала плавающее окно поверх канваса (тот же
  // приём, см. floating-window.js), настоящее отдельное окно браузера —
  // уже кнопкой 🗗 В ШАПКЕ этого плавающего окна, не отсюда напрямую.
  openFloatingWindow({
    key: "note-" + selectedNote.id,
    title: selectedNote.title,
    url: `/note-window.html?id=${selectedNote.id}`,
    width: 560,
    height: 760,
    popoutFeatures: "width=560,height=760",
  });
};

document.getElementById("newNoteForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const titleInput = document.getElementById("newNoteTitle");
  const title = titleInput.value.trim();
  if (!title) return;
  try {
    // Новая заметка ложится в выбранную сейчас папку дерева (см.
    // currentNoteFolder) — то же, чего ждёшь от «создать» в файловом
    // менеджере.
    const n = await createNote(`# ${title}\n\n`, currentNoteFolder);
    titleInput.value = "";
    await refreshNotesList();
    await openNote(n.id, { edit: true });
  } catch (err) {
    alert("Не удалось создать заметку: " + err.message);
  }
});

// значок на карте (двойной клик, см. interaction.js) — открыть панель прямо
// на нужной заметке, а не просто раскрыть раздел.
document.addEventListener("vtt:openNoteMarker", (e) => {
  setSidePanelSection("notes");
  openNote(e.detail.noteId);
});

onPanelOpen("notes", () => {
  notesView = "list";
  selectedNote = null;
  renderNotesPanel();
  refreshNotesList();
});

// ================= Компендиум (см. compendium-menu.js/catalog.js) =================
// Существа/Заклинания/Предметы/Справочник переехали из четырёх отдельных
// панелей левого рейла в один плавающий список категорий на правой колонке
// канваса (иконка монтируется в boot(), см. vtt.sideMenu.addIcon ниже) —
// сами списки одной категории теперь отдельные плавающие окна
// (web/catalog.html + pages/catalog.js), а не .panel-section здесь. Тут
// остаются только два моста между топ-документом и iframe catalog.html:
// - catalog.js сам не может звать openFloatingWindow (он живёт в iframe, это
//   функция топ-документа) — шлёт postMessage родителю, ловим его здесь;
// - "beacon:*Saved" от карточки записи (spellbook.js/itembook.js/...) идёт
//   её НЕПОСРЕДСТВЕННОМУ родителю (этому топ-документу, а не окну списка,
//   которое её открыло) — форвардим в открытые catalog-* окна через
//   floating-window.js:postToOpenWindows, чтобы их список сам обновился без
//   ручного закрытия/открытия.
window.addEventListener("message", (e) => {
  if (e.origin !== location.origin || !e.data) return;
  if (e.data.type === "beacon:openFloatingWindow") {
    openFloatingWindow({ key: e.data.key, title: e.data.title, url: e.data.url });
  } else if (
    e.data.type === "beacon:monsterSaved" ||
    e.data.type === "beacon:spellSaved" ||
    e.data.type === "beacon:itemSaved" ||
    e.data.type === "beacon:referenceSaved" ||
    e.data.type === "beacon:conditionSaved"
  ) {
    postToOpenWindows("catalog-", e.data);
  } else if (e.data.type === "beacon:applySpellStatus") {
    // Клик по чипу «Накладывает: …» в карточке заклинания (см.
    // pages/spellbook.js: readStatuses). Сама карточка живёт в iframe и цели
    // на карте не знает — выбор цели и отправку команды делает эта страница.
    openSpellStatusPicker(e.data);
  }
});

// ================= наложение состояния из карточки заклинания =================
// Выделения токенов в сцене нет как понятия (см. web/src/vtt/interaction.js —
// там сразу драг, без состояния «выбран»), поэтому цель выбирается списком:
// все НЕ-световые токены активной сцены, можно отметить несколько сразу
// (в отличие от Foundry, где HUD работает ровно с одним токеном). Метка
// вешается с подписью источника «Заклинание «…»» — её видно в подсказке
// чипа в трекере (см. domain.AppliedStatus.Source).
const spellStatusPicker = document.getElementById("spellStatusPicker");

function closeSpellStatusPicker() {
  spellStatusPicker.style.display = "none";
  spellStatusPicker.innerHTML = "";
}

function openSpellStatusPicker(payload) {
  const scene = vtt.getScene();
  const tokens = Object.values(scene.tokens || {}).filter((t) => !t.lightOnly);
  spellStatusPicker.innerHTML = "";

  const title = document.createElement("div");
  title.className = "picker-title";
  title.textContent = `«${payload.name}»${payload.rounds ? ` · ${payload.rounds} р.` : ""} — на кого?`;
  spellStatusPicker.appendChild(title);

  if (tokens.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "На активной сцене нет ни одного токена.";
    spellStatusPicker.appendChild(empty);
  }

  const checks = [];
  for (const t of tokens) {
    const row = document.createElement("label");
    row.className = "picker-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = t.id;
    const av = document.createElement("span");
    av.className = "picker-avatar";
    if (t.image) av.style.backgroundImage = `url("${t.image}")`;
    else av.style.background = t.color || "#555";
    const name = document.createElement("span");
    name.textContent = t.label || "Без имени";
    row.append(cb, av, name);
    checks.push(cb);
    spellStatusPicker.appendChild(row);
  }

  const foot = document.createElement("div");
  foot.className = "picker-foot";
  const apply = document.createElement("button");
  apply.type = "button";
  apply.textContent = "Наложить";
  apply.onclick = () => {
    for (const cb of checks) {
      if (!cb.checked) continue;
      vtt.send({
        type: "apply_status",
        tokenId: cb.value,
        statusSlug: payload.slug,
        rounds: payload.rounds || 0,
        source: payload.spellName ? `Заклинание «${payload.spellName}»` : "",
      });
    }
    closeSpellStatusPicker();
  };
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Отмена";
  cancel.onclick = closeSpellStatusPicker;
  foot.append(apply, cancel);
  spellStatusPicker.appendChild(foot);

  spellStatusPicker.style.display = "flex";
}

// ================= "Хаб лута" ДМ (domain.LootHub) =================
// Живёт вне сцены/боя (см. internal/service/room.go: hubPayload) — приходит
// по WS ("hub_state", см. vtt/net.js), тем же принципом, что и трекер
// инициативы (combat_state): последнее состояние читаем из события, своей
// копии-источника-правды не держим. ДМ добавляет предметы из каталога через
// item-picker.js, игроки разбирают их себе на своём экране (см. player.js).
const lootHubRows = document.getElementById("lootHubRows");
let latestHub = [];

function renderLootHub() {
  lootHubRows.innerHTML = "";
  if (latestHub.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "Хаб пуст — добавь предметы из каталога выше.";
    lootHubRows.appendChild(empty);
    return;
  }
  for (const entry of latestHub) {
    const row = document.createElement("div");
    row.className = "dmchar-row item-row";
    const avatar = document.createElement("div");
    avatar.className = "dmchar-avatar";
    if (entry.imageUrl) avatar.style.backgroundImage = `url("${entry.imageUrl}")`;
    else avatar.textContent = "—";
    row.appendChild(avatar);
    const name = document.createElement("div");
    name.className = "dmchar-name";
    name.textContent = entry.name;
    name.title = entry.name;
    row.appendChild(name);
    const qtyInput = document.createElement("input");
    qtyInput.type = "number";
    qtyInput.min = "0";
    qtyInput.value = String(entry.quantity);
    qtyInput.title = "Количество";
    qtyInput.style.width = "56px";
    qtyInput.onchange = () => {
      const q = parseInt(qtyInput.value, 10);
      vtt.send({ type: "hub_set_quantity", entryId: entry.id, quantity: Number.isFinite(q) && q >= 0 ? q : entry.quantity });
    };
    row.appendChild(qtyInput);
    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn";
    delBtn.innerHTML = icon("trash", { size: 13 });
    delBtn.title = "Убрать из хаба";
    delBtn.onclick = () => vtt.send({ type: "hub_remove_item", entryId: entry.id });
    row.appendChild(delBtn);
    lootHubRows.appendChild(row);
  }
}

document.addEventListener("vtt:hubState", (e) => {
  latestHub = e.detail || [];
  renderLootHub();
});

initItemPicker(document.getElementById("lootHubPicker"), {
  onPick: (item, qty) => vtt.send({ type: "hub_add_item", itemId: item.id, quantity: qty }),
});

onPanelOpen("loot", renderLootHub);

// ================= трекер инициативы (панель) =================
// Логика самой панели (рендер списка/поиск по бестиарию/кнопки хода) —
// в отдельном модуле combat-panel.js, общем со standalone-окном
// combat-tracker.html (см. "🗗 Открыть в окне" в шапке этой панели ниже).
// send оборачивает vtt.send лениво: initCombatPanel вызывается сразу при
// загрузке модуля, а vtt (см. let vtt в начале файла) станет валидным только
// после await initVTT(...) внутри boot() — обработчики кликов вызовут
// send(...) позже, когда vtt уже точно готов.
initCombatPanel({
  send: (msg) => vtt.send(msg),
  els: {
    startBtn: document.getElementById("combatStartBtn"),
    endBtn: document.getElementById("combatEndBtn"),
    roundRow: document.getElementById("combatRoundRow"),
    roundLabel: document.getElementById("combatRoundLabel"),
    prevBtn: document.getElementById("combatPrevBtn"),
    nextBtn: document.getElementById("combatNextBtn"),
    addBtn: document.getElementById("combatAddBtn"),
    searchWrap: document.getElementById("combatSearchWrap"),
    search: document.getElementById("combatSearch"),
    searchResults: document.getElementById("combatSearchResults"),
    list: document.getElementById("combatList"),
  },
});

// combatShowHpToggle — раздел "Настройки" (общий, не привязан к сцене):
// показывать ли HP в верхнем оверлее хода (combat-bar.js) игрокам/TV, а не
// только ДМ (см. domain.CombatState.ShowHP / "set_show_hp" в
// internal/service/room.go). Значение приходит с сервера в каждом
// "combat_state" (payload.showHp) — синкаем чекбокс на каждое событие, а не
// только при открытии панели, чтобы он не разъезжался, если состояние
// поменяли из другого места (например, из этой же комнаты в другой вкладке).
const combatShowHpToggle = document.getElementById("combatShowHpToggle");
document.addEventListener("vtt:combatState", (e) => {
  combatShowHpToggle.checked = !!e.detail.showHp;
});
combatShowHpToggle.onchange = () => {
  vtt.send({ type: "set_show_hp", showHp: combatShowHpToggle.checked });
};

// lootingEnabledToggle — тот же приём, что combatShowHpToggle: значение
// приходит внутри "combat_state" (payload.lootingEnabled, см.
// domain.CombatState.LootingEnabled / "set_looting_enabled" в
// internal/service/room.go) — разрешать ли игрокам лутить убитых монстров.
const lootingEnabledToggle = document.getElementById("lootingEnabledToggle");
document.addEventListener("vtt:combatState", (e) => {
  lootingEnabledToggle.checked = !!e.detail.lootingEnabled;
});
lootingEnabledToggle.onchange = () => {
  vtt.send({ type: "set_looting_enabled", lootingEnabled: lootingEnabledToggle.checked });
};

// "🗗 Открыть в окне" — тот же приём, что у заметок (#noteWindowBtn): вся
// панель целиком, тем же кодом (combat-panel.js), в плавающем окне поверх
// канваса — удобно держать трекер открытым постоянно, не занимая рейл-панель.
document.getElementById("combatPopoutBtn").onclick = () => {
  openFloatingWindow({ key: "combat-tracker", title: "Трекер инициативы", url: "/combat-tracker.html" });
};

// клик мимо меню — закрыть
document.addEventListener("mousedown", (e) => {
  if (tokenMenu.style.display === "block" && !tokenMenu.contains(e.target)) closeTokenMenu();
  if (wallPointMenu.style.display === "block" && !wallPointMenu.contains(e.target)) closeWallPointMenu();
  if (noteMarkerMenu.style.display === "flex" && !noteMarkerMenu.contains(e.target)) closeNoteMarkerMenu();
  if (fogAreaMenu.style.display === "block" && !fogAreaMenu.contains(e.target)) closeFogAreaMenu();
  if (wallMenu.style.display === "block" && !wallMenu.contains(e.target)) closeWallMenu();
  if (buildingMenu.style.display === "block" && !buildingMenu.contains(e.target)) closeBuildingMenu();
});

// ===================================================================
// =========== левое меню: рейл (иконки) + выезжающая панель =========
// ===================================================================
// Один открытый раздел за раз (аккордеон): клик по иконке рейла
// открывает соответствующую .panel-section и подсвечивает иконку;
// повторный клик по уже открытой — закрывает панель (ширина едет в 0,
// #canvasWrap растягивается обратно — см. ResizeObserver в vtt/index.js,
// он сам подхватит новую ширину родителя канваса).
const sidePanel = document.getElementById("panel");
const railSectionBtns = [...document.querySelectorAll("#rail .rail-btn[data-section]")];
const panelSections = [...document.querySelectorAll(".panel-section[data-panel]")];
let openPanelSection = null;

// Разделы "Настроить сцену" / "Аккаунты" / "Плейлисты" раньше были модалками
// со своим открытием (fetch + рендер при клике). Теперь это такие же секции
// общей выезжающей панели, как "Освещение" — но данные всё ещё нужно
// подгружать/освежать именно в момент открытия, а не заранее. panelOpenHandlers
// объявлен в самом начале файла (см. onPanelOpen выше) — секции регистрируют
// коллбэки там же, где определены, вызывается он отсюда.
function setSidePanelSection(name) {
  const opening = openPanelSection !== name;
  openPanelSection = openPanelSection === name ? null : name;
  sidePanel.classList.toggle("open", !!openPanelSection);
  railSectionBtns.forEach((b) => b.classList.toggle("active", b.dataset.section === openPanelSection));
  panelSections.forEach((s) => s.classList.toggle("active", s.dataset.panel === openPanelSection));
  if (opening && openPanelSection && panelOpenHandlers[openPanelSection]) {
    panelOpenHandlers[openPanelSection]();
  }
}
function closeSidePanel() {
  if (openPanelSection) setSidePanelSection(openPanelSection);
}
railSectionBtns.forEach((b) => (b.onclick = () => setSidePanelSection(b.dataset.section)));
document.querySelectorAll(".panel-close[data-close]").forEach((b) => (b.onclick = closeSidePanel));

// ================= токен света: отдельная быстрая кнопка =================
// В отличие от чекбокса "💡 свет" в разделе "Токены" (который добавляет
// свет обычному токену с артом), это отдельное действие — сразу кладёт на
// сцену токен без арта, только как источник света. Дефолтные радиусы —
// как у факела (20/40 футов), дальше DM правит через ПКМ → меню токена.
document.getElementById("addLightToken").onclick = () => {
  counter++;
  const id = "tok-" + Date.now() + "-" + counter;
  const gridSize = (vtt.getScene().grid && vtt.getScene().grid.size) || 48;
  // lightOnly: true — без владельца/формы/арта, см. domain.Token.LightOnly.
  // hidden ОСОЗНАННО остаётся false — иначе сервер вообще вырежет токен из
  // payload игрока (см. service.Room.sceneFor), и его свет физически
  // нечем будет посчитать на клиенте игрока (layers/vision-fog.js). Сам
  // маркер на экране игрока/TV прячет tokens.js, не сервер.
  const token = {
    id,
    x: 100 + counter * 20,
    y: 100,
    label: "Источник света",
    size: gridSize / 2,
    lightOnly: true,
    hidden: false,
    light: { enabled: true, bright: 20, dim: 40 },
  };
  vtt.send({ type: "add_token", token });
};

// ===================================================================
// ==================== переключатель сцен ==========================
// ===================================================================
// Открытие/закрытие самой панели теперь общее для всех разделов рейла —
// см. блок "левое меню" ниже; здесь только наполнение раздела "Сцена".
const sceneSwitchName = document.getElementById("sceneSwitchName");
const sceneDropdown = document.getElementById("sceneDropdown");
let sceneList = []; // [{id,name,viewerCount}]
let currentSceneId = "";

function renderSceneDropdown() {
  sceneDropdown.innerHTML = "";
  for (const s of sceneList) {
    const row = document.createElement("div");
    row.className = "scene-row row-card" + (s.id === currentSceneId ? " active" : "");
    const handle = document.createElement("span");
    handle.className = "drag-handle";
    handle.innerHTML = icon("grip-vertical", { size: 14 });
    const nameSpan = document.createElement("span");
    nameSpan.className = "scene-name";
    nameSpan.textContent = s.name;
    nameSpan.onclick = () => {
      if (s.id !== currentSceneId) vtt.send({ type: "switch_scene", sceneId: s.id });
      closeSidePanel();
    };
    const viewers = document.createElement("span");
    viewers.className = "scene-viewers pill-badge";
    viewers.innerHTML = icon("user", { size: 11 });
    viewers.append(" " + s.viewerCount);
    // Полные настройки сцены (фон/аудио/сетка) переехали в отдельный раздел
    // рейла "Настроить сцену" и относятся только к активной сцене (см.
    // openSceneSettings ниже) — здесь остаётся быстрое удаление ЛЮБОЙ сцены
    // из списка, не обязательно активной.
    const del = document.createElement("button");
    del.className = "scene-gear icon-btn";
    del.innerHTML = icon("trash", { size: 13 });
    del.title = "Удалить сцену";
    del.disabled = sceneList.length <= 1;
    del.onclick = (ev) => {
      ev.stopPropagation();
      if (!confirm(`Удалить сцену «${s.name}»? Это необратимо.`)) return;
      vtt.send({ type: "delete_scene", sceneId: s.id });
    };
    row.append(handle, nameSpan, viewers, del);
    sceneDropdown.appendChild(row);
  }
}

// "+ Сцена" теперь статична в шапке панели (dm.html), а не пересоздаётся
// каждый renderSceneDropdown() — обработчик вешаем один раз.
document.getElementById("sceneCreateBtn").onclick = () => {
  const name = prompt("Название новой сцены:", "Новая сцена");
  if (name === null) return;
  const sceneId = "scene-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
  vtt.send({ type: "create_scene", sceneId, sceneName: name || "Новая сцена" });
  closeSidePanel();
};

document.addEventListener("vtt:sceneList", (e) => {
  sceneList = e.detail.scenes || [];
  currentSceneId = e.detail.currentSceneId || "";
  const active = sceneList.find((s) => s.id === currentSceneId);
  sceneSwitchName.textContent = active ? active.name : "Сцена";
  renderSceneDropdown();
});

// ===================================================================
// ================= раздел "Настроить сцену" ========================
// ===================================================================
// Раньше это была модалка, открывавшаяся по шестерёнке у ЛЮБОЙ строки в
// списке сцен (даже неактивной — тогда ждали get_scene с сервера). Теперь
// это обычный раздел рейла, как "Освещение", и правит он ВСЕГДА активную
// сцену — данные уже есть локально (vtt.getScene()), round-trip не нужен.
const tabButtons = [...document.querySelectorAll(".modal-tabs button")];
const tabPanels = [...document.querySelectorAll(".modal-tab-panel")];
const bgTab = document.querySelector('.modal-tabs button[data-tab="bg"]');
const audioTab = document.querySelector('.modal-tabs button[data-tab="audio"]');

const fName = document.getElementById("fName");
const fWidth = document.getElementById("fWidth");
const fHeight = document.getElementById("fHeight");
const fFogOfWar = document.getElementById("fFogOfWar");
const fMapUrl = document.getElementById("fMapUrl");
const bgPreview = document.getElementById("bgPreview");
const fGridSize = document.getElementById("fGridSize");
const fGridOffX = document.getElementById("fGridOffX");
const fGridOffY = document.getElementById("fGridOffY");
const fGridVisible = document.getElementById("fGridVisible");
const fUnitsPerCell = document.getElementById("fUnitsPerCell");
const fUnit = document.getElementById("fUnit");
const fGridColor = document.getElementById("fGridColor");
const fGridColorPicker = document.getElementById("fGridColorPicker");
const fGridOpacity = document.getElementById("fGridOpacity");
const fGridOpacityLabel = document.getElementById("fGridOpacityLabel");
const gridEditorBtn = document.getElementById("gridEditorBtn");
const fAmbientUrl = document.getElementById("fAmbientUrl");
const fAmbientVolume = document.getElementById("fAmbientVolume");
const fAmbientVolumeLabel = document.getElementById("fAmbientVolumeLabel");

function switchTab(name) {
  tabButtons.forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  tabPanels.forEach((p) => p.classList.toggle("active", p.dataset.panel === name));
  if (name === "bg") renderAssetTable();
  if (name === "audio") renderAudioAssetTable();
}
tabButtons.forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));

function fillSceneSettingsFrom(s) {
  fName.value = s.name || "";
  fWidth.value = s.width || 1280;
  fHeight.value = s.height || 720;
  fFogOfWar.checked = s.fogOfWar !== false;
  fMapUrl.value = s.mapUrl || "";
  updateBgPreview();
  fAmbientUrl.value = s.ambientUrl || "";
  const ambientPct = Math.round((s.ambientVolume == null ? 0.6 : s.ambientVolume) * 100);
  fAmbientVolume.value = ambientPct;
  fAmbientVolumeLabel.textContent = ambientPct + "%";
  const g = s.grid || {};
  fGridSize.value = g.size || 0;
  fGridOffX.value = g.offsetX || 0;
  fGridOffY.value = g.offsetY || 0;
  fGridVisible.checked = g.visible !== false;
  fUnitsPerCell.value = g.unitsPerCell || 5;
  fUnit.value = g.unit || "ft";
  fGridColor.value = g.lineColor || "#000000";
  fGridColorPicker.value = g.lineColor || "#000000";
  const opacityPct = Math.round((g.lineOpacity == null ? 0.5 : g.lineOpacity) * 100);
  fGridOpacity.value = opacityPct;
  fGridOpacityLabel.textContent = opacityPct + "%";
  document.getElementById("sceneDeleteBtn").disabled = sceneList.length <= 1;
}

function openSceneSettings(tab) {
  switchTab(tab || "basic");
  fillSceneSettingsFrom(vtt.getScene());
}
onPanelOpen("sceneSettings", () => openSceneSettings("basic"));

// раздел открыт и активная сцена обновилась (например, после drag
// "Редактора сетки") — держим поля актуальными.
document.addEventListener("vtt:sceneUpdated", (e) => {
  if (openPanelSection === "sceneSettings" && e.detail.id === currentSceneId) {
    fillSceneSettingsFrom(e.detail);
  }
});

// ---- вкладка "Фон" ----
// isVideoUrl — та же проверка по расширению, что и в web/src/geometry.js —
// своя копия: dm.html не подключает vtt-модуль ради одной функции, сама
// решает, чем показать превью (video vs img).
function isVideoUrl(url) {
  return /\.(mp4|webm|m4v)(\?|#|$)/i.test(url || "");
}
function updateBgPreview() {
  const url = fMapUrl.value.trim();
  bgPreview.style.backgroundImage = "none";
  bgPreview.innerHTML = "";
  if (!url) {
    bgPreview.textContent = "нет фона";
  } else if (isVideoUrl(url)) {
    bgPreview.textContent = "";
    const v = document.createElement("video");
    v.src = url;
    v.muted = true;
    v.loop = true;
    v.autoplay = true;
    v.playsInline = true;
    v.style.cssText = "width:100%;height:100%;object-fit:contain;";
    bgPreview.appendChild(v);
  } else {
    bgPreview.textContent = "";
    bgPreview.style.backgroundImage = `url("${url}")`;
  }
}
fMapUrl.addEventListener("change", updateBgPreview);
fMapUrl.addEventListener("input", updateBgPreview);

function formatSize(bytes) {
  if (!bytes) return "—";
  if (bytes < 1024) return bytes + " Б";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " КБ";
  return (bytes / (1024 * 1024)).toFixed(1) + " МБ";
}
function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function renderAssetTable() {
  const wrap = document.getElementById("assetTableWrap");
  wrap.innerHTML = "";
  for (const a of latestAssets.maps || []) {
    const row = document.createElement("div");
    row.className = "asset-row" + (a.url === fMapUrl.value ? " selected" : "");
    row.innerHTML = `<span class="asset-name">${a.name}</span><span class="asset-meta">${a.ext || ""} · ${formatSize(a.size)} · ${formatDate(a.modTime)}</span>`;
    row.onclick = () => {
      fMapUrl.value = a.url;
      updateBgPreview();
      renderAssetTable();
    };
    wrap.appendChild(row);
  }
}
document.getElementById("bgUpload").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const { url } = await uploadFile(file, "maps");
  fMapUrl.value = url;
  updateBgPreview();
  e.target.value = "";
  await refreshLibrary();
  renderAssetTable();
};

// ---- вкладка "Аудио" ----
function renderAudioAssetTable() {
  const wrap = document.getElementById("audioAssetTableWrap");
  wrap.innerHTML = "";
  for (const a of latestAssets.audio || []) {
    const row = document.createElement("div");
    row.className = "asset-row" + (a.url === fAmbientUrl.value ? " selected" : "");
    row.innerHTML = `<span class="asset-name">${a.name}</span><span class="asset-meta">${a.ext || ""} · ${formatSize(a.size)} · ${formatDate(a.modTime)}</span>`;
    row.onclick = () => {
      fAmbientUrl.value = a.url;
      renderAudioAssetTable();
    };
    wrap.appendChild(row);
  }
}
document.getElementById("ambientUpload").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const { url } = await uploadFile(file, "audio");
  fAmbientUrl.value = url;
  e.target.value = "";
  await refreshLibrary();
  renderAudioAssetTable();
};
fAmbientVolume.oninput = () => {
  fAmbientVolumeLabel.textContent = fAmbientVolume.value + "%";
};

// ---- вкладка "Основное": "Под фон" ----
function loadImageSize(url) {
  return new Promise((resolve, reject) => {
    if (!url) {
      reject(new Error("нет фона"));
      return;
    }
    if (isVideoUrl(url)) {
      const v = document.createElement("video");
      v.onloadedmetadata = () => resolve({ w: v.videoWidth, h: v.videoHeight });
      v.onerror = reject;
      v.src = url;
      return;
    }
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = reject;
    img.src = url;
  });
}
document.getElementById("fitToBgBtn").onclick = async () => {
  try {
    const { w, h } = await loadImageSize(fMapUrl.value.trim());
    fWidth.value = w;
    fHeight.value = h;
  } catch {
    alert("Не удалось прочитать размер фона — проверь URL.");
  }
};

// ---- вкладка "Сетка" ----
fGridColorPicker.oninput = () => {
  fGridColor.value = fGridColorPicker.value;
};
fGridColor.addEventListener("change", () => {
  if (/^#[0-9a-fA-F]{6}$/.test(fGridColor.value)) fGridColorPicker.value = fGridColor.value;
});
fGridOpacity.oninput = () => {
  fGridOpacityLabel.textContent = fGridOpacity.value + "%";
};

gridEditorBtn.onclick = () => {
  closeSidePanel();
  document.dispatchEvent(new CustomEvent("vtt:setTool", { detail: "grid-edit" }));
};

// ---- удаление / сохранение (всегда активная сцена) ----
document.getElementById("sceneDeleteBtn").onclick = () => {
  if (sceneList.length <= 1) return;
  const s = sceneList.find((x) => x.id === currentSceneId);
  if (!confirm(`Удалить сцену «${s ? s.name : currentSceneId}»? Это необратимо.`)) return;
  vtt.send({ type: "delete_scene", sceneId: currentSceneId });
  closeSidePanel();
};

document.getElementById("modalSaveBtn").onclick = () => {
  vtt.send({
    type: "update_scene",
    sceneId: currentSceneId,
    sceneName: fName.value.trim() || "Без названия",
    mapUrl: fMapUrl.value.trim(),
    width: parseFloat(fWidth.value) || 1280,
    height: parseFloat(fHeight.value) || 720,
    fogOfWar: fFogOfWar.checked,
    ambientUrl: fAmbientUrl.value.trim(),
    ambientVolume: (parseFloat(fAmbientVolume.value) || 0) / 100,
    grid: {
      size: parseFloat(fGridSize.value) || 0,
      offsetX: parseFloat(fGridOffX.value) || 0,
      offsetY: parseFloat(fGridOffY.value) || 0,
      visible: fGridVisible.checked,
      unitsPerCell: parseFloat(fUnitsPerCell.value) || 5,
      unit: fUnit.value,
      lineColor: /^#[0-9a-fA-F]{6}$/.test(fGridColor.value) ? fGridColor.value : "#000000",
      lineOpacity: (parseFloat(fGridOpacity.value) || 0) / 100,
    },
  });
  closeSidePanel();
};
