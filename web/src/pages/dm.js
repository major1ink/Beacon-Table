// Перенос inline-скрипта static/dm.html — механически, DOM/HTTP-логика не
// менялась, только глобальные вызовы app.js заменены на импорты, и
// initVTT(...) стал await initVTT(...) (см. vtt/index.js — единственное
// вынужденное отличие от прежнего classic-script вызова).
import { initVTT } from "../vtt/index.js";
import { mapObjectsOf } from "../vtt/map-objects.js";
import { initDiceRoller } from "../dice.js";
import { createRollLog } from "../roll-log.js";
import { openFloatingWindow, postToOpenWindows } from "../floating-window.js";
import { invalidateActionsPeek } from "../combat-actions-peek.js";
import { initCombatPanel } from "../combat-panel.js";
import { setCardOpener } from "../combatant-card.js";
import { openSheetDock } from "../sheet-dock.js";
import { openStatusPalette, refreshStatusPalette } from "../status-palette.js";
import { initShowcaseOverlay } from "../showcase-overlay.js";
import {
  fetchMe,
  apiLogout,
  stopActiveWorld,
  fetchVersion,
  fetchBroadcastLink,
  rotateBroadcastLink,
  fetchServerSettings,
  saveServerSettings,
  fetchBroadcastRequests,
  approveBroadcastRequest,
  rejectBroadcastRequest,
  fetchAssets,
  uploadFile,
  createAssetFolder,
  deleteAssetFolder,
  deleteAsset,
  fetchAdminCharacters,
  updateAdminCharacter,
  fetchAdminPregens,
  createAdminPregen,
  updateAdminPregen,
  assignPregen,
  releasePregen,
  deleteAdminPregen,
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
  fetchJournal,
  fetchMonster,
  fetchFoundryModules,
  checkFoundryModuleUpdates,
  deleteFoundryModule,
} from "../api.js";
import { showAlert, showConfirm, showPrompt, openModal } from "../modal.js";
import { icon } from "../icons.js";
import { initItemPicker } from "../item-picker.js";
import { showLootTakeModal } from "../loot-take-modal.js";
import { mountCompendiumMenu } from "../compendium-menu.js";
import { isGM, isPlayer, isDemoGuest as isDemoRole, roleLabel as accountRoleLabel } from "../roles.js";

// ================= сессия ДМ =================
// /ws/dm, /upload, /assets проверяют cookie сессии на сервере
// (internal/api/http, internal/api/ws). Если сессии нет или роль не admin —
// сразу уводим на страницу входа, до всякой попытки подключиться по WS.
let vtt;
// isDemoGuest — гость публичного демо. Стол ведёт наравне с ДМ, но сервером
// не распоряжается (см. domain.AccountRoleDemo), поэтому кнопки, которые
// всё равно получат 403, ему не показываем: неработающая кнопка хуже, чем
// её отсутствие.
let isDemoGuest = false;
(async function boot() {
  const me = await fetchMe();
  if (!me || !isGM(me.role)) {
    location.href = "/";
    return;
  }
  isDemoGuest = isDemoRole(me.role);
  if (isDemoGuest) hideOwnerOnlyUI();
  document.getElementById("dmUsername").textContent = me.username;
  // Всё остальное в этом файле — обычные top-level обработчики
  // (onclick/addEventListener), выполняются один раз при загрузке страницы
  // и лишь ССЫЛАЮТСЯ на vtt внутри колбэков — к моменту, когда пользователь
  // реально на что-то нажмёт, boot() уже успеет отработать.
  vtt = await initVTT({ canvasId: "scene", role: "dm" });
  // Плейлист двигает вперёд сам клиент ДМ (см. handleCueEnded ниже) —
  // vtt.cueAudio появляется только сейчас, поэтому слушатель вешаем здесь.
  vtt.cueAudio.addEventListener("ended", handleCueEnded);
  // Прогресс-бар "сейчас играет" (см. updateCueProgress) — та же логика:
  // vtt.cueAudio существует только с этого момента.
  vtt.cueAudio.addEventListener("timeupdate", updateCueProgress);
  // Кубы — отдельная иконка 🎲 в той же боковой колонке, что и 🔊 громкость
  // (см. vtt/side-menu.js — vtt.sideMenu тоже появляется только теперь).
  // Сама панель — только лоток (кнопки-счётчики кубиков, модификатор, поле
  // формулы, "Бросить", см. dice.js); лог результатов — отдельный виджет
  // (roll-log.js) в плашке #diceLog сверху канваса (см. dm.html).
  const dicePanel = vtt.sideMenu.addIcon(icon("dice", { size: 16 }), "Кубы", { width: 240 });
  const diceControls = document.createElement("div");
  diceControls.className = "dice-controls-menu";
  dicePanel.appendChild(diceControls);
  initDiceRoller(diceControls, (msg) => vtt.send(msg));
  const rollLog = createRollLog(document.getElementById("diceLog"), { layout: "plate" });
  document.addEventListener("vtt:rollResult", (e) => rollLog.push(e.detail));
  // Справочник — та же боковая колонка, следующая иконка после кубов (см.
  // compendium-menu.js: дерево категорий, само содержимое — отдельные
  // плавающие окна web/catalog.html). sticky — не закрывается кликом мимо
  // (пользователь кликает по только что открытым спискам/карточкам, это не
  // "мимо"), только своей кнопкой ✕ в шапке.
  const compendiumPanel = vtt.sideMenu.addIcon(icon("book-open", { size: 16 }), "Справочник", { width: 320, sticky: true });
  // canImport: гостю демо импорт закрыт на сервере (requireOwner), значит
  // и пункт меню ему показывать незачем.
  mountCompendiumMenu(compendiumPanel, { role: "dm", canImport: !isDemoGuest });
  // Оверлей «Показать игрокам» — на экране ДМ это предпросмотр того, что
  // видят игроки, плюс кнопка «✕» (шлёт hide_image всем, см.
  // web/src/showcase-overlay.js). Раздел рейла «Показ» — ниже по файлу.
  initShowcaseOverlay({ role: "dm", send: (m) => vtt.send(m) });
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
// Журнал стола — плавающее окно, а не панель рейла: в него пишут и игроки
// (см. web/journal.html), у них он открывается ровно тем же окном из
// бокового меню (pages/player.js), и держать две реализации одного журнала
// незачем.
// openJournalWindow — окно журнала одно на весь стол (key "journal", как и
// у игрока, см. pages/player.js): entryId открывает его сразу на нужной
// записи — так работают и значок журнала на карте, и ссылки внутри текстов.
function openJournalWindow(entryId, section) {
  openFloatingWindow({
    key: "journal",
    title: "Журнал стола",
    url:
      "/journal.html" +
      (entryId ? "?id=" + encodeURIComponent(entryId) : "") +
      (entryId && section ? "#" + encodeURIComponent(section) : ""),
    navigate: !!entryId,
    width: 900,
    height: 640,
    popoutFeatures: "width=900,height=640",
  });
}

document.getElementById("journalBtn").onclick = () => openJournalWindow();

// hideOwnerOnlyUI — убрать со стола то, что доступно только хозяину сервера:
// список миров, вкладки «Трансляция» и «Сервер» в настройках. Права на
// сервере проверяет он сам (см. requireOwner), здесь — только внешний вид.
function hideOwnerOnlyUI() {
  document.getElementById("worldsBtn")?.remove();
  // «Модули» тоже: список пакетов и импорт — за requireOwner, гость увидел
  // бы пустую вкладку с ошибкой.
  for (const tab of ["cast", "server", "modules"]) {
    document.querySelector(`.set-tabs [data-settab="${tab}"]`)?.remove();
    document.querySelector(`[data-settab-panel="${tab}"]`)?.remove();
  }
}

// worldsBtn — уйти со стола в список миров. Явно гасим мир (stopActiveWorld):
// стол закрывается, игроки отключаются, рестарт сервера не поднимет мир сам —
// ДМ вернётся и выберет мир заново. Единственное место, где стол снимается;
// сам заход на worlds.html его не трогает.
document.getElementById("worldsBtn")?.addEventListener("click", async () => {
  if (!(await showConfirm("Выйти в список миров? Стол закроется, игроки отключатся.", { title: "К мирам", okLabel: "Выйти" }))) return;
  await stopActiveWorld().catch(() => {});
  location.href = "/worlds.html";
});

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
// только у аудио-треков, см. openTrackModal ниже — токен-арт ушёл в
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

let latestAssets = { maps: [], tokens: [], audio: [], props: [], handouts: [], folders: {} };
async function refreshLibrary() {
  try {
    latestAssets = await fetchAssets();
    if (bgTab.classList.contains("active")) renderAssetTable();
    if (audioTab.classList.contains("active")) renderAudioAssetTable();
    if (assetsPanelSection.classList.contains("active")) renderAssetsGrid();
    if (showcasePanelSection.classList.contains("active")) renderShowcaseGrid();
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
const assetsStorage = document.getElementById("assetsStorage");
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

// formatBytes — размер по-человечески, теми же словами, что сервер пишет в
// сообщении об отказе (см. internal/quota: FormatSize).
function formatBytes(n) {
  if (!n || n <= 0) return "0 Б";
  if (n < 1024) return n + " Б";
  if (n < 1024 * 1024) return Math.round(n / 1024) + " КБ";
  if (n < 1024 * 1024 * 1024) return Math.round(n / (1024 * 1024)) + " МБ";
  return (n / (1024 * 1024 * 1024)).toFixed(1) + " ГБ";
}

// renderAssetsStorage — строка «занято X из Y». Показывается, только если
// квота задана на сервере (см. BEACON_UPLOADS_QUOTA): без неё цифра ничего
// не значит и только мешала бы.
function renderAssetsStorage() {
  const storage = latestAssets.storage;
  if (!storage) {
    assetsStorage.textContent = "";
    assetsStorage.className = "assets-storage";
    return;
  }
  // Показываем тот предел, к которому ближе: упрёмся мы именно в него.
  const world = storage.worldLimit > 0 ? storage.worldUsed / storage.worldLimit : 0;
  const total = storage.totalLimit > 0 ? storage.totalUsed / storage.totalLimit : 0;
  const worldIsTighter = world >= total;
  const used = worldIsTighter ? storage.worldUsed : storage.totalUsed;
  const limit = worldIsTighter ? storage.worldLimit : storage.totalLimit;
  const share = worldIsTighter ? world : total;

  assetsStorage.textContent =
    `Занято ${formatBytes(used)} из ${formatBytes(limit)}` + (worldIsTighter ? " (этот мир)" : " (весь сервер)");
  assetsStorage.className =
    "assets-storage" + (share >= 0.95 ? " full" : share >= 0.8 ? " low" : "");
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
  renderAssetsStorage();
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
      if (!(await showConfirm(`Удалить папку «${assetFolderName(f.path)}» со всем содержимым?`, { title: "Удалить папку", okLabel: "Удалить", danger: true }))) return;
      try {
        await deleteAssetFolder(ASSET_KIND, f.path);
        await refreshLibrary();
        renderAssetsGrid();
      } catch (err) {
        showAlert("Не удалось удалить папку: " + err.message);
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
      if (!(await showConfirm(`Удалить «${a.name}» из библиотеки?`, { title: "Удалить файл", okLabel: "Удалить", danger: true }))) return;
      try {
        await deleteAsset(ASSET_KIND, a.url);
        await refreshLibrary();
        renderAssetsGrid();
      } catch (err) {
        showAlert("Не удалось удалить ассет: " + err.message);
      }
    };
    tile.appendChild(delBtn);
    assetsGrid.appendChild(tile);
  }
}
onPanelOpen("assets", renderAssetsGrid);

document.getElementById("assetsNewFolderBtn").onclick = async () => {
  const name = await showPrompt("Название папки:", { title: "Новая папка", okLabel: "Создать" });
  if (!name || !name.trim()) return;
  const path = (currentAssetFolder ? currentAssetFolder + "/" : "") + name.trim();
  try {
    await createAssetFolder(ASSET_KIND, path);
    await refreshLibrary();
    renderAssetsGrid();
  } catch (err) {
    showAlert("Не удалось создать папку: " + err.message);
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
    showAlert("Не удалось загрузить файл: " + err.message);
  } finally {
    e.target.value = "";
    await refreshLibrary();
    renderAssetsGrid();
  }
};

// ================= раздел "Показ игрокам" =================
// Своя библиотека картинок (domain.AssetKindHandouts = "handouts"), отдельная
// от декораций карты ("props") и токен-арта ("tokens") — это хендауты
// (портрет NPC, письмо, символ). Клик по плитке выводит картинку «поверх
// всего» на экраны игроков и трансляции (WS "show_image" → r.showcase →
// broadcastShowcase, см. internal/service/room.go; сам оверлей —
// web/src/showcase-overlay.js). Состояние эфемерно, как канал ДМ: сервер его
// не сохраняет на диск, но досылает свежеподключившимся.
const HANDOUT_KIND = "handouts";
const showcasePanelSection = document.querySelector('.panel-section[data-panel="showcase"]');
const showcaseGrid = document.getElementById("showcaseGrid");
const showcaseNowEl = document.getElementById("showcaseNow");
// latestShowcase — URL сейчас показываемой картинки ("" — ничего). Держим
// синхронно из того же события vtt:showcase, что слушает и оверлей: сервер —
// единственный источник правды, кнопки только шлют show_image/hide_image.
let latestShowcase = "";
document.addEventListener("vtt:showcase", (e) => {
  latestShowcase = (e.detail && e.detail.url) || "";
  if (showcasePanelSection.classList.contains("active")) {
    renderShowcaseNow();
    renderShowcaseGrid();
  }
});

function showImage(url) {
  vtt.send({ type: "show_image", imageUrl: url });
}
function hideImage() {
  vtt.send({ type: "hide_image" });
}

function renderShowcaseNow() {
  showcaseNowEl.innerHTML = "";
  if (!latestShowcase) {
    showcaseNowEl.className = "showcase-now empty";
    showcaseNowEl.textContent = "Сейчас ничего не показывается";
    return;
  }
  showcaseNowEl.className = "showcase-now";
  const thumb = document.createElement("div");
  thumb.className = "showcase-now-thumb";
  thumb.style.backgroundImage = `url("${latestShowcase}")`;
  const body = document.createElement("div");
  body.className = "showcase-now-body";
  const title = document.createElement("div");
  title.textContent = "На экране у игроков";
  const nameEl = document.createElement("div");
  nameEl.className = "showcase-now-name";
  nameEl.textContent = decodeURIComponent(latestShowcase.split("/").pop() || "").replace(/^\d+-/, "");
  body.append(title, nameEl);
  const off = document.createElement("button");
  off.type = "button";
  off.className = "danger";
  off.textContent = "Убрать с экрана";
  off.onclick = hideImage;
  showcaseNowEl.append(thumb, body, off);
}

function renderShowcaseGrid() {
  const files = (latestAssets[HANDOUT_KIND] || []).filter((a) => !isVideoUrl(a.url));
  showcaseGrid.innerHTML = "";
  if (files.length === 0) {
    const empty = document.createElement("div");
    empty.className = "assets-empty-hint";
    empty.textContent = "Пока пусто — загрузи картинку выше.";
    showcaseGrid.appendChild(empty);
    return;
  }
  for (const a of files) {
    const tile = document.createElement("div");
    tile.className = "asset-tile item-tile";
    if (a.url === latestShowcase) tile.classList.add("showing");
    tile.title = a.url === latestShowcase ? "Снять с экрана игроков" : "Показать на экране игроков и трансляции";
    tile.style.backgroundImage = `url("${a.url}")`;
    tile.onclick = () => (a.url === latestShowcase ? hideImage() : showImage(a.url));
    const name = document.createElement("span");
    name.className = "asset-tile-name";
    name.textContent = a.name;
    tile.appendChild(name);
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "asset-tile-del";
    delBtn.title = "Удалить из библиотеки";
    delBtn.innerHTML = icon("trash", { size: 12 });
    delBtn.onclick = async (e) => {
      e.stopPropagation();
      if (!(await showConfirm(`Удалить «${a.name}» из библиотеки показа?`, { title: "Удалить файл", okLabel: "Удалить", danger: true }))) return;
      try {
        if (a.url === latestShowcase) hideImage();
        await deleteAsset(HANDOUT_KIND, a.url);
        await refreshLibrary();
        renderShowcaseGrid();
      } catch (err) {
        showAlert("Не удалось удалить: " + err.message);
      }
    };
    tile.appendChild(delBtn);
    showcaseGrid.appendChild(tile);
  }
}

onPanelOpen("showcase", () => {
  renderShowcaseNow();
  renderShowcaseGrid();
  refreshLibrary();
});

document.getElementById("showcaseUpload").onchange = async (e) => {
  const files = [...e.target.files];
  if (files.length === 0) return;
  try {
    for (const file of files) {
      await uploadFile(file, HANDOUT_KIND);
    }
  } catch (err) {
    showAlert("Не удалось загрузить файл: " + err.message);
  } finally {
    e.target.value = "";
    await refreshLibrary();
    renderShowcaseGrid();
  }
};

// ================= зум =================
document.getElementById("zoomInBtn").onclick = () => document.dispatchEvent(new CustomEvent("vtt:zoomBy", { detail: 1.3 }));
document.getElementById("zoomOutBtn").onclick = () => document.dispatchEvent(new CustomEvent("vtt:zoomBy", { detail: 1 / 1.3 }));
document.getElementById("zoomResetBtn").onclick = () => document.dispatchEvent(new CustomEvent("vtt:resetView"));

// ================= единый инструмент: Стены / Здание / Туман =================
const wallBtn = document.getElementById("wallBtn");
const buildingBtn = document.getElementById("buildingBtn");
const fogBtn = document.getElementById("fogBtn");
const rulerBtn = document.getElementById("rulerBtn");

function toggleTool(name) {
  const current = document.querySelector("[data-tool].active");
  const next = current && current.dataset.tool === name ? "select" : name;
  document.dispatchEvent(new CustomEvent("vtt:setTool", { detail: next }));
}
wallBtn.dataset.tool = "wall";
buildingBtn.dataset.tool = "building";
fogBtn.dataset.tool = "fog";
rulerBtn.dataset.tool = "ruler";
wallBtn.onclick = () => toggleTool("wall");
buildingBtn.onclick = () => toggleTool("building");
fogBtn.onclick = () => toggleTool("fog");
rulerBtn.onclick = () => toggleTool("ruler");

const gridEditDone = document.getElementById("gridEditDone");
document.addEventListener("vtt:toolChanged", (e) => {
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
  showSidePanelSection("sceneSettings"); // вернуться в раздел с уже актуальными offsetX/Y
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
const tokenMenuMultiHeader = document.getElementById("tokenMenuMultiHeader");
const tokenMenuMultiHeaderText = document.getElementById("tokenMenuMultiHeaderText");
const tokenMenuSheetBtn = document.getElementById("tokenMenuSheetBtn");
const tokenMenuBestiaryBtn = document.getElementById("tokenMenuBestiaryBtn");
const tokenMenuAddInitiativeBtn = document.getElementById("tokenMenuAddInitiativeBtn");
const tokenMenuLootBtn = document.getElementById("tokenMenuLootBtn");
const tokenMenuHiddenRow = document.getElementById("tokenMenuHiddenRow");
const tokenMenuShapeRow = document.getElementById("tokenMenuShapeRow");
const tokenMenuOwnerRow = document.getElementById("tokenMenuOwnerRow");
const tokenMenuOwner = document.getElementById("tokenMenuOwner");
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
const tokenMenuCopyBtn = document.getElementById("tokenMenuCopyBtn");
const tokenMenuLockBtn = document.getElementById("tokenMenuLockBtn");
const tokenMenuLockLabel = document.getElementById("tokenMenuLockLabel");
const tokenMenuDelete = document.getElementById("tokenMenuDelete");
// menuCombatTokenIds — множество tokenId, у которых уже есть боец в трекере
// инициативы (см. domain.Combatant.TokenID) — синкается с каждым
// "combat_state" (см. vtt:combatState ниже). Нужно только чтобы погасить
// "Добавить в инициативу" у токена, который туда уже добавлен: повторный клик
// заводил бы ВТОРОГО бойца с тем же TokenID — токен на карте один, вытащить
// для дубля новый уже неоткуда (см. room.go: handleAddCombatant).
let menuCombatTokenIds = new Set();
document.addEventListener("vtt:combatState", (e) => {
  const combatants = (e.detail && e.detail.combatants) || [];
  menuCombatTokenIds = new Set(combatants.filter((c) => c.tokenId).map((c) => c.tokenId));
});
let menuTokenId = null;
// menuTokenIds — все id токенов, к которым применится действие в ОТКРЫТОМ
// СЕЙЧАС меню: обычно [menuTokenId], но при ПКМ по токену, входящему в
// групповое выделение (interaction.js: contextmenu, поле ids в detail
// vtt:tokenContextMenu), сюда попадает весь состав выделения — тогда меню
// сокращается до пачечных действий (см. vtt:tokenContextMenu ниже).
let menuTokenIds = [];
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
// menuTokenLocked — заперт ли токен в ОТКРЫТОМ СЕЙЧАС меню (см.
// domain.Token.Locked и web/src/vtt/map-objects.js). Меню запертого токена
// открывается как обычно — иначе замок было бы нечем снять, — но всё, что
// его правит, в нём гасится (класс .locked-disabled, см. web/dm.html).
let menuTokenLocked = false;
// menuTokenLoot — снимок Token.Loot (см. domain.InventoryEntry) токена в
// открытом сейчас меню — "Лутить" виден, только если тут реально есть что
// разобрать (token.dead && loot.length), см. handler ниже.
let menuTokenLoot = [];

function closeTokenMenu() {
  tokenMenu.style.display = "none";
  menuTokenId = null;
  menuTokenIds = [];
  menuTokenLocked = false;
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
  closeCanvasMenu();
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
const fogAreaMenuLockBtn = document.getElementById("fogAreaMenuLockBtn");
const fogAreaMenuLockLabel = document.getElementById("fogAreaMenuLockLabel");
let menuFogAreaId = null;

function closeFogAreaMenu() {
  fogAreaMenu.style.display = "none";
  menuFogAreaId = null;
}

document.addEventListener("vtt:fogAreaContextMenu", (e) => {
  closeCanvasMenu();
  closeTokenMenu();
  closeWallPointMenu();
  closeNoteMarkerMenu();
  closeWallMenu();
  closeBuildingMenu();
  menuFogAreaId = e.detail.id;
  wireMapObjectLock("fogArea", menuFogAreaId, fogAreaMenuLockBtn, fogAreaMenuLockLabel, [fogAreaMenuDelete], closeFogAreaMenu);
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
  closeCanvasMenu();
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
const buildingMenuLockBtn = document.getElementById("buildingMenuLockBtn");
const buildingMenuLockLabel = document.getElementById("buildingMenuLockLabel");
let menuBuildingId = null;

function closeBuildingMenu() {
  buildingMenu.style.display = "none";
  menuBuildingId = null;
}

document.addEventListener("vtt:buildingContextMenu", (e) => {
  closeCanvasMenu();
  closeTokenMenu();
  closeWallPointMenu();
  closeNoteMarkerMenu();
  closeFogAreaMenu();
  closeWallMenu();
  menuBuildingId = e.detail.id;
  wireMapObjectLock("building", menuBuildingId, buildingMenuLockBtn, buildingMenuLockLabel, [buildingMenuDelete], closeBuildingMenu);
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
const noteMarkerMenuLockBtn = document.getElementById("noteMarkerMenuLockBtn");
const noteMarkerMenuLockLabel = document.getElementById("noteMarkerMenuLockLabel");
let menuNoteMarkerId = null;

function closeNoteMarkerMenu() {
  noteMarkerMenu.style.display = "none";
  menuNoteMarkerId = null;
}

document.addEventListener("vtt:noteMarkerContextMenu", (e) => {
  closeCanvasMenu();
  closeTokenMenu();
  closeWallPointMenu();
  closeFogAreaMenu();
  closeWallMenu();
  closeBuildingMenu();
  menuNoteMarkerId = e.detail.id;
  wireMapObjectLock(
    "noteMarker",
    menuNoteMarkerId,
    noteMarkerMenuLockBtn,
    noteMarkerMenuLockLabel,
    [noteMarkerResizeBtn, noteMarkerDeleteBtn],
    closeNoteMarkerMenu
  );
  noteMarkerMenu.style.left = e.detail.pageX + "px";
  noteMarkerMenu.style.top = e.detail.pageY + "px";
  noteMarkerMenu.style.display = "flex";
});

noteMarkerResizeBtn.onclick = () => {
  if (!menuNoteMarkerId) return;
  document.dispatchEvent(new CustomEvent("vtt:armNoteMarkerResize", { detail: { id: menuNoteMarkerId } }));
  closeNoteMarkerMenu();
  showAlert("Теперь потяни от значка на карте — дальше от него он растёт, ближе — уменьшается.", { title: "Размер значка" });
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
  closeCanvasMenu();
  closeWallPointMenu();
  closeNoteMarkerMenu();
  closeFogAreaMenu();
  closeWallMenu();
  closeBuildingMenu();
  const { id, token, ids, pageX, pageY } = e.detail;
  menuTokenId = id;
  menuTokenIds = Array.isArray(ids) && ids.length ? ids : [id];
  // Пачечный режим — ПКМ пришёлся по одному из группового выделения (см.
  // interaction.js: contextmenu). Меню сокращается до действий, осмысленных
  // сразу для НЕСКОЛЬКИХ токенов (инициатива/состояния/свет/удаление, см.
  // требование "нельзя добавить в инициативу всю пачку разом") — лист
  // персонажа, статблок, лут, форма и замок остаются штучными: они не имеют
  // единого смысла для разнородной группы.
  const menuIsMulti = menuTokenIds.length > 1;
  menuCharacterId = token.characterId || "";
  menuCharacterLabel = token.label || "";
  menuMonsterId = token.monsterId || "";
  menuIsLightOnly = !menuIsMulti && !!token.lightOnly;
  tokenMenuMultiHeaderText.textContent = `выбрано токенов: ${menuTokenIds.length}`;
  tokenMenuMultiHeader.style.display = menuIsMulti ? "flex" : "none";
  tokenMenuLightHeader.style.display = menuIsLightOnly ? "flex" : "none";
  // редактировать карточку персонажа прямо из его токена, не только
  // из панели "Персонажи". У токена света персонажа не бывает (см.
  // domain.Token.LightOnly), поэтому эта кнопка с ним не пересекается.
  tokenMenuSheetBtn.style.display = !menuIsMulti && menuCharacterId ? "flex" : "none";
  // тот же приём для монстров бестиария (см. domain.Token.MonsterID) —
  // токены персонажей и монстров не пересекаются (характер и бестиарий не
  // ставятся на один токен), поэтому оба флага независимы.
  tokenMenuBestiaryBtn.style.display = !menuIsMulti && menuMonsterId ? "flex" : "none";
  // "Добавить в инициативу" — у токена света своего "хода" не бывает (см.
  // domain.Token.LightOnly), в остальном доступно любому существу — и
  // игрока, и монстра, и голому NPC-токену без карточки бестиария/листа. У
  // УЖЕ убитого монстра (token.dead) кнопки тоже нет — вернуть его в бой
  // можно только через "Восстановить" на вкладке "Убитые" трекера
  // (см. combat-panel.js), а не заново нахватать ему полного HP шаблона
  // случайным ПКМ. У токена, УЖЕ привязанного к бойцу трекера
  // (menuCombatTokenIds), кнопки тоже нет — иначе повторный клик заводил бы
  // второго бойца с тем же TokenID без своего токена на карте (баг,
  // см. handleAddCombatant). В пачечном режиме кнопку не гасим по одному
  // токену под курсором — сами обработчики ниже молча пропускают
  // токены-лампочки, убитых и уже добавленных внутри группы.
  tokenMenuAddInitiativeBtn.style.display =
    menuIsMulti || (!menuIsLightOnly && !token.dead && !menuCombatTokenIds.has(id)) ? "flex" : "none";
  // "Состояния" — по тому же признаку, что и инициатива: у токена-лампочки
  // (domain.Token.LightOnly) состояний не бывает, он не существо.
  tokenMenuStatusBtn.style.display = menuIsMulti || !menuIsLightOnly ? "flex" : "none";
  // "Лутить" — только у мёртвого токена (кости, см. domain.Token.Dead) с
  // непустым Loot; тумблер CombatState.LootingEnabled тут не проверяем — он
  // ограничивает только ИГРОКОВ (см. authorize в room.go), ДМ раздаёт лут
  // вручную в любой момент. Штучное действие — в пачке трупы лутаются по
  // одному, разбор общего лута сразу нескольких тел не заказывали.
  menuTokenLoot = !menuIsMulti && Array.isArray(token.loot) ? token.loot : [];
  tokenMenuLootBtn.style.display = !menuIsMulti && token.dead && menuTokenLoot.length ? "flex" : "none";
  tokenMenuHiddenRow.style.display = !menuIsMulti && !menuIsLightOnly ? "flex" : "none";
  tokenMenuShapeRow.style.display = !menuIsMulti && !menuIsLightOnly ? "flex" : "none";
  // "Владелец" — привязать существующий токен к персонажу игрока задним
  // числом (единственный путь после импорта мира, где персонажа надо было бы
  // заново перетащить из панели). Не для токенов-лампочек и декораций.
  const canOwn = !menuIsMulti && !menuIsLightOnly && !token.decor;
  tokenMenuOwnerRow.style.display = canOwn ? "flex" : "none";
  if (canOwn) fillTokenOwnerSelect(id, token);
  tokenMenuLightRow.style.display = menuIsLightOnly ? "none" : "flex";
  tokenMenuLightToggleBtn.style.display = menuIsLightOnly ? "flex" : "none";
  // У токена персонажа игрока свет — это не "токен-лампочка", а факел/фонарь
  // у него в руках, поэтому формулировка чекбокса другая (сама механика
  // радиусов ниже та же самая, см. TokenLight). В пачке настройки не читаем
  // ни с одного конкретного токена (у каждого могут быть свои) — чекбокс
  // всегда стартует выключенным, чтобы случайно не залить всем чужой свет;
  // включили — одинаковые ярк./тускл. уйдут сразу всем выделенным, а
  // поправить каждого по отдельности можно потом обычным одиночным меню.
  tokenMenuLightLabel.textContent = menuIsMulti ? "источник света — всем выделенным" : menuCharacterId ? "Держит факел" : "источник света";

  tokenMenuLightBright.value = menuIsMulti ? 0 : (token.light && token.light.bright) || 0;
  tokenMenuLightDim.value = menuIsMulti ? 0 : (token.light && token.light.dim) || 0;

  if (menuIsMulti) {
    tokenMenuLight.checked = false;
    syncLightFieldsVisibility(tokenMenuLight, tokenMenuLightBrightField, tokenMenuLightDimField);
  } else if (menuIsLightOnly) {
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

  // "Копировать" — снимок токена вставляется ПКМ по пустому месту карты
  // (см. #canvasMenu). Кроме токена света годится для любого существа/
  // декорации — быстро наплодить одинаковых монстров на карте, не таская
  // каждый раз новую карточку из бестиария. Токен ИГРОКА (menuCharacterId)
  // из этого исключён: у персонажа на сцене может быть только один токен
  // (см. room.go: dropDuplicateCharacterTokens) — паста с тем же
  // characterId тихо снесла бы оригинал, а не завела вторую фигурку.
  tokenMenuCopyBtn.style.display = !menuIsMulti && (menuIsLightOnly || !menuCharacterId) ? "flex" : "none";

  // Замок — универсальный для всех объектов карты (см. map-objects.js):
  // здесь он на токене, тем же событием vtt:setMapObjectLocked его получат
  // значки заметок, здания и фигуры тумана.
  //
  // Но НЕ на фигурках существ: у них запирать нечего — они ходят каждый
  // ход, это и есть их работа на карте, а замок там только лишний пункт в
  // меню и способ случайно обездвижить бойца посреди боя. Замок нужен
  // ровно противоположному — РАЗМЕТКЕ карты: источникам света, декорациям
  // из ассетов, значкам, зданиям, фигурам тумана; они стоят на тех же
  // координатах, что и существа, и именно их промах мышью утаскивает.
  //
  // Признак ПОЛОЖИТЕЛЬНЫЙ ("это обстановка"), а не отрицательный ("нет
  // characterId и monsterId"), и это принципиально: у токенов, приехавших
  // вместе со сценой из Foundry, никаких id нет (см.
  // internal/foundry/scene.go: mapToken переносит только имя, арт и
  // размер), но это существа — и отрицательный признак предлагал бы для
  // гоблина-воителя замок наравне с бочкой.
  //
  // Единственное исключение — токен, который УЖЕ заперт: кнопку
  // показываем в любом случае, иначе запертое до появления этого правила
  // нечем было бы освободить.
  // Штучное действие — замок группе целиком не имеет смысла (это про одно
  // конкретное место на карте), поэтому в пачечном режиме просто прячем.
  const menuIsMapDecor = !menuIsMulti && (menuIsLightOnly || !!token.decor);
  menuTokenLocked = !menuIsMulti && !!token.locked;
  tokenMenuLockBtn.style.display = !menuIsMulti && (menuIsMapDecor || menuTokenLocked) ? "flex" : "none";
  tokenMenuLockLabel.textContent = menuTokenLocked ? "Разблокировать" : "Заблокировать";
  applyTokenMenuLockState();

  tokenMenu.style.left = pageX + "px";
  tokenMenu.style.top = pageY + "px";
  tokenMenu.style.display = "block";
});

// applyTokenMenuLockState — гасит в открытом меню всё, что правит запертый
// токен. Список исключений короткий и осознанный: сама кнопка замка (иначе
// его не снять) и чисто читающие пункты (лист персонажа/статблок) —
// посмотреть, ЧТО именно заперто, замок мешать не должен.
function applyTokenMenuLockState() {
  const editable = [
    tokenMenuAddInitiativeBtn,
    tokenMenuStatusBtn,
    tokenMenuLootBtn,
    tokenMenuHiddenRow,
    tokenMenuShapeRow,
    tokenMenuLightRow,
    tokenMenuLightBrightField,
    tokenMenuLightDimField,
    tokenMenuLightToggleBtn,
    tokenMenuCopyBtn,
    tokenMenuDelete,
  ];
  for (const el of editable) el.classList.toggle("locked-disabled", menuTokenLocked);
}

tokenMenuLockBtn.onclick = () => {
  if (!menuTokenId) return;
  document.dispatchEvent(
    new CustomEvent("vtt:setMapObjectLocked", { detail: { kind: "token", id: menuTokenId, locked: !menuTokenLocked } })
  );
  closeTokenMenu();
};

// wireMapObjectLock — одна и та же обвязка кнопки замка для меню значка
// заметки, фигуры тумана и здания (у токена свой вариант выше — там кнопок
// и режимов больше). Текущий флаг читается из ЖИВОЙ сцены, а не из detail
// события: меню держат открытым, а сцена за это время приходит с сервера
// ещё много раз. editable — что погасить, пока объект заперт (сама кнопка
// замка в список, разумеется, не входит).
function wireMapObjectLock(kind, id, btn, label, editable, close) {
  const obj = mapObjectsOf(vtt.getScene(), kind)[id];
  const locked = !!(obj && obj.locked);
  label.textContent = locked ? "Разблокировать" : "Заблокировать";
  for (const el of editable) el.classList.toggle("locked-disabled", locked);
  btn.onclick = () => {
    document.dispatchEvent(new CustomEvent("vtt:setMapObjectLocked", { detail: { kind, id, locked: !locked } }));
    close();
  };
}

// ================= буфер обмена объектов карты =================
// mapClipboard — {kind, object} последнего скопированного объекта карты (см.
// map-objects.js: MAP_OBJECT_KINDS). Живёт только в этой вкладке ДМ и только
// до перезагрузки — это буфер обмена, а не состояние стола, серверу о нём
// знать незачем. Хранится СНИМОК объекта, а не его id: вставить копию
// удалённого с тех пор источника — нормально и ожидаемо.
let mapClipboard = null;
const canvasMenu = document.getElementById("canvasMenu");
const canvasMenuPasteBtn = document.getElementById("canvasMenuPasteBtn");
const canvasMenuPasteLabel = document.getElementById("canvasMenuPasteLabel");
let canvasMenuAt = null; // мировые координаты ПКМ — точка вставки

function closeCanvasMenu() {
  canvasMenu.style.display = "none";
  canvasMenuAt = null;
}

// fillTokenOwnerSelect — наполняет <select> "Владелец" персонажами мира
// (GET /api/admin/characters). dmCharacters — общий кэш с панелью "Персонажи";
// панель мог не открываться, поэтому дозапрашиваем и переотрисовываем, если
// меню ещё висит на том же токене.
function fillTokenOwnerSelect(id, token) {
  const build = () => {
    if (menuTokenId !== id || tokenMenu.style.display === "none") return;
    const cur = token.characterId || "";
    tokenMenuOwner.textContent = "";
    tokenMenuOwner.add(new Option("— никто —", ""));
    let matched = false;
    for (const c of dmCharacters) {
      const label = c.accountUsername ? `${c.name} (${c.accountUsername})` : c.name;
      tokenMenuOwner.add(new Option(label, c.id, false, c.id === cur));
      if (c.id === cur) matched = true;
    }
    if (!matched && (cur || token.ownerId)) {
      const ghost = new Option("владелец не в этом мире", "__keep__", false, true);
      ghost.disabled = true;
      tokenMenuOwner.add(ghost);
    }
  };
  build();
  fetchAdminCharacters()
    .then((list) => {
      dmCharacters = list;
      build();
    })
    .catch(() => {});
}

// sendTokenOwner — переназначить владельца существующего токена. Сервер
// апсертит токен по id (move_token, только ДМ — см. room.go applyMutation).
function sendTokenOwner(id, charId) {
  if (charId === "__keep__") return; // "владелец не в этом мире" — не трогаем
  const t = (vtt.getScene().tokens || {})[id];
  if (!t) return;
  let patch;
  if (!charId) {
    patch = { ownerId: "", characterId: "" };
  } else {
    const c = dmCharacters.find((x) => x.id === charId);
    if (!c) return;
    // назначение characterId, уже стоящего на карте другим токеном, снесёт
    // тот токен (room.go: dropDuplicateCharacterTokens) — у персонажа один
    // токен на сцене.
    patch = { ownerId: c.accountId, characterId: c.id };
  }
  vtt.send({ type: "move_token", token: { ...t, ...patch } });
}

tokenMenuOwner.onchange = () => {
  if (menuTokenId) sendTokenOwner(menuTokenId, tokenMenuOwner.value);
};

tokenMenuCopyBtn.onclick = () => {
  if (!menuTokenId) return;
  const t = (vtt.getScene().tokens || {})[menuTokenId];
  if (!t) return;
  // Копию берём из ЖИВОЙ сцены, а не из снимка, с которым открывали меню:
  // пока меню висело, свет могли переключить двойным кликом или из списка
  // в панели "Освещение".
  //
  // dead/loot/xp/statuses сбрасываем явно — это боевые шрамы КОНКРЕТНОГО
  // инстанса (см. domain.Token), а копия нужна как раз чтобы поставить на
  // карту НОВОГО, ещё не участвовавшего в бою монстра. Без сброса паста с
  // мёртвого гоблина ставила бы на карту готовый труп с чужим лутом.
  mapClipboard = { kind: "token", object: { ...t, dead: false, loot: [], xp: 0, statuses: [] } };
  closeTokenMenu();
};

// ПКМ по пустому месту карты (см. interaction.js: vtt:canvasContextMenu) —
// меню появляется, только если есть что вставлять: пустое меню на каждый
// промах мимо токена раздражало бы сильнее, чем помогало.
document.addEventListener("vtt:canvasContextMenu", (e) => {
  closeTokenMenu();
  closeWallPointMenu();
  closeNoteMarkerMenu();
  closeFogAreaMenu();
  closeWallMenu();
  closeBuildingMenu();
  if (!mapClipboard) return;
  canvasMenuAt = { x: e.detail.x, y: e.detail.y };
  canvasMenuPasteLabel.textContent = "Вставить: " + (mapClipboard.object.label || "объект");
  canvasMenu.style.left = e.detail.pageX + "px";
  canvasMenu.style.top = e.detail.pageY + "px";
  canvasMenu.style.display = "block";
});

canvasMenuPasteBtn.onclick = () => {
  if (!mapClipboard || !canvasMenuAt) return;
  const src = mapClipboard.object;
  counter++;
  // Свой id и координаты точки вставки; замок копия НЕ наследует — вставили
  // затем, чтобы поставить куда надо, а запертое сразу не поставишь.
  const object = { ...src, id: "tok-" + Date.now() + "-" + counter, x: canvasMenuAt.x, y: canvasMenuAt.y, locked: false };
  vtt.send({ type: "add_token", token: object });
  closeCanvasMenu();
};

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

// "Добавить в инициативу" — при пачечном выделении шлёт add_combatant по
// одному сообщению на каждый токен (батч-команды сервер не знает, см.
// room.go: handleAddCombatant); токены-лампочки (domain.Token.LightOnly)
// внутри группы молча пропускаем — своего "хода" у них не бывает. Убитых
// (token.dead) — тоже: иначе монстр вернулся бы в бой с полным HP шаблона
// заново, минуя вкладку "Убитые" трекера, которая для этого и есть
// (restore/лут — см. combat-panel.js). Сервер (handleAddCombatant) это же
// правило перепроверяет сам — тут только чтобы не улетал заведомо бесполезный
// WS-запрос и не мигал список инициативы лишний раз.
tokenMenuAddInitiativeBtn.onclick = () => {
  if (!menuTokenIds.length) return;
  const tokens = vtt.getScene().tokens || {};
  for (const tokenId of menuTokenIds) {
    const t = tokens[tokenId];
    if (t && (t.lightOnly || t.dead)) continue;
    if (menuCombatTokenIds.has(tokenId)) continue; // уже боец трекера — см. menuCombatTokenIds
    vtt.send({ type: "add_combatant", tokenId });
  }
  closeTokenMenu();
};

// tokenMenuStatusBtn — "Состояния": палитра наложения метки прямо с карты,
// аналог палитры статусов в Token HUD у Foundry (см. status-palette.js —
// тот же модуль, что и "+" в карточке бойца трекера). Меню токена при этом
// закрывается: палитра встаёт на его место и дальше живёт сама. При
// пачечном выделении палитра получает весь список id (target.tokenIds) —
// каждый клик по иконке уходит всем сразу (см. status-palette.js:
// targetList/dispatch), а "активной" подсвечивается только метка, висящая
// СРАЗУ на всех, иначе клик по ней визуально снял бы её лишь с части.
tokenMenuStatusBtn.onclick = (e) => {
  if (!menuTokenIds.length) return;
  const tokens = vtt.getScene().tokens || {};
  // Токены-лампочки внутри группы — не существа, состояний не бывает (тот
  // же признак, что и у инициативы выше) — исключаем их из цели палитры.
  const tokenIds = menuTokenIds.filter((tokenId) => !(tokens[tokenId] && tokens[tokenId].lightOnly));
  if (!tokenIds.length) return;
  const isSingle = tokenIds.length === 1;
  const tokenId = tokenIds[0];
  const title = isSingle ? menuCharacterLabel : `выбрано токенов: ${tokenIds.length}`;
  closeTokenMenu();
  openStatusPalette({
    x: e.clientX,
    y: e.clientY,
    target: isSingle ? { tokenId } : { tokenIds },
    send: vtt.send,
    title,
    // Читаем метки из ЖИВОЙ сцены на каждый рендер палитры, а не из снимка
    // токена, с которым открывали меню, — та же причина, что и у
    // "vtt:toggleTokenLight" ниже: пока палитра открыта, сцена приходит с
    // сервера ещё много раз.
    statusesFor: () => {
      const liveTokens = vtt.getScene().tokens || {};
      if (isSingle) return (liveTokens[tokenId] && liveTokens[tokenId].statuses) || [];
      const lists = tokenIds.map((id) => (liveTokens[id] && liveTokens[id].statuses) || []);
      const [first, ...rest] = lists;
      return (first || []).filter((st) => rest.every((list) => list.some((o) => o.slug === st.slug)));
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
    showAlert("Не удалось загрузить список персонажей: " + err.message);
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

// sendTokenMenuLight — шлёт одни и те же настройки света на каждый токен в
// menuTokenIds (для одиночного меню это всегда [menuTokenId], для пачечного
// — весь состав выделения: "Добавить источник света с одними и теми же
// настройками", дальше каждый токен можно поправить отдельно через его
// собственное одиночное меню — оно всегда читает АКТУАЛЬНОЕ состояние).
function sendTokenMenuLight() {
  if (!menuTokenIds.length) return;
  const enabled = menuIsLightOnly ? menuLightEnabled : tokenMenuLight.checked;
  const light = { enabled, bright: +tokenMenuLightBright.value || 0, dim: +tokenMenuLightDim.value || 0 };
  for (const id of menuTokenIds) {
    document.dispatchEvent(new CustomEvent("vtt:setTokenLight", { detail: { id, light } }));
  }
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
  if (!menuTokenIds.length) return;
  // vtt:removeToken сам чистит id из selectedTokenIds по одному (см.
  // interaction.js) — дёргаем его по кругу, отдельного батч-события не надо.
  for (const id of menuTokenIds) {
    document.dispatchEvent(new CustomEvent("vtt:removeToken", { detail: { id } }));
  }
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
    const roleLabel = accountRoleLabel(a.role);
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
      const pw = await showPrompt(`Новый пароль для «${a.username}»:`, {
        title: "Сменить пароль",
        okLabel: "Сменить",
        hint: "Минимум 6 символов. Старые сессии этого аккаунта будут разлогинены.",
      });
      if (!pw) return;
      try {
        await setAdminAccountPassword(a.id, pw);
        showAlert("Пароль изменён, старые сессии этого аккаунта разлогинены.");
      } catch (err) {
        showAlert("Не удалось сменить пароль: " + err.message);
      }
    };
    actions.appendChild(pwBtn);
    const delBtn = document.createElement("button");
    delBtn.className = "danger";
    delBtn.textContent = "Удалить";
    delBtn.onclick = async () => {
      if (!(await showConfirm(`Удалить аккаунт «${a.username}» вместе с его персонажами?`, { title: "Удалить аккаунт", okLabel: "Удалить", danger: true, hint: "Это необратимо." }))) return;
      try {
        await deleteAdminAccount(a.id);
        await renderAccounts();
        await refreshAccountsBadge();
      } catch (err) {
        showAlert("Не удалось удалить: " + err.message);
      }
    };
    actions.appendChild(delBtn);
    row.appendChild(actions);
    accountsList.appendChild(row);
  }
}

onPanelOpen("accounts", renderAccounts);

// ================= раздел "Настройки" =================
// Версия сервера (short commit hash, см. cmd/beacon-table/version.go),
// ссылка на трансляцию и общие тумблеры приложения; раздел заведён отдельно
// от "Аккаунтов", чтобы будущим общим настройкам было куда встать, не мешая
// уже существующим разделам.
onPanelOpen("settings", async () => {
  await loadSettingsTab(activeSettingsTab);
});

// ---- вкладки раздела «Настройки» ----
// Раздел собрал слишком разное: тумблеры стола, ссылку на трансляцию,
// настройки сервера и список модулей. Одним списком это читается как свалка,
// поэтому разложено по вкладкам, а данные грузятся только для открытой —
// список модулей Foundry, например, незачем тянуть ради смены уровня журнала.
const settingsTabButtons = [...document.querySelectorAll(".set-tabs button")];
const settingsTabPanels = [...document.querySelectorAll(".set-tab-panel")];
let activeSettingsTab = "table";

async function loadSettingsTab(tab) {
  switch (tab) {
    case "cast":
      await renderBroadcastLink();
      await renderBroadcastRequests();
      break;
    case "server":
      await renderServerSettings();
      await renderAppVersion();
      break;
    case "modules":
      await renderFoundryModules();
      break;
    default:
      break; // «Стол» — тумблеры, они приходят со снапшотом сцены
  }
}

async function renderAppVersion() {
  const el = document.getElementById("appVersion");
  try {
    const { version } = await fetchVersion();
    el.textContent = version;
  } catch {
    el.textContent = "неизвестна";
  }
}

function switchSettingsTab(tab) {
  activeSettingsTab = tab;
  settingsTabButtons.forEach((b) => b.classList.toggle("active", b.dataset.settab === tab));
  settingsTabPanels.forEach((p) => p.classList.toggle("active", p.dataset.settabPanel === tab));
  loadSettingsTab(tab);
}

settingsTabButtons.forEach((btn) => {
  btn.onclick = () => switchSettingsTab(btn.dataset.settab);
});

// ---- настройки сервера (раздел "Настройки") ----
// Те же значения, что лежат в beacon.conf, но с подписями и проверкой (см.
// internal/api/http/settings_handlers.go). Пути и порт показываются серыми:
// это уровень машины, а не игры, и меняются они только в файле.
const serverSettingsBox = document.getElementById("serverSettings");
const serverSettingsMsg = document.getElementById("serverSettingsMsg");
const serverSettingsSaveBtn = document.getElementById("serverSettingsSaveBtn");

// serverSettingsInputs — key → поле формы; serverSettingsSaved — что было в
// полях на момент отрисовки. Отправляем только изменённое: иначе сервер
// пересохранял бы всё подряд и честно сообщал, что половине настроек нужен
// перезапуск, хотя человек тронул одну.
let serverSettingsInputs = new Map();
let serverSettingsSaved = new Map();

function settingField(setting) {
  const wrap = document.createElement("div");
  wrap.className = "srv-set" + (setting.editable ? "" : " readonly");

  const title = document.createElement("div");
  title.className = "srv-set-title";
  title.textContent = setting.title;
  wrap.appendChild(title);

  let input;
  if (setting.kind === "bool" || setting.kind === "enum") {
    input = document.createElement("select");
    const options = setting.kind === "bool" ? ["true", "false"] : setting.options || [];
    for (const value of options) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = setting.kind === "bool" ? (value === "true" ? "включено" : "выключено") : value;
      input.appendChild(opt);
    }
    input.value = setting.value;
  } else {
    input = document.createElement("input");
    input.type = "text";
    input.value = setting.value;
  }
  input.disabled = !setting.editable;
  wrap.appendChild(input);
  if (setting.editable) serverSettingsInputs.set(setting.key, input);

  if (setting.hint) {
    const hint = document.createElement("div");
    hint.className = "srv-set-hint";
    hint.textContent = setting.hint;
    wrap.appendChild(hint);
  }
  if (setting.locked) {
    const locked = document.createElement("div");
    locked.className = "srv-set-locked";
    locked.textContent = setting.locked;
    wrap.appendChild(locked);
  }
  return wrap;
}

// SETTINGS_GROUP_ORDER — порядок групп в форме. То, что можно менять, идёт
// сверху; пути и порт — в конец, они только для чтения, и упираться в них
// первым делом незачем.
const SETTINGS_GROUP_ORDER = ["Доступ", "Резервное копирование", "Журнал", "Место под загрузки", "Пути и порт"];

// SETTINGS_GROUP_NOTES — пояснение на всю группу. Пишем его один раз сверху,
// а не пометкой под каждым полем: под четырьмя строками подряд одно и то же
// предупреждение читается как ошибка, а не как объяснение.
const SETTINGS_GROUP_NOTES = {
  "Пути и порт": "Меняются только в файле beacon.conf или флагом запуска — на сервере это уровень машины, а не игры.",
};

function drawServerSettings(settings) {
  serverSettingsInputs = new Map();
  serverSettingsSaved = new Map();
  serverSettingsBox.replaceChildren();

  // Группируем по секции, а не по соседству в списке: в файле настройки
  // идут в своём порядке (каталог бэкапов стоит рядом с бэкапами), и
  // «подряд идущие» дали бы одну и ту же группу дважды.
  const groups = new Map();
  for (const setting of settings) {
    if (!groups.has(setting.section)) groups.set(setting.section, []);
    groups.get(setting.section).push(setting);
    if (setting.editable) serverSettingsSaved.set(setting.key, setting.value);
  }

  const order = [
    ...SETTINGS_GROUP_ORDER.filter((g) => groups.has(g)),
    ...[...groups.keys()].filter((g) => !SETTINGS_GROUP_ORDER.includes(g)),
  ];
  for (const name of order) {
    const groupBox = document.createElement("div");
    groupBox.className = "set-group";

    const title = document.createElement("div");
    title.className = "set-group-title";
    title.textContent = name;
    groupBox.appendChild(title);

    const note = SETTINGS_GROUP_NOTES[name];
    if (note) {
      const noteEl = document.createElement("div");
      noteEl.className = "set-group-note";
      noteEl.textContent = note;
      groupBox.appendChild(noteEl);
    }
    for (const setting of groups.get(name)) groupBox.appendChild(settingField(setting));
    serverSettingsBox.appendChild(groupBox);
  }
}

async function renderServerSettings() {
  try {
    drawServerSettings((await fetchServerSettings()) || []);
    serverSettingsMsg.textContent = "";
  } catch (e) {
    serverSettingsBox.replaceChildren();
    serverSettingsMsg.textContent = e.message || "не удалось прочитать настройки";
  }
}

serverSettingsSaveBtn.onclick = async () => {
  const values = {};
  for (const [key, input] of serverSettingsInputs) {
    const value = input.value.trim();
    if (value !== serverSettingsSaved.get(key)) values[key] = value;
  }
  if (Object.keys(values).length === 0) {
    serverSettingsMsg.textContent = "Менять нечего — ничего не изменилось.";
    return;
  }

  serverSettingsSaveBtn.disabled = true;
  try {
    const res = await saveServerSettings(values);
    drawServerSettings(res.settings || []);
    // Часть настроек применяется сразу, часть — только при следующем
    // запуске; говорим прямо, какие именно, чтобы «не подействовало» не
    // выглядело поломкой.
    const restart = res.needRestart || [];
    serverSettingsMsg.textContent = restart.length
      ? "Сохранено. Вступит в силу после перезапуска сервера: " + restart.join(", ")
      : "Сохранено и уже действует.";
  } catch (e) {
    serverSettingsMsg.textContent = e.message || "не удалось сохранить";
  } finally {
    serverSettingsSaveBtn.disabled = false;
  }
};

// ---- ссылка на трансляцию (раздел "Настройки") ----
// Адрес с ключом, по которому телевизор получает доступ к столу без аккаунта
// (см. internal/service/broadcast.go). Перевыпуск отключает все экраны разом,
// поэтому спрашиваем подтверждение.
const broadcastLinkInput = document.getElementById("broadcastLink");
const broadcastCopyBtn = document.getElementById("broadcastCopyBtn");
const broadcastRotateBtn = document.getElementById("broadcastRotateBtn");

async function renderBroadcastLink() {
  try {
    const { url } = await fetchBroadcastLink();
    broadcastLinkInput.value = url;
  } catch {
    broadcastLinkInput.value = "не удалось получить ссылку";
  }
}

broadcastCopyBtn.onclick = async () => {
  const url = broadcastLinkInput.value;
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    // Буфер обмена недоступен (не защищённое соединение, отказ в правах) —
    // выделяем текст, чтобы ссылку можно было скопировать вручную.
    broadcastLinkInput.select();
    return;
  }
  const label = broadcastCopyBtn.textContent;
  broadcastCopyBtn.textContent = "Скопировано";
  setTimeout(() => {
    broadcastCopyBtn.textContent = label;
  }, 1500);
};

// ---- экраны, ожидающие подтверждения (раздел "Настройки") ----
// Второй путь для телевизора: ссылку с ключом на нём не набрать, поэтому
// экран открывает /broadcast.html как есть, показывает код и ждёт здесь (см.
// internal/service/broadcast_requests.go). ДМ сверяет код с тем, что горит на
// экране, и пускает.
const broadcastRequestsBox = document.getElementById("broadcastRequests");
const settingsRailBtn = document.getElementById("settingsBtn");

// BROADCAST_REQUESTS_POLL_MS — опрос идёт всё время, пока открыт стол: ДМ
// узнаёт о ждущем экране по точке на иконке «Настройки», не открывая раздел.
// Пять секунд — человек у телевизора не успевает решить, что не работает.
const BROADCAST_REQUESTS_POLL_MS = 5000;

function formatRequestAge(iso) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "только что";
  const minutes = Math.round(seconds / 60);
  return minutes + " мин назад";
}

function drawBroadcastRequests(requests) {
  broadcastRequestsBox.replaceChildren();
  if (!requests.length) {
    const empty = document.createElement("div");
    empty.className = "bcast-req-empty";
    empty.textContent = "Сейчас никто не ждёт.";
    broadcastRequestsBox.appendChild(empty);
    return;
  }
  for (const req of requests) {
    const card = document.createElement("div");
    card.className = "bcast-req";

    const code = document.createElement("div");
    code.className = "bcast-req-code";
    code.textContent = req.code;

    const meta = document.createElement("div");
    meta.className = "bcast-req-meta";
    meta.textContent = `${req.remoteAddr} · ${formatRequestAge(req.createdAt)}`;

    const buttons = document.createElement("div");
    buttons.className = "row-inline";

    const approve = document.createElement("button");
    approve.type = "button";
    approve.textContent = "Пустить";
    approve.onclick = async () => {
      approve.disabled = true;
      try {
        await approveBroadcastRequest(req.id);
      } catch (e) {
        showAlert(e.message || "не удалось пустить экран");
      }
      await renderBroadcastRequests();
    };

    const reject = document.createElement("button");
    reject.type = "button";
    reject.textContent = "Отклонить";
    reject.onclick = async () => {
      reject.disabled = true;
      try {
        await rejectBroadcastRequest(req.id);
      } catch {
        /* заявка уже неактуальна — список всё равно перечитаем */
      }
      await renderBroadcastRequests();
    };

    buttons.append(approve, reject);
    card.append(code, meta, buttons);
    broadcastRequestsBox.appendChild(card);
  }
}

async function renderBroadcastRequests() {
  let requests = [];
  try {
    requests = (await fetchBroadcastRequests()) || [];
  } catch {
    return; // не мешаем работе стола из-за упавшего опроса
  }
  // Точка на иконке рейла — единственный способ узнать о ждущем экране, не
  // открывая раздел; ДМ во время игры смотрит на карту, а не в настройки.
  settingsRailBtn.classList.toggle("has-badge", requests.length > 0);
  // Раздел закрыт — перерисовывать нечего, но точку выше обновить надо было.
  if (!broadcastRequestsBox.offsetParent) return;
  drawBroadcastRequests(requests);
}

setInterval(renderBroadcastRequests, BROADCAST_REQUESTS_POLL_MS);
renderBroadcastRequests();

broadcastRotateBtn.onclick = async () => {
  const ok = await showConfirm(
    "Все экраны, открытые по прежней ссылке, потеряют доступ к столу. Чтобы вернуть их, нужно будет открыть на каждом новую ссылку.",
    { title: "Перевыпустить ссылку трансляции?", okLabel: "Перевыпустить", danger: true },
  );
  if (!ok) return;
  try {
    const { url } = await rotateBroadcastLink();
    broadcastLinkInput.value = url;
  } catch (e) {
    showAlert(e.message || "не удалось перевыпустить ссылку");
  }
};

// ---- модули Foundry VTT (раздел "Настройки") ----
// Список того, что ДМ хотя бы раз импортировал в этот мир (см.
// service.FoundryService.Installed), плюс необязательная проверка новых
// версий по кнопке (см. checkFoundryModuleUpdates) — сама по себе она не
// ходит в сеть на каждое открытие панели.
const foundryModulesList = document.getElementById("foundryModulesList");
const foundryModulesCheckBtn = document.getElementById("foundryModulesCheckBtn");
let foundryModulesCache = []; // последний ответ fetchFoundryModules — drawFoundryModules перерисовывает по нему же после проверки обновлений/удаления
let foundryModulesUpdates = null; // последний результат "Проверить обновления" (id → {latestVersion,updateAvailable,error}) — переживает перерисовку после удаления одного пакета

// FOUNDRY_CARD_LABELS — подписи разделов для итога "Удалить модуль" (см.
// deleteFoundryModuleFlow), те же ключи, что в service.FoundryModuleDelete.Cards
// (foundry.Target*), и те же подписи, что у TARGETS в foundry-import.js.
const FOUNDRY_CARD_LABELS = { monsters: "Существа", spells: "Заклинания", items: "Снаряжение", references: "Справочник", conditions: "Состояния" };

function formatModuleDate(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "—" : d.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
}

// openFoundryUpdateWindow — то же окно импорта, что открывает "＋ Импорт из
// Foundry VTT" в Справочнике (см. compendium-menu.js), но со ссылкой на
// манифест уже подставленной в поле и разведкой, запущенной сразу (см.
// foundry-import.js: boot() читает ?url= из адреса окна). ДМ остаётся
// выбрать паки/разделы и нажать "Импортировать" — то же самое, что и при
// первой установке, потому и не отдельная кнопка "Обновить одним кликом".
// Свой key на каждый пакет (а не общий "foundry-import", как у пункта
// Справочника) — иначе клик "Обновить" при уже открытом окне импорта просто
// поднял бы его наверх со старым содержимым, а не подставил новую ссылку
// (см. openFloatingWindow: у существующего окна по key url не меняется).
function openFoundryUpdateWindow(m) {
  openFloatingWindow({
    key: "foundry-import-" + m.id,
    title: "Обновление: " + m.title,
    url: `/foundry-import.html?url=${encodeURIComponent(m.manifestUrl)}`,
    width: 560,
    height: 640,
  });
}

async function renderFoundryModules() {
  try {
    foundryModulesCache = (await fetchFoundryModules()) || [];
  } catch (err) {
    foundryModulesList.innerHTML = `<p class="hint">Ошибка: ${err.message}</p>`;
    return;
  }
  drawFoundryModules();
}

// drawFoundryModules — updatesById есть только после "Проверить обновления"
// (id пакета → {latestVersion, updateAvailable, error}); без него список
// просто показывает установленные версии, без статуса.
function drawFoundryModules(updatesById) {
  foundryModulesList.innerHTML = "";
  if (!foundryModulesCache.length) {
    foundryModulesList.innerHTML = '<p class="hint">Пакетов пока не импортировано — см. "＋ Импорт из Foundry VTT" в Справочнике.</p>';
    return;
  }
  for (const m of foundryModulesCache) {
    const upd = updatesById && updatesById[m.id];
    const row = document.createElement("div");
    row.className = "account-row";
    let pill = "";
    if (upd) {
      if (upd.error) pill = `<span class="status-pill error" title="${upd.error}">не проверилось</span>`;
      else if (upd.updateAvailable) pill = `<span class="status-pill update">вышла ${upd.latestVersion}</span>`;
      else pill = `<span class="status-pill active">актуально</span>`;
    }
    row.innerHTML = `
      <div class="account-top">
        <span class="account-name">${m.title}</span>
        <span class="account-version">v${m.version || "?"}</span>
        ${pill}
      </div>
      <div class="hint" style="margin-bottom:6px;">импортирован ${formatModuleDate(m.importedAt)}</div>
    `;
    const actions = document.createElement("div");
    actions.className = "account-actions";
    if (upd && upd.updateAvailable) {
      const updBtn = document.createElement("button");
      updBtn.className = "approve";
      updBtn.textContent = "Обновить";
      updBtn.onclick = () => openFoundryUpdateWindow(m);
      actions.appendChild(updBtn);
    }
    const delBtn = document.createElement("button");
    delBtn.className = "danger";
    delBtn.textContent = "Удалить";
    delBtn.onclick = () => deleteFoundryModuleFlow(m);
    actions.appendChild(delBtn);
    row.appendChild(actions);
    foundryModulesList.appendChild(row);
  }
}

foundryModulesCheckBtn.addEventListener("click", async () => {
  foundryModulesCheckBtn.disabled = true;
  foundryModulesCheckBtn.textContent = "Проверяем…";
  try {
    const results = await checkFoundryModuleUpdates();
    foundryModulesUpdates = Object.fromEntries(results.map((r) => [r.id, r]));
    drawFoundryModules(foundryModulesUpdates);
  } catch (err) {
    showAlert("Не удалось проверить обновления: " + err.message);
  } finally {
    foundryModulesCheckBtn.disabled = false;
    foundryModulesCheckBtn.textContent = "Проверить обновления";
  }
});

// deleteFoundryModuleFlow — "Удалить модуль" (см. deleteFoundryModule):
// сносит карточки, помеченные этим пакетом (включая те, что ДМ успел
// отредактировать после импорта — правка карточки метку не снимает, см.
// foundry-import.js: importCards), и скачанные им файлы. Сцены/плейлисты/
// заметки того же импорта не трогает — предупреждаем об этом прямо в
// диалоге, а не молча (см. FoundryService.Delete).
async function deleteFoundryModuleFlow(m) {
  const ok = await showConfirm(
    `Удалить модуль «${m.title}»?\n\n` +
      "Будут снесены карточки (существа/заклинания/снаряжение/справочник/состояния), заведённые или в последний раз перезаписанные этим модулем — ДАЖЕ те, что были отредактированы после импорта, — а также файлы, скачанные им в библиотеку загрузок (карты/токены/аудио/картинки заметок).\n\n" +
      "Сцены, плейлисты и заметки этого модуля не трогает — их придётся удалить отдельно, если нужно.",
    { title: "Удалить модуль", okLabel: "Удалить", danger: true, hint: "Отменить это действие нельзя." }
  );
  if (!ok) return;
  try {
    const result = await deleteFoundryModule(m.id);
    foundryModulesCache = foundryModulesCache.filter((x) => x.id !== m.id);
    if (foundryModulesUpdates) delete foundryModulesUpdates[m.id];
    drawFoundryModules(foundryModulesUpdates);
    const cards = result.cards || {};
    const total = Object.values(cards).reduce((a, b) => a + b, 0);
    const breakdown = Object.entries(cards)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${FOUNDRY_CARD_LABELS[k] || k}: ${n}`)
      .join(", ");
    // Открытые окна-списки компендиума показывают уже несуществующие
    // карточки — тот же сигнал, что шлёт правка карточки (см.
    // floating-window.js: postToOpenWindows).
    for (const type of ["beacon:monsterSaved", "beacon:spellSaved", "beacon:itemSaved", "beacon:referenceSaved", "beacon:conditionSaved"]) {
      postToOpenWindows("catalog-", { type });
    }
    let msg = `Модуль «${m.title}» удалён. Карточек снесено: ${total}${breakdown ? ` (${breakdown})` : ""}.`;
    if (result.warnings && result.warnings.length) msg += "\n\nПредупреждения:\n" + result.warnings.join("\n");
    showAlert(msg, { title: "Модуль удалён" });
  } catch (err) {
    showAlert("Не удалось удалить: " + err.message);
  }
}

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
// dmCharEditPregen — если правится заготовка из пула «Готовые персонажи», а не
// персонаж игрока: полный объект пре-гена (нужен его лист/модуль при
// перезаписи через updateAdminPregen). null — обычная правка персонажа игрока.
let dmCharEditPregen = null;

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
  dmCharEditPregen = null;
  dmCharEditForm.style.display = "none";
  dmCharEditMsg.textContent = "";
}

function openDmCharEditForm(c) {
  dmCharEditingId = c.id;
  dmCharEditPregen = null;
  dmCharPendingAvatarUrl = c.avatarUrl || "";
  dmCharEditName.value = c.name;
  dmCharEditAvatarUpload.value = "";
  showDmCharAvatarPreview(c.avatarUrl || "");
  dmCharEditMsg.textContent = "";
  dmCharEditForm.style.display = "block";
}

// openDmPregenEditForm — та же форма «Имя / аватар», но для свободной
// заготовки из пула: сохранение уходит в updateAdminPregen (полная
// перезапись — лист и метку модуля берём из самого пре-гена).
function openDmPregenEditForm(p) {
  dmCharEditingId = p.id;
  dmCharEditPregen = p;
  dmCharPendingAvatarUrl = p.avatarUrl || "";
  dmCharEditName.value = p.name;
  dmCharEditAvatarUpload.value = "";
  showDmCharAvatarPreview(p.avatarUrl || "");
  dmCharEditMsg.textContent = "";
  dmCharEditForm.style.display = "block";
}

// createPregenFlow — ДМ заводит заготовку персонажа заранee (до того, как
// игрок вообще появился): пустой пре-ген по имени, затем сразу открываем его
// лист для заполнения. Дальше — «Назначить» аккаунту игрока, как у
// импортированных из Foundry.
async function createPregenFlow() {
  const name = await showPrompt("Имя персонажа:", { title: "Новый готовый персонаж", okLabel: "Создать" });
  if (!name || !name.trim()) return;
  let created;
  try {
    created = await createAdminPregen(name.trim());
  } catch (err) {
    showAlert("Не удалось создать: " + err.message);
    return;
  }
  await renderDmCharacters();
  openFloatingWindow({ key: "pregen-" + created.id, title: created.name, url: `/character-sheet.html?pregen=${created.id}` });
}

// pregenPoolRow — строка ещё не назначенной заготовки (см. internal/domain/pregen.go):
// открыть/заполнить лист, поправить имя-аватар, назначить игроку, убрать.
// orphan — заготовку кто-то брал, но своего персонажа игрок удалил: назначить
// нельзя (Claim вернёт 409), поэтому вместо «назначить» — «вернуть в пул».
function pregenPoolRow(p) {
  const orphan = !!p.claimedBy;
  const row = document.createElement("div");
  row.className = "dmchar-row dmchar-row--pregen";

  const avatar = document.createElement("div");
  avatar.className = "dmchar-avatar";
  if (p.avatarUrl) avatar.style.backgroundImage = `url("${p.avatarUrl}")`;
  else avatar.textContent = "—";

  const name = document.createElement("div");
  name.className = "dmchar-name";
  const sub = [p.species, p.class && `${p.class}${p.level ? ` ${p.level} ур.` : ""}`].filter(Boolean).join(", ");
  // «заготовка» в каждой строке — чтобы её не путали с настоящим персонажем
  // игрока, у которого может быть такое же имя (заготовка — это шаблон листа,
  // персонажа из неё ещё не создали).
  const status = orphan ? `заготовка · игрок ${p.claimedByUsername || ""} удалил персонажа` : "заготовка · свободна";
  name.innerHTML = `${p.name}<div style="font-size:11px;opacity:0.55;">${status}${sub ? ` · ${sub}` : ""}</div>`;
  row.append(avatar, name);

  const sheetBtn = document.createElement("button");
  sheetBtn.className = "icon-btn";
  sheetBtn.innerHTML = icon("scroll", { size: 14 });
  sheetBtn.title = "Открыть лист заготовки (можно править)";
  sheetBtn.onclick = () => openFloatingWindow({ key: "pregen-" + p.id, title: p.name, url: `/character-sheet.html?pregen=${p.id}` });
  row.appendChild(sheetBtn);

  const editBtn = document.createElement("button");
  editBtn.className = "icon-btn";
  editBtn.innerHTML = icon("pencil", { size: 14 });
  editBtn.title = "Имя / аватар";
  editBtn.onclick = () => openDmPregenEditForm(p);
  row.appendChild(editBtn);

  if (orphan) {
    const releaseBtn = document.createElement("button");
    releaseBtn.className = "icon-btn";
    releaseBtn.innerHTML = icon("chevron-left", { size: 14 });
    releaseBtn.title = "Снять пометку занятости — заготовка снова свободна для назначения";
    releaseBtn.onclick = async () => {
      try {
        await releasePregen(p.id);
        await renderDmCharacters();
      } catch (err) {
        showAlert("Не удалось: " + err.message);
      }
    };
    row.appendChild(releaseBtn);
  } else {
    const assignBtn = document.createElement("button");
    assignBtn.className = "icon-btn";
    assignBtn.innerHTML = icon("user", { size: 14 });
    assignBtn.title = "Назначить аккаунту игрока";
    assignBtn.onclick = () => assignPregenFlow(p);
    row.appendChild(assignBtn);
  }

  const delBtn = document.createElement("button");
  delBtn.className = "icon-btn";
  delBtn.innerHTML = icon("trash", { size: 14 });
  delBtn.title = "Удалить заготовку";
  delBtn.onclick = async () => {
    if (!(await showConfirm(`Удалить заготовку «${p.name}»?`, { title: "Удалить заготовку", okLabel: "Удалить", danger: true }))) return;
    try {
      await deleteAdminPregen(p.id);
      await renderDmCharacters();
    } catch (err) {
      showAlert("Не удалось удалить: " + err.message);
    }
  };
  row.appendChild(delBtn);
  return row;
}

// assignPregenFlow — выбор аккаунта игрока и назначение пре-гена ему.
async function assignPregenFlow(pregen) {
  let accounts = [];
  try {
    accounts = (await fetchAdminAccounts()).filter((a) => isPlayer(a.role) && a.status === "active");
  } catch (err) {
    showAlert("Не удалось загрузить список игроков: " + err.message);
    return;
  }
  if (!accounts.length) {
    showAlert("Нет активных аккаунтов игроков — сначала заведи их в разделе «Аккаунты».");
    return;
  }
  let select;
  const accountId = await openModal({
    title: `Назначить «${pregen.name}»`,
    okLabel: "Назначить",
    cancelLabel: "Отмена",
    buildBody: (body) => {
      const label = document.createElement("label");
      label.textContent = "Игрок:";
      label.style.cssText = "display:block;font-size:12px;opacity:0.7;margin-bottom:6px;";
      select = document.createElement("select");
      select.style.cssText = "width:100%;padding:7px 8px;font-size:13px;";
      for (const a of accounts) {
        const opt = document.createElement("option");
        opt.value = a.id;
        opt.textContent = a.username;
        select.appendChild(opt);
      }
      body.append(label, select);
      return select;
    },
    onOk: () => select.value,
    onCancel: () => null,
  });
  if (!accountId) return;
  try {
    await assignPregen(pregen.id, accountId);
    await renderDmCharacters();
  } catch (err) {
    showAlert("Не удалось назначить: " + err.message);
  }
}

// assignedCharRow — строка назначенного персонажа (у конкретного игрока).
// Перетаскивается на карту (ставит токен). pregen — заготовка, из которой он
// создан (если есть): подпись «из заготовки «…»» + кнопка «отвязать» (удаляет
// этого персонажа и возвращает заготовку в «Не назначенные»).
function assignedCharRow(c, pregen) {
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
  if (pregen) name.innerHTML = `${c.name}<div style="font-size:11px;opacity:0.55;">из заготовки «${pregen.name}»</div>`;
  else name.textContent = c.name;
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
  if (pregen) {
    const unassignBtn = document.createElement("button");
    unassignBtn.className = "icon-btn";
    unassignBtn.innerHTML = icon("chevron-left", { size: 14 });
    unassignBtn.title = "Отвязать: удалить этого персонажа у игрока, заготовка вернётся в «Не назначенные»";
    unassignBtn.onclick = async () => {
      const who = c.accountUsername ? ` у ${c.accountUsername}` : "";
      if (!(await showConfirm(`Отвязать «${c.name}»${who}? Персонаж будет удалён, заготовка «${pregen.name}» вернётся в «Не назначенные».`, { title: "Отвязать персонажа", okLabel: "Отвязать", danger: true }))) return;
      try {
        await releasePregen(pregen.id);
        await renderDmCharacters();
      } catch (err) {
        showAlert("Не удалось отвязать: " + err.message);
      }
    };
    row.append(unassignBtn);
  }
  return row;
}

// renderDmCharacters — панель «Персонажи»: сверху ещё не назначенные заготовки
// (пул мира, см. internal/domain/pregen.go) + кнопка «Создать», ниже —
// назначенные персонажи, сгруппированные по игрокам. Одна заготовка при
// назначении превращается в обычного персонажа игрока (Claim), поэтому в
// верхнем блоке остаются только свободные.
async function renderDmCharacters() {
  let pregens = [];
  try {
    [dmCharacters, pregens] = await Promise.all([fetchAdminCharacters(), fetchAdminPregens().catch(() => [])]);
  } catch (err) {
    dmCharactersList.innerHTML = `<p class="hint">Ошибка: ${err.message}</p>`;
    return;
  }
  closeDmCharEditForm();
  dmCharactersList.innerHTML = "";

  const charById = new Map(dmCharacters.map((c) => [c.id, c]));
  const pregenForChar = new Map(); // id персонажа игрока -> заготовка, из которой он создан
  const pool = []; // заготовки для блока «Не назначенные»
  for (const p of pregens) {
    if (p.claimedBy && p.claimedCharacterId && charById.has(p.claimedCharacterId)) pregenForChar.set(p.claimedCharacterId, p);
    else pool.push(p); // свободна, либо игрок удалил взятого персонажа
  }

  // ── Не назначенные ──
  const poolHead = document.createElement("div");
  poolHead.className = "dmchar-section";
  poolHead.textContent = "Не назначенные персонажи";
  dmCharactersList.appendChild(poolHead);

  const addRow = document.createElement("div");
  addRow.className = "dmchar-row dmchar-row--pregen";
  const addBtn = document.createElement("button");
  addBtn.className = "tool-btn";
  addBtn.style.cssText = "width:100%;justify-content:center;gap:6px;";
  addBtn.innerHTML = icon("plus", { size: 14 }) + "<span>Создать персонажа</span>";
  addBtn.title = "Завести заготовку заранее — потом назначить игроку";
  addBtn.onclick = createPregenFlow;
  addRow.appendChild(addBtn);
  dmCharactersList.appendChild(addRow);

  if (pool.length) {
    for (const p of pool) dmCharactersList.appendChild(pregenPoolRow(p));
  } else {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.style.cssText = "margin:2px 2px 8px;font-size:11px;";
    hint.textContent = "Свободных заготовок нет.";
    dmCharactersList.appendChild(hint);
  }

  // ── Назначенные ──
  const assignedHead = document.createElement("div");
  assignedHead.className = "dmchar-section";
  assignedHead.textContent = "Назначенные персонажи";
  dmCharactersList.appendChild(assignedHead);

  if (dmCharacters.length === 0) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.style.cssText = "margin:2px 2px 4px;font-size:11px;";
    hint.textContent = "Пока никому не назначено — назначь заготовку выше или игроки заведут своих.";
    dmCharactersList.appendChild(hint);
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
    group.textContent = username || "без аккаунта";
    dmCharactersList.appendChild(group);
    for (const c of chars) dmCharactersList.appendChild(assignedCharRow(c, pregenForChar.get(c.id)));
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
    if (dmCharEditPregen) {
      // Полная перезапись пре-гена — лист и метку модуля не трогаем.
      await updateAdminPregen(dmCharEditingId, {
        name,
        avatarUrl: dmCharPendingAvatarUrl,
        foundryModuleId: dmCharEditPregen.source || "",
        sheet: dmCharEditPregen.sheet,
      });
    } else {
      await updateAdminCharacter(dmCharEditingId, name, dmCharPendingAvatarUrl);
    }
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
    showAlert("Не удалось загрузить монстра: " + err.message);
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
      // decor — это обстановка, а не существо (см. domain.Token.Decor):
      // единственное место, где признак вообще проставляется, — отсюда и
      // берётся право предложить для этого токена замок.
      decor: true,
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
// Foundry-style аккордеон: все плейлисты видны сразу и разворачиваются на
// месте (openPlaylistIds — какие именно), можно держать открытыми сразу
// несколько — без прежнего мастер-детейла "список ⇄ треки" и экрана
// "‹ Назад". Добавление/правка трека — через модалку (openTrackModal), а не
// постоянно занимающую место форму внизу панели. Порядок треков — drag-and-
// drop (см. renderTrackRow) вместо кнопок вверх/вниз.
const playlistAccordion = document.getElementById("playlistAccordion");
const nowPlayingLabel = document.getElementById("nowPlayingLabel");
const nowPlayingProgressBar = document.getElementById("nowPlayingProgressBar");
const nowPlayingProgressFill = document.getElementById("nowPlayingProgressFill");
const cuePlayPauseBtn = document.getElementById("cuePlayPauseBtn");
const cueVolumeSlider = document.getElementById("cueVolumeSlider");

let playlists = [];
let currentCue = null; // {url,name,volume,loop,startedAtMs,paused,positionMs} | null — см. domain.CueState
const openPlaylistIds = new Set(); // id развёрнутых плейлистов

// scrubbing — тащит ли ДМ прямо сейчас полоску прогресса (см. wireSeekBar):
// пока true, updateCueProgress не трогает заполнение баров — иначе
// timeupdate от ещё не перемотанного vtt.cueAudio дёргал бы полоску назад
// прямо под курсором.
let scrubbing = false;

// wireSeekBar — делает полоску прогресса перематываемой: клик/драг ставит
// позицию визуально сразу (без сети), а на отпускании шлёт seek_cue один раз
// — так драг не флудит WS десятками сообщений в секунду. barEl — контейнер с
// .progress-fill внутри (см. #nowPlayingProgressBar и .bt-track-progress).
function wireSeekBar(barEl) {
  const fillEl = barEl.querySelector(".progress-fill");
  const apply = (e, commit) => {
    const audio = vtt.cueAudio;
    if (!audio || !audio.duration || !currentCue) return;
    const rect = barEl.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    fillEl.style.width = pct * 100 + "%";
    if (commit) vtt.send({ type: "seek_cue", cue: { positionMs: Math.round(pct * audio.duration * 1000) } });
  };
  barEl.addEventListener("mousedown", (e) => {
    if (!currentCue) return;
    e.preventDefault();
    scrubbing = true;
    apply(e, false);
    const onMove = (ev) => apply(ev, false);
    const onUp = (ev) => {
      apply(ev, true);
      scrubbing = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}
wireSeekBar(nowPlayingProgressBar);

// stripExt — "тема_боя.mp3" → "тема_боя", чтобы автоподставленное имя трека
// не тащило за собой расширение файла.
function stripExt(fileName) {
  const idx = fileName.lastIndexOf(".");
  return idx > 0 ? fileName.slice(0, idx) : fileName;
}

async function refreshPlaylists() {
  try {
    playlists = await fetchAdminPlaylists();
  } catch (err) {
    console.error("не удалось загрузить плейлисты:", err);
    playlists = [];
  }
  renderPlaylistAccordion();
}

function isPlaylistPlaying(p) {
  return !!(currentCue && (p.tracks || []).some((t) => t.url === currentCue.url));
}

// cueBtnState — единая логика для play/pause-кнопки плейлиста/трека:
// - трек не тот, что сейчас в canale ДМ → "играть" (свежий старт, play_cue);
// - тот же трек, канал играет → "пауза" (pause_cue, не stop_cue — трек не
//   сбрасывается, просто останавливается на месте);
// - тот же трек, канал на паузе → "играть" (resume_cue, с той же позиции).
function cueBtnState(active) {
  if (!active) return { icon: "play", title: "Играть", action: "start" };
  if (currentCue.paused) return { icon: "play", title: "Играть", action: "resume" };
  return { icon: "pause", title: "Пауза", action: "pause" };
}

function renderPlaylistAccordion() {
  playlistAccordion.innerHTML = "";
  for (const p of playlists) playlistAccordion.appendChild(renderPlaylistItem(p));
}

function renderPlaylistItem(p) {
  const expanded = openPlaylistIds.has(p.id);
  const playing = isPlaylistPlaying(p);
  const wrap = document.createElement("div");
  wrap.className = "bt-playlist" + (expanded ? " expanded" : "") + (playing ? " playing" : "");

  const header = document.createElement("div");
  header.className = "bt-playlist-header";
  header.onclick = () => {
    if (expanded) openPlaylistIds.delete(p.id);
    else openPlaylistIds.add(p.id);
    renderPlaylistAccordion();
  };

  const caret = document.createElement("span");
  caret.className = "bt-playlist-caret";
  caret.innerHTML = icon("chevron-right", { size: 13 });

  const playBtn = document.createElement("button");
  playBtn.className = "bt-playlist-play";
  const btnState = cueBtnState(playing);
  playBtn.title = playing ? btnState.title : "Играть с первого трека";
  playBtn.innerHTML = icon(btnState.icon, { size: 12 });
  playBtn.onclick = (e) => {
    e.stopPropagation();
    if (btnState.action === "pause") {
      vtt.send({ type: "pause_cue" });
      return;
    }
    if (btnState.action === "resume") {
      vtt.send({ type: "resume_cue" });
      return;
    }
    const first = (p.tracks || [])[0];
    if (first) vtt.send({ type: "play_cue", cue: { url: first.url, name: first.name, volume: first.volume, loop: first.loop } });
  };

  const name = document.createElement("span");
  name.className = "bt-playlist-name";
  name.textContent = p.name;

  const count = document.createElement("span");
  count.className = "bt-playlist-count";
  count.textContent = (p.tracks || []).length;

  const addBtn = document.createElement("button");
  addBtn.className = "icon-btn";
  addBtn.title = "Добавить трек";
  addBtn.innerHTML = icon("plus", { size: 13 });
  addBtn.onclick = (e) => {
    e.stopPropagation();
    openTrackModal({ playlist: p });
  };

  const renameBtn = document.createElement("button");
  renameBtn.className = "icon-btn";
  renameBtn.title = "Переименовать плейлист";
  renameBtn.innerHTML = icon("pencil", { size: 13 });
  renameBtn.onclick = async (e) => {
    e.stopPropagation();
    const newName = await showPrompt("Новое название:", { title: "Переименовать плейлист", value: p.name, okLabel: "Переименовать" });
    if (!newName) return;
    try {
      await renamePlaylist(p.id, newName);
      await refreshPlaylists();
    } catch (err) {
      showAlert(err.message);
    }
  };

  const delBtn = document.createElement("button");
  delBtn.className = "icon-btn";
  delBtn.title = "Удалить плейлист";
  delBtn.innerHTML = icon("trash", { size: 13 });
  delBtn.onclick = async (e) => {
    e.stopPropagation();
    if (!(await showConfirm(`Удалить плейлист «${p.name}» вместе со всеми треками?`, { title: "Удалить плейлист", okLabel: "Удалить", danger: true }))) return;
    try {
      await deletePlaylist(p.id);
      openPlaylistIds.delete(p.id);
      await refreshPlaylists();
    } catch (err) {
      showAlert(err.message);
    }
  };

  header.append(caret, playBtn, name, count, addBtn, renameBtn, delBtn);
  wrap.appendChild(header);
  if (expanded) wrap.appendChild(renderTrackList(p));
  return wrap;
}

function renderTrackList(p) {
  const list = document.createElement("div");
  list.className = "bt-playlist-tracks";
  const tracks = p.tracks || [];
  if (!tracks.length) {
    const hint = document.createElement("div");
    hint.className = "bt-playlist-empty-hint";
    hint.textContent = "Нет треков — добавь через +";
    list.appendChild(hint);
    return list;
  }
  tracks.forEach((t) => list.appendChild(renderTrackRow(p, t)));
  return list;
}

// draggedTrackId/draggedFromPlaylistId — состояние текущего перетаскивания
// (см. renderTrackRow ниже). Модуль-level, а не замыкание строки: dragover
// одной строки должен видеть, что тащат из другой (draggedFromPlaylistId),
// и отказаться показывать индикатор вставки.
let draggedTrackId = null;
let draggedFromPlaylistId = null;

function renderTrackRow(playlist, t) {
  const isPlaying = !!(currentCue && currentCue.url === t.url);
  const row = document.createElement("div");
  row.className = "bt-track" + (isPlaying ? " playing" : "");
  row.draggable = true;

  const grip = document.createElement("span");
  grip.className = "bt-track-drag";
  grip.title = "Перетащи, чтобы изменить порядок";
  grip.innerHTML = icon("grip-vertical", { size: 13 });

  const playBtn = document.createElement("button");
  playBtn.className = "bt-track-play";
  const btnState = cueBtnState(isPlaying);
  playBtn.title = btnState.title;
  playBtn.innerHTML = icon(btnState.icon, { size: 11 });
  playBtn.onclick = () => {
    if (btnState.action === "pause") vtt.send({ type: "pause_cue" });
    else if (btnState.action === "resume") vtt.send({ type: "resume_cue" });
    else vtt.send({ type: "play_cue", cue: { url: t.url, name: t.name, volume: t.volume, loop: t.loop } });
  };

  const main = document.createElement("div");
  main.className = "bt-track-main";
  const name = document.createElement("span");
  name.className = "bt-track-name";
  name.textContent = t.name;
  main.appendChild(name);
  if (isPlaying) {
    // прогресс-бар — только у реально играющего трека, синхронизируется по
    // vtt.cueAudio (см. updateCueProgress) и перематывается кликом/драгом
    // (см. wireSeekBar), так же как и общий бар в #nowPlayingBar.
    const progress = document.createElement("div");
    progress.className = "bt-track-progress";
    progress.innerHTML = '<div class="progress-track"><div class="progress-fill"></div></div>';
    main.appendChild(progress);
    wireSeekBar(progress);
  }

  const volWrap = document.createElement("label");
  volWrap.className = "bt-track-vol";
  volWrap.title = "Громкость трека";
  volWrap.innerHTML = icon("volume", { size: 12 });
  const volSlider = document.createElement("input");
  volSlider.type = "range";
  volSlider.min = 0;
  volSlider.max = 100;
  volSlider.value = Math.round(t.volume * 100);
  volSlider.onchange = async () => {
    const vol = volSlider.value / 100;
    try {
      await updatePlaylistTrack(playlist.id, t.id, t.name, vol, t.loop);
      t.volume = vol;
      // трек играет прямо сейчас — обновляем громкость на лету, не
      // дожидаясь следующего запуска.
      if (currentCue && currentCue.url === t.url) vtt.send({ type: "set_cue_volume", cue: { volume: vol } });
    } catch (err) {
      showAlert(err.message);
    }
  };
  volWrap.appendChild(volSlider);

  const loopBtn = document.createElement("button");
  loopBtn.className = "icon-btn" + (t.loop ? " active" : "");
  loopBtn.innerHTML = icon("repeat", { size: 13 });
  loopBtn.title = t.loop ? "Трек зациклен — нажми, чтобы играть один раз" : "Трек играет один раз — нажми, чтобы зациклить";
  loopBtn.onclick = async () => {
    const newLoop = !t.loop;
    try {
      await updatePlaylistTrack(playlist.id, t.id, t.name, t.volume, newLoop);
      t.loop = newLoop;
      // трек играет прямо сейчас — обновляем "зациклен" на лету, тем же
      // приёмом, что и громкость чуть выше: без этого играющий трек
      // доигрывает со старым флагом и на конце останавливается/уходит на
      // следующий вместо цикла (см. set_cue_loop в room.go).
      if (currentCue && currentCue.url === t.url) vtt.send({ type: "set_cue_loop", cue: { loop: newLoop } });
      renderPlaylistAccordion();
    } catch (err) {
      showAlert(err.message);
    }
  };

  const editBtn = document.createElement("button");
  editBtn.className = "icon-btn";
  editBtn.title = "Изменить трек";
  editBtn.innerHTML = icon("pencil", { size: 13 });
  editBtn.onclick = () => openTrackModal({ playlist, track: t });

  const delBtn = document.createElement("button");
  delBtn.className = "icon-btn";
  delBtn.title = "Удалить трек";
  delBtn.innerHTML = icon("trash", { size: 13 });
  delBtn.onclick = async () => {
    if (!(await showConfirm(`Удалить трек «${t.name}»?`, { title: "Удалить трек", okLabel: "Удалить", danger: true }))) return;
    try {
      await deletePlaylistTrack(playlist.id, t.id);
      await refreshPlaylists();
    } catch (err) {
      showAlert(err.message);
    }
  };

  row.append(grip, playBtn, main, volWrap, loopBtn, editBtn, delBtn);

  // ---- drag-and-drop переупорядочивание внутри плейлиста ----
  row.addEventListener("dragstart", () => {
    draggedTrackId = t.id;
    draggedFromPlaylistId = playlist.id;
    row.classList.add("dragging");
  });
  row.addEventListener("dragend", () => {
    row.classList.remove("dragging");
    draggedTrackId = null;
    draggedFromPlaylistId = null;
  });
  row.addEventListener("dragover", (e) => {
    if (draggedFromPlaylistId !== playlist.id || draggedTrackId === t.id) return;
    e.preventDefault();
    const before = e.clientY - row.getBoundingClientRect().top < row.offsetHeight / 2;
    row.classList.toggle("drag-over-top", before);
    row.classList.toggle("drag-over-bottom", !before);
  });
  row.addEventListener("dragleave", () => row.classList.remove("drag-over-top", "drag-over-bottom"));
  row.addEventListener("drop", async (e) => {
    e.preventDefault();
    const before = row.classList.contains("drag-over-top");
    row.classList.remove("drag-over-top", "drag-over-bottom");
    if (draggedFromPlaylistId !== playlist.id || !draggedTrackId || draggedTrackId === t.id) return;
    await reorderPlaylistTrack(playlist, draggedTrackId, t.id, before);
  });

  return row;
}

// reorderPlaylistTrack — драг задаёт желаемый порядок целиком на клиенте, но
// бэкенд умеет только сдвигать трек на одну позицию за раз (см. MoveTrack в
// internal/repository/sqlite/playlists.go — обмен местами с соседом),
// поэтому досылаем нужное число шагов "up"/"down" подряд и один раз
// перечитываем плейлисты в конце.
async function reorderPlaylistTrack(playlist, trackId, targetId, before) {
  const ids = (playlist.tracks || []).map((t) => t.id);
  const fromIdx = ids.indexOf(trackId);
  if (fromIdx === -1) return;
  ids.splice(fromIdx, 1);
  let insertAt = ids.indexOf(targetId);
  if (!before) insertAt += 1;
  ids.splice(insertAt, 0, trackId);
  const steps = ids.indexOf(trackId) - fromIdx;
  if (steps === 0) return;
  try {
    const dir = steps > 0 ? "down" : "up";
    for (let i = 0; i < Math.abs(steps); i++) {
      await movePlaylistTrack(playlist.id, trackId, dir);
    }
    await refreshPlaylists();
  } catch (err) {
    showAlert(err.message);
  }
}

// openTrackModal — то же окно и для новой записи (playlist задан, track —
// нет), и для правки существующей (задан track): url трека неизменяем после
// создания (см. updatePlaylistTrack — там нет параметра url), поэтому в
// режиме правки вместо загрузки/библиотеки показывается имя файла как текст.
function openTrackModal({ playlist, track }) {
  const isEdit = !!track;
  let pendingUrl = "";
  let nameInput, librarySelect, volumeInput, loopInput, msgEl;

  openModal({
    title: isEdit ? "Изменить трек" : "Добавить трек",
    okLabel: isEdit ? "Сохранить" : "Добавить",
    cancelLabel: "Отмена",
    buildBody: (body) => {
      const nameField = document.createElement("div");
      nameField.className = "field";
      nameField.innerHTML = "<label>Имя трека</label>";
      nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.maxLength = 60;
      nameInput.value = track ? track.name : "";
      nameField.appendChild(nameInput);
      body.appendChild(nameField);

      if (isEdit) {
        const srcField = document.createElement("div");
        srcField.className = "field";
        const fileLabel = document.createElement("label");
        fileLabel.textContent = "Файл";
        const fileName = document.createElement("p");
        fileName.className = "bt-modal-text dim";
        fileName.textContent = decodeURIComponent(track.url.split("/").pop());
        srcField.append(fileLabel, fileName);
        body.appendChild(srcField);
      } else {
        const uploadField = document.createElement("div");
        uploadField.className = "field";
        uploadField.innerHTML = "<label>Загрузить файл</label>";
        const uploadInput = document.createElement("input");
        uploadInput.type = "file";
        uploadInput.accept = "audio/*";
        uploadInput.onchange = async () => {
          const file = uploadInput.files[0];
          if (!file) return;
          try {
            const { url } = await uploadFile(file, "audio");
            pendingUrl = url;
            if (!nameInput.value.trim()) nameInput.value = stripExt(file.name);
            await refreshLibrary();
            fillLibrary(librarySelect, latestAssets.audio || []);
          } catch (err) {
            msgEl.textContent = "Не удалось загрузить: " + err.message;
          }
        };
        uploadField.appendChild(uploadInput);
        body.appendChild(uploadField);

        const libField = document.createElement("div");
        libField.className = "field";
        libField.innerHTML = "<label>или из библиотеки</label>";
        librarySelect = document.createElement("select");
        fillLibrary(librarySelect, latestAssets.audio || []);
        librarySelect.onchange = () => {
          if (!librarySelect.value) return;
          pendingUrl = librarySelect.value;
          if (!nameInput.value.trim()) nameInput.value = librarySelect.options[librarySelect.selectedIndex].textContent;
        };
        libField.appendChild(librarySelect);
        body.appendChild(libField);
      }

      const volField = document.createElement("div");
      volField.className = "field";
      volField.innerHTML = "<label>Громкость</label>";
      volumeInput = document.createElement("input");
      volumeInput.type = "range";
      volumeInput.min = 0;
      volumeInput.max = 100;
      volumeInput.value = Math.round((track ? track.volume : 0.8) * 100);
      volField.appendChild(volumeInput);
      body.appendChild(volField);

      const loopRow = document.createElement("label");
      loopRow.className = "checkbox-row";
      loopInput = document.createElement("input");
      loopInput.type = "checkbox";
      loopInput.checked = track ? track.loop : false;
      loopRow.append(loopInput, " зациклен");
      body.appendChild(loopRow);

      msgEl = document.createElement("p");
      msgEl.className = "bt-modal-text dim";
      body.appendChild(msgEl);

      return nameInput;
    },
    onOk: async () => {
      const name = nameInput.value.trim();
      const url = isEdit ? track.url : pendingUrl || (librarySelect && librarySelect.value);
      if (!name || !url) {
        showAlert("Нужны имя и файл/трек из библиотеки.");
        return;
      }
      const volume = volumeInput.value / 100;
      const loop = loopInput.checked;
      try {
        if (isEdit) {
          await updatePlaylistTrack(playlist.id, track.id, name, volume, loop);
          // трек играет прямо сейчас — громкость и "зациклен" применяем на
          // лету тем же приёмом, что и в loopBtn выше (см. set_cue_loop).
          if (currentCue && currentCue.url === track.url) {
            vtt.send({ type: "set_cue_volume", cue: { volume } });
            vtt.send({ type: "set_cue_loop", cue: { loop } });
          }
        } else {
          await addPlaylistTrack(playlist.id, url, name, volume, loop);
          openPlaylistIds.add(playlist.id);
        }
        await refreshPlaylists();
      } catch (err) {
        showAlert(err.message);
      }
    },
    onCancel: () => undefined,
  });
}

onPanelOpen("playlists", async () => {
  await refreshPlaylists();
});

// Плейлисты поменялись мимо этой вкладки — другая вкладка ДМ или импорт
// Foundry (см. RoomService.NotifyPlaylistsChanged/net.js: "playlists_changed").
// Перечитываем список сразу, а не только при следующем открытии панели —
// иначе новый плейлист/трек был бы не виден без ручной перезагрузки страницы.
document.addEventListener("vtt:playlistsChanged", refreshPlaylists);

document.getElementById("newPlaylistForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nameInput = document.getElementById("newPlaylistName");
  const name = nameInput.value.trim();
  if (!name) return;
  try {
    const p = await createPlaylist(name);
    nameInput.value = "";
    if (p && p.id) openPlaylistIds.add(p.id); // сразу разворачиваем новый — добавлять треки некуда, кроме как внутрь
    await refreshPlaylists();
  } catch (err) {
    showAlert(err.message);
  }
});

// ---- "Сейчас играет" + автопереход плейлиста ----
function renderNowPlaying() {
  if (!currentCue) {
    nowPlayingLabel.textContent = "Ничего не играет";
    cueVolumeSlider.value = 80;
    nowPlayingProgressFill.style.width = "0%";
    cuePlayPauseBtn.disabled = true;
    cuePlayPauseBtn.classList.remove("active");
    cuePlayPauseBtn.innerHTML = icon("play", { size: 12 });
    cuePlayPauseBtn.title = "Ничего не играет";
  } else {
    nowPlayingLabel.textContent = (currentCue.paused ? "⏸ " : "▶ ") + currentCue.name;
    cueVolumeSlider.value = Math.round(currentCue.volume * 100);
    const btnState = cueBtnState(true);
    cuePlayPauseBtn.disabled = false;
    cuePlayPauseBtn.classList.toggle("active", btnState.action === "pause");
    cuePlayPauseBtn.innerHTML = icon(btnState.icon, { size: 12 });
    cuePlayPauseBtn.title = btnState.title;
  }
}
document.addEventListener("vtt:cueChanged", (e) => {
  currentCue = e.detail;
  renderNowPlaying();
  if (currentCue) {
    // авто-разворачиваем плейлист с играющим треком — как и в Foundry, сразу
    // видно, что и где сейчас звучит, не нужно искать вручную.
    const owner = playlists.find((pl) => (pl.tracks || []).some((t) => t.url === currentCue.url));
    if (owner) openPlaylistIds.add(owner.id);
  }
  renderPlaylistAccordion();
});
cuePlayPauseBtn.onclick = () => {
  if (!currentCue) return;
  vtt.send({ type: currentCue.paused ? "resume_cue" : "pause_cue" });
};
document.getElementById("cueStopBtn").onclick = () => vtt.send({ type: "stop_cue" });
cueVolumeSlider.oninput = () => {
  if (!currentCue) return;
  vtt.send({ type: "set_cue_volume", cue: { volume: cueVolumeSlider.value / 100 } });
};

// updateCueProgress — тонкая полоска прогресса и в баре "сейчас играет", и у
// самого трека в развёрнутом плейлисте (если он сейчас виден), по timeupdate
// на канале ДМ (vtt.cueAudio, слушатель вешается в boot() выше). Пока ДМ
// тащит полоску сам (scrubbing, см. wireSeekBar), сюда не лезем — иначе ещё
// не перемотанный timeupdate дёргал бы её обратно под курсором.
function updateCueProgress() {
  if (scrubbing) return;
  const audio = vtt.cueAudio;
  const pct = audio && audio.duration ? Math.min(100, (audio.currentTime / audio.duration) * 100) : 0;
  nowPlayingProgressFill.style.width = pct + "%";
  const activeFill = playlistAccordion.querySelector(".bt-track.playing .bt-track-progress .progress-fill");
  if (activeFill) activeFill.style.width = pct + "%";
}

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

// ================= значки журнала на карте =================
// Значок-свиток на карте (двойной клик, см. vtt/interaction.js) ведёт на
// запись журнала стола (domain.NoteMarker с library:"journal"). Раскладка
// значков и меню по ПКМ — выше (noteMarkerMenu) и в vtt/interaction.js; сам
// журнал открывается плавающим окном (openJournalWindow).
document.addEventListener("vtt:openNoteMarker", async (e) => {
  const { section, foundryEntry, foundryFolder } = e.detail;
  let entryId = e.detail.noteId;

  // Значок из импорта модуля (см. domain.NoteMarker.FoundryEntry): настоящей
  // записи на момент разбора сцены ещё не было — резолвим её сейчас по имени
  // в журнале стола.
  if (!entryId && foundryEntry) {
    const norm = (s) => (s || "").trim().toLowerCase();
    const journal = await fetchJournal().catch(() => []);
    const named = journal.filter((x) => norm(x.title) === norm(foundryEntry));
    const hit = named.find((x) => norm(x.folder) === norm(foundryFolder)) || named[0];
    if (!hit) {
      showAlert("Запись, на которую ведёт этот значок, не найдена — её могли не импортировать.");
      return;
    }
    entryId = hit.id;
  }
  if (!entryId) return;
  openJournalWindow(entryId, section);
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
window.addEventListener("message", async (e) => {
  if (e.origin !== location.origin || !e.data) return;
  if (e.data.type === "beacon:openFloatingWindow") {
    openFloatingWindow({ key: e.data.key, title: e.data.title, url: e.data.url, navigate: !!e.data.navigate });
  } else if (e.data.type === "beacon:openCombatantCard") {
    // Клик по бойцу в трекере, вынесенном в плавающее окно (iframe
    // combat-tracker.html): своей колонки у него нет — показываем в нашей
    // (см. combatant-card.js: openCombatantCard).
    openCardInDock({ key: e.data.key, title: e.data.title, url: e.data.url });
  } else if (e.data.type === "beacon:focusMapObject") {
    // Кнопка "Показать на карте" в трекере, вынесенном в плавающее окно
    // (iframe combat-tracker.html): своего канваса у него нет — наводим
    // камеру здесь (см. combat-panel.js: focusCombatantToken, тот же жест,
    // что и у "vtt:focusMapObject" из renderLightList ниже).
    document.dispatchEvent(new CustomEvent("vtt:focusMapObject", { detail: { kind: e.data.kind, id: e.data.id } }));
  } else if (e.data.type === "beacon:placeJournalMarker") {
    // Значок записи журнала на карту. Просит окно журнала (iframe, см.
    // pages/journal.js) — расстановка живёт здесь, потому что канвас есть
    // только у этой страницы; дальше всё как со значком заметки ДМ.
    document.dispatchEvent(
      new CustomEvent("vtt:placeNoteMarker", {
        detail: { noteId: e.data.id, label: e.data.title, library: "journal" },
      })
    );
    showAlert("Теперь кликни на карте, куда поставить свиток.", { title: "Значок журнала" });
  } else if (e.data.type === "beacon:switchScene") {
    // Ссылка на сцену внутри текста заметки/журнала (см. catalog-links.js,
    // internal/foundry/links.go). Имя ищем в списке сцен стола без учёта
    // регистра — ссылка родом из чужого модуля. Нашлась и не активна —
    // переключаемся; нет — тихо ничего не делаем (сцену могли не
    // импортировать или переименовать).
    const norm = (s) => (s || "").trim().toLowerCase();
    const scene = sceneList.find((s) => norm(s.name) === norm(e.data.name));
    if (!scene) {
      showAlert(`Сцены «${e.data.name}» нет за столом — импортируй карту из модуля или проверь её название.`);
    } else if (vtt && scene.id !== currentSceneId) {
      vtt.send({ type: "switch_scene", sceneId: scene.id });
      closeSidePanel(); // убрать панель с карты, чтобы новую сцену было видно
    }
  } else if (e.data.type === "beacon:openPlaylist") {
    // Ссылка на плейлист внутри текста заметки/журнала (@UUID[Playlist.…],
    // см. internal/foundry/links.go). Открываем раздел «Плейлисты» и
    // разворачиваем нужный — не запускаем сам: включать музыку по клику
    // на слове посреди чтения было бы слишком.
    showSidePanelSection("playlists");
    await refreshPlaylists();
    const norm = (s) => (s || "").trim().toLowerCase();
    const p = playlists.find((x) => norm(x.name) === norm(e.data.name));
    if (!p) {
      showAlert(`Плейлиста «${e.data.name}» нет — импортируй музыку из модуля или проверь название.`);
    } else {
      openPlaylistIds.add(p.id);
      renderPlaylistAccordion();
      const row = [...playlistAccordion.querySelectorAll(".bt-playlist-name")].find(
        (n) => norm(n.textContent) === norm(p.name)
      );
      if (row) row.scrollIntoView({ block: "center" });
    }
  } else if (
    e.data.type === "beacon:monsterSaved" ||
    e.data.type === "beacon:spellSaved" ||
    e.data.type === "beacon:itemSaved" ||
    e.data.type === "beacon:referenceSaved" ||
    e.data.type === "beacon:conditionSaved"
  ) {
    // Статблок правили в соседнем окне — попап "действия" держит свой кэш
    // монстров (см. combat-actions-peek.js), сбрасываем, иначе он ещё долго
    // показывал бы старый текст.
    if (e.data.type === "beacon:monsterSaved") invalidateActionsPeek(e.data.id);
    postToOpenWindows("catalog-", e.data);
  } else if (e.data.type === "beacon:foundryImported") {
    // Импорт пакета Foundry (foundry-import.js) заводит сцены и сам пакет в
    // списке установленных. Сцены приезжают сокетом сами (см.
    // room.go: broadcastSceneList), а раздел "Настройки" читается только
    // HTTP-ом при открытии панели — освежаем его здесь, иначе до F5 висел бы
    // старый список.
    foundryModulesUpdates = null; // версии, проверенные ДО импорта, теперь врут
    refreshOpenPanel("settings");
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
  // Вшитый каталог прячем, пока в "Настройках" не включён показ встроенных
  // карточек (см. showBuiltinCardsToggle) — геттер, чекбокс синкается сервером.
  excludeBuiltin: () => !document.getElementById("showBuiltinCardsToggle").checked,
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
    // followBtn — только у встроенной панели: колонка-док есть на этой
    // странице и нигде больше (см. combat-panel.js: почему кнопки нет в
    // вынесенном окне трекера).
    followBtn: document.getElementById("combatFollowBtn"),
    // вкладки "Инициатива"/"Убитые" (см. combat-panel.js: switchCombatTab) —
    // разметка идентична вынесенному окну трекера (combat-tracker.html).
    tabTrackerBtn: document.getElementById("combatTabTrackerBtn"),
    tabKilledBtn: document.getElementById("combatTabKilledBtn"),
    trackerTab: document.getElementById("combatTrackerTab"),
    killedTab: document.getElementById("combatKilledTab"),
    killedList: document.getElementById("combatKilledList"),
    killedSummary: document.getElementById("combatKilledSummary"),
    killedClearBtn: document.getElementById("combatKilledClearBtn"),
  },
});

// openCardInDock — куда попадает клик по бойцу в трекере и по фишке в
// верхнем оверлее хода. Во время боя статблок нужен открытым постоянно, а
// плавающее окно для этого приходится всё время оттаскивать с карты — та же
// причина, по которой у игрока в доке живёт лист персонажа (см.
// pages/player.js). Кнопка ⧉ в шапке дока переносит карточку в плавающее
// окно, если ДМ хочет её на втором мониторе.
function openCardInDock(target) {
  openSheetDock(document.getElementById("sheetDock"), {
    key: target.key,
    title: target.title,
    url: target.url,
    // Колонка встаёт между панелью рейла и картой и накрывает канвас —
    // плашке статуса надо отъехать правее, ровно как при открытии панели.
    onLayoutChange: () => updateChromeInset(panelWidth),
  });
}
setCardOpener(openCardInDock);

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

// combatHighlightActiveToggle — тот же приём: значение приходит внутри
// "combat_state" (payload.highlightActiveToken, см.
// domain.CombatState.HighlightActiveToken / "set_highlight_active_token" в
// internal/service/room.go) — подсвечивать ли на карте токен бойца, чей
// сейчас ход (см. web/src/vtt/layers/tokens.js: turnRing).
const combatHighlightActiveToggle = document.getElementById("combatHighlightActiveToggle");
document.addEventListener("vtt:combatState", (e) => {
  combatHighlightActiveToggle.checked = e.detail.highlightActiveToken !== false;
});
combatHighlightActiveToggle.onchange = () => {
  vtt.send({ type: "set_highlight_active_token", highlightActiveToken: combatHighlightActiveToggle.checked });
};

// showBuiltinCardsToggle / hideLightMarkersToggle — тот же приём: общие тумблеры
// стола, значение приходит внутри "combat_state" (см. domain.CombatState.
// ShowBuiltinCards / HideLightMarkers, service.combatPayload). showBuiltinCards
// правит дерево справочника и пикеры (compendium-menu.js, combat-panel.js,
// status-palette.js, item-picker хаба лута ниже); hideLightMarkers долетает до
// слоя токенов через vtt/index.js (см. vtt:combatState там).
const showBuiltinCardsToggle = document.getElementById("showBuiltinCardsToggle");
document.addEventListener("vtt:combatState", (e) => {
  showBuiltinCardsToggle.checked = !!e.detail.showBuiltinCards;
});
showBuiltinCardsToggle.onchange = () => {
  vtt.send({ type: "set_show_builtin_cards", showBuiltinCards: showBuiltinCardsToggle.checked });
};

const hideLightMarkersToggle = document.getElementById("hideLightMarkersToggle");
document.addEventListener("vtt:combatState", (e) => {
  hideLightMarkersToggle.checked = e.detail.hideLightMarkers !== false;
});
hideLightMarkersToggle.onchange = () => {
  vtt.send({ type: "set_hide_light_markers", hideLightMarkers: hideLightMarkersToggle.checked });
};

// "🗗 Открыть в окне" — тот же приём, что у журнала (openJournalWindow): вся
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
  if (canvasMenu.style.display === "block" && !canvasMenu.contains(e.target)) closeCanvasMenu();
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
const panelResizer = document.getElementById("panelResizer");
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
  panelResizer.classList.toggle("visible", !!openPanelSection);
  if (openPanelSection) {
    sidePanel.style.flexBasis = panelWidth + "px";
    sidePanel.style.width = panelWidth + "px";
  } else {
    // Ноль ширины — забота CSS (#panel), inline-стиль просто снимаем,
    // иначе он победил бы правило и панель не схлопнулась бы.
    sidePanel.style.flexBasis = "";
    sidePanel.style.width = "";
  }
  updateChromeInset(panelWidth);
  railSectionBtns.forEach((b) => b.classList.toggle("active", b.dataset.section === openPanelSection));
  panelSections.forEach((s) => s.classList.toggle("active", s.dataset.panel === openPanelSection));
  if (opening && openPanelSection && panelOpenHandlers[openPanelSection]) {
    panelOpenHandlers[openPanelSection]();
  }
  // Токены света редактируются на карте ТОЛЬКО пока открыт этот раздел (см.
  // interaction.js: lightEditActive). Событие шлём на каждое переключение
  // раздела, а не только на открытие/закрытие света: уход в любой другой
  // раздел так же выключает режим, как и закрытие панели.
  document.dispatchEvent(new CustomEvent("vtt:lightEditMode", { detail: { active: openPanelSection === "light" } }));
}

// showSidePanelSection — «показать раздел», в отличие от setSidePanelSection
// («переключить»): нужен тем, кто открывает раздел не кликом по рейлу, а по
// событию (значок заметки на карте, возврат в настройки сцены). Раньше там
// звали setSidePanelSection, и если раздел УЖЕ был открыт, вызов его
// закрывал — ровно наоборот тому, чего ждёшь от «открой мне заметку».
function showSidePanelSection(name) {
  if (openPanelSection === name) {
    if (panelOpenHandlers[name]) panelOpenHandlers[name]();
    return;
  }
  setSidePanelSection(name);
}

// refreshOpenPanel — перерисовать раздел, если он открыт ПРЯМО СЕЙЧАС.
// panelOpenHandlers перечитывают данные с сервера, но зовутся только в
// момент открытия — а данные меняются и снаружи: импорт модуля Foundry и
// правка заметки идут в плавающем окне (iframe), которое ничего не знает об
// этой панели и сообщает о себе postMessage'ем (см. слушатель "beacon:*"
// выше). Без этого открытая панель оставалась висеть со старым списком до
// перезагрузки страницы.
function refreshOpenPanel(name) {
  if (openPanelSection === name && panelOpenHandlers[name]) panelOpenHandlers[name]();
}

function closeSidePanel() {
  if (openPanelSection) setSidePanelSection(openPanelSection);
}
railSectionBtns.forEach((b) => (b.onclick = () => setSidePanelSection(b.dataset.section)));
document.querySelectorAll(".panel-close[data-close]").forEach((b) => (b.onclick = closeSidePanel));

// ---- ширина панели: тянется мышью за #panelResizer ----
// Ширину ставим inline'ом на сам #panel: это состояние времени выполнения,
// а не константа темы. Закрытая панель inline-стилей не имеет вовсе — тогда
// работает #panel{flex:0 0 0;width:0} из dm.html и закрытие остаётся
// анимированным. Переживает перезагрузку через localStorage; канвас
// подхватит новую ширину сам — он уже слушает ResizeObserver своего
// родителя (см. vtt/index.js).
const PANEL_WIDTH_KEY = "beacon:dmPanelWidth";
const PANEL_WIDTH_DEFAULT = 300;
const PANEL_WIDTH_MIN = 240;

// panelWidthMax — не больше, чем остаётся от окна за вычетом рейла и
// минимума под сам канвас: иначе панель можно растянуть на весь экран и
// потерять карту, ради которой всё и затевалось.
function panelWidthMax() {
  return Math.max(PANEL_WIDTH_MIN, window.innerWidth - 60 - 320);
}

function applyPanelWidth(px) {
  const w = Math.round(Math.min(Math.max(px, PANEL_WIDTH_MIN), panelWidthMax()));
  if (openPanelSection) {
    sidePanel.style.flexBasis = w + "px";
    sidePanel.style.width = w + "px";
  }
  updateChromeInset(w);
  return w;
}

// updateChromeInset — сколько места слева съели плавающие панели. Канвас
// лежит ПОД рейлом и панелью (см. #canvasWrap в dm.html), сам про них ничего
// не знает, и всё, что центрируется "по карте", обязано узнать это число
// снаружи. Сегодняшний потребитель один — верхний оверлей хода
// (vtt/combat-bar.js): без этого он центрировался по всему окну и наезжал на
// шапку колонки со статблоком. Числа — из тех же margin/border, что в
// dm.html: рейл 14+60, панель 10 + ширина + 2 (рамка), ручка 10.
const RAIL_RIGHT = 74;
function updateChromeInset(width) {
  // Колонка со статблоком (см. openCardInDock) — такой же слой поверх
  // канваса, как рейл и панель, и её ширину ДМ тянет мышью: меряем по факту,
  // а не по константе.
  const dock = document.getElementById("sheetDock");
  const dockWidth = dock && dock.classList.contains("open") ? dock.offsetWidth + 10 : 0;
  const chromeRight = (openPanelSection ? RAIL_RIGHT + 10 + width + 2 + 10 : RAIL_RIGHT) + dockWidth;
  document.dispatchEvent(new CustomEvent("vtt:chromeInset", { detail: { left: chromeRight + 10 } }));
}

let panelWidth = Math.min(Math.max(Number(localStorage.getItem(PANEL_WIDTH_KEY)) || PANEL_WIDTH_DEFAULT, PANEL_WIDTH_MIN), panelWidthMax());
updateChromeInset(panelWidth);
window.addEventListener("resize", () => {
  panelWidth = applyPanelWidth(panelWidth); // окно сузили — подрезать панель под новый максимум
});

panelResizer.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  panelResizer.setPointerCapture(e.pointerId);
  const startX = e.clientX;
  const startWidth = panelWidth;
  document.body.classList.add("panel-resizing");

  const onMove = (ev) => {
    panelWidth = applyPanelWidth(startWidth + (ev.clientX - startX));
  };
  const onUp = () => {
    panelResizer.removeEventListener("pointermove", onMove);
    panelResizer.removeEventListener("pointerup", onUp);
    panelResizer.removeEventListener("pointercancel", onUp);
    document.body.classList.remove("panel-resizing");
    localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth));
  };
  panelResizer.addEventListener("pointermove", onMove);
  panelResizer.addEventListener("pointerup", onUp);
  panelResizer.addEventListener("pointercancel", onUp);
});

panelResizer.addEventListener("dblclick", () => {
  panelWidth = applyPanelWidth(PANEL_WIDTH_DEFAULT);
  localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth));
});

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

// ================= список источников света на карте =================
// Токен света ничем не подписан на карте (см. layers/tokens.js — у него нет
// label, только иконка лампочки), поэтому единственный способ понять, что
// именно расставлено по сцене и где, — этот список. Он же закрывает три
// вещи, которых у света не было вовсе: имя источника, быстрый тумблер
// вкл/выкл без поиска токена мышью и «найди мне его» (кнопка 🎯 — камера
// едет к источнику и подсвечивает его, см. map-objects.js).
const lightList = document.getElementById("lightList");

// lightTokensSorted — источники текущей сцены в стабильном порядке. Ключи
// объекта tokens приходят с сервера в порядке обхода Go-мапы, то есть в
// РАЗНОМ на каждый снапшот: без сортировки список бы перетасовывался сам
// собой на каждое движение любого токена на карте.
function lightTokensSorted() {
  return Object.entries(vtt.getScene().tokens || {})
    .filter(([, t]) => t.lightOnly)
    .sort((a, b) => (a[1].label || "").localeCompare(b[1].label || "", "ru") || a[0].localeCompare(b[0]));
}

// sendLightToken — сохранить правку источника целиком (сервер делает апсерт
// по id, см. service.Room.applyMutation "move_token"). Читаем токен из
// ЖИВОЙ сцены, а не из замыкания строки списка: между отрисовкой списка и
// кликом сцена приходит с сервера ещё много раз.
function sendLightToken(id, patch) {
  const t = (vtt.getScene().tokens || {})[id];
  if (!t) return;
  vtt.send({ type: "move_token", token: { ...t, ...patch } });
}

function renderLightList() {
  // Пока ДМ ПЕЧАТАЕТ имя источника прямо в списке, перерисовка съела бы
  // фокус и половину слова — снапшоты со сцены прилетают на каждый чужой
  // драг токена. Ждём, пока поле отпустят (см. onblur ниже).
  //
  // Проверять надо ИМЕННО поле имени, а не "фокус где-то внутри списка":
  // браузер отдаёт фокус и обычной <button> по клику, поэтому широкая
  // проверка намертво замораживала список после первого же нажатия на
  // лампочку или замок — состояние вкл/выкл и замок в строке переставали
  // обновляться вообще (на самой карте при этом всё работало, что и делало
  // симптом таким странным).
  const editing = document.activeElement;
  if (editing && lightList.contains(editing) && editing.classList.contains("light-row-name")) return;
  // Строки пересоздаются целиком, значит нажатая кнопка сейчас будет
  // уничтожена вместе с фокусом на ней. Мышь этого не замечает (курсор
  // остаётся над новой кнопкой на том же месте), а вот Tab-навигация
  // выкидывала бы в начало страницы после каждого щелчка — поэтому
  // запоминаем "чья это была кнопка" и возвращаем фокус на её замену.
  const refocus = editing && lightList.contains(editing) && editing.dataset && editing.dataset.lightBtn
    ? { id: editing.dataset.lightId, btn: editing.dataset.lightBtn }
    : null;
  lightList.innerHTML = "";
  const rows = lightTokensSorted();
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "На сцене пока нет источников света.";
    lightList.appendChild(empty);
    return;
  }
  for (const [id, t] of rows) {
    const on = !!(t.light && t.light.enabled);
    const locked = !!t.locked;
    const row = document.createElement("div");
    row.className = "light-row" + (on ? "" : " off") + (locked ? " locked" : "");

    const name = document.createElement("input");
    name.className = "light-row-name";
    name.value = t.label || "Источник света";
    name.title = "Название источника — видно только ДМ";
    name.disabled = locked; // запертый не правится даже здесь — см. требование к замку
    name.onblur = () => {
      const next = name.value.trim() || "Источник света";
      if (next !== (t.label || "")) sendLightToken(id, { label: next });
      else renderLightList();
    };
    name.onkeydown = (e) => {
      if (e.key === "Enter") name.blur();
      if (e.key === "Escape") {
        name.value = t.label || "Источник света";
        name.blur();
      }
    };

    const radii = document.createElement("span");
    radii.className = "light-row-radii";
    radii.textContent = `${(t.light && t.light.bright) || 0}/${(t.light && t.light.dim) || 0}`;
    radii.title = "Радиусы яркого/тусклого света в единицах линейки сцены";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = on ? "on" : "";
    toggle.innerHTML = icon("bulb", { size: 14 });
    toggle.title = on ? "Потушить источник" : "Зажечь источник";
    toggle.disabled = locked;
    toggle.dataset.lightId = id;
    toggle.dataset.lightBtn = "toggle";
    toggle.onclick = () => document.dispatchEvent(new CustomEvent("vtt:toggleTokenLight", { detail: { id } }));

    // Фокусировка работает и на запертом источнике: она ничего не меняет в
    // мире, только наводит камеру — ровно то, ради чего замок и ставят
    // («стоит на месте, но я хочу его найти»).
    const focusBtn = document.createElement("button");
    focusBtn.type = "button";
    focusBtn.innerHTML = icon("target", { size: 14 });
    focusBtn.title = "Показать на карте — камера наведётся и подсветит источник";
    focusBtn.dataset.lightId = id;
    focusBtn.dataset.lightBtn = "focus";
    focusBtn.onclick = () => document.dispatchEvent(new CustomEvent("vtt:focusMapObject", { detail: { kind: "token", id } }));

    const lockBtn = document.createElement("button");
    lockBtn.type = "button";
    lockBtn.className = locked ? "on" : "";
    lockBtn.innerHTML = icon("lock", { size: 14 });
    lockBtn.title = locked ? "Снять замок — источник снова двигается и правится" : "Запереть — источник не двигается и не правится, пока замок не снят";
    lockBtn.dataset.lightId = id;
    lockBtn.dataset.lightBtn = "lock";
    lockBtn.onclick = () =>
      document.dispatchEvent(new CustomEvent("vtt:setMapObjectLocked", { detail: { kind: "token", id, locked: !locked } }));

    row.append(name, radii, toggle, focusBtn, lockBtn);
    lightList.appendChild(row);
  }

  if (refocus) {
    const again = lightList.querySelector(
      `[data-light-id="${CSS.escape(refocus.id)}"][data-light-btn="${refocus.btn}"]`
    );
    // Кнопка могла и не появиться заново (источник удалили, или замок
    // сделал её disabled) — тогда просто оставляем фокус там, куда его
    // увёл браузер.
    if (again && !again.disabled) again.focus();
  }
}

onPanelOpen("light", renderLightList);
document.addEventListener("vtt:sceneUpdated", () => {
  if (openPanelSection === "light") renderLightList();
});

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
    del.onclick = async (ev) => {
      ev.stopPropagation();
      if (!(await showConfirm(`Удалить сцену «${s.name}»?`, { title: "Удалить сцену", okLabel: "Удалить", danger: true, hint: "Это необратимо." }))) return;
      vtt.send({ type: "delete_scene", sceneId: s.id });
    };
    row.append(handle, nameSpan, viewers, del);
    sceneDropdown.appendChild(row);
  }
}

// "+ Сцена" теперь статична в шапке панели (dm.html), а не пересоздаётся
// каждый renderSceneDropdown() — обработчик вешаем один раз.
document.getElementById("sceneCreateBtn").onclick = async () => {
  const name = await showPrompt("Название сцены:", { title: "Новая сцена", value: "Новая сцена", okLabel: "Создать" });
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
    showAlert("Не удалось прочитать размер фона — проверь URL.");
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
document.getElementById("sceneDeleteBtn").onclick = async () => {
  if (sceneList.length <= 1) return;
  const s = sceneList.find((x) => x.id === currentSceneId);
  if (!(await showConfirm(`Удалить сцену «${s ? s.name : currentSceneId}»?`, { title: "Удалить сцену", okLabel: "Удалить", danger: true, hint: "Это необратимо." }))) return;
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
