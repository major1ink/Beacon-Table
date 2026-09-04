// Перенос inline-скрипта static/player.html — механически, DOM/HTTP-логика
// не менялась, только глобальные вызовы app.js заменены на импорты.
import { initVTT } from "../vtt/index.js";
import { initDiceRoller } from "../dice.js";
import { createRollLog } from "../roll-log.js";
import { openFloatingWindow, postToOpenWindows, isFloatingWindowOpen } from "../floating-window.js";
import { openSheetDock } from "../sheet-dock.js";
import { setCardOpener } from "../combatant-card.js";
import {
  fetchMe,
  apiLogout,
  fetchVersion,
  fetchCharacters,
  createCharacter,
  updateCharacterApi,
  deleteCharacterApi,
  uploadFile,
  fetchPregens,
  claimPregen,
} from "../api.js";
import { icon } from "../icons.js";
import { showLootTakeModal } from "../loot-take-modal.js";
import { mountCompendiumMenu } from "../compendium-menu.js";
import { initShowcaseOverlay } from "../showcase-overlay.js";
import { showAlert, showConfirm } from "../modal.js";
import { createDrawOptions } from "../draw-options.js";
import { createBoardList } from "../board-list.js";
import { attachTooltip } from "../tooltip.js";
import { TOOL_HELP, PANEL_HELP } from "../tool-help.js";
import { isPlayer } from "../roles.js";

// openCharacterSheet — лист персонажа у игрока по умолчанию открывается в
// БОКОВОЙ КОЛОНКЕ слева от карты (см. sheet-dock.js): за столом лист держат
// открытым всю игру (ХП, ячейки, ресурсы отмечают по ходу боя), и плавающее
// окно для этого приходилось бы постоянно оттаскивать с карты. Кнопка ⧉ в
// шапке дока переносит тот же лист в плавающее окно (floating-window.js), а
// уже оттуда 🗗 — в настоящее отдельное окно браузера, для второго монитора.
//
// Если этот персонаж УЖЕ вынесен в плавающее окно, клик по чипу не тащит его
// обратно в док, а просто поднимает окно наверх — openFloatingWindow с тем
// же key делает ровно это.
function openCharacterSheet(c) {
  const key = "char-" + c.id;
  const url = `/character-sheet.html?id=${c.id}`;
  if (isFloatingWindowOpen(key)) {
    openFloatingWindow({ key, title: c.name, url });
    return;
  }
  openSheetDock(document.getElementById("sheetDock"), {
    key,
    title: c.name,
    url,
    // Док отнимает ширину у карты — канвас должен перемериться сразу, а не
    // ждать, пока сработает ResizeObserver внутри vtt (см. vtt/index.js:
    // "vtt:relayout" — там же, почему на один только наблюдатель полагаться
    // нельзя).
    onLayoutChange: () => document.dispatchEvent(new CustomEvent("vtt:relayout")),
  });
}

// Клик по фишке в верхнем оверлее хода (vtt/combat-bar.js) открывает лист
// там же, где его открывает чип в топбаре — в боковом доке (или поднимает
// уже вынесенное окно). Игроку оттуда может прийти только ЕГО персонаж:
// права решает combatant-card.js, здесь только место показа.
setCardOpener((target, cmb) => openCharacterSheet({ id: cmb.characterId, name: cmb.name }));

// renderCharDock — ряд компактных "чипов" своих персонажей в топбаре (см.
// player.html: #charDock): аватар + имя, клик открывает лист. Раньше до
// листа надо было идти через модалку "Мои персонажи" — а лист за игру
// открывают чаще, чем правят список персонажей. Модалка остаётся местом,
// где персонажей заводят/правят/удаляют, док — местом, где их открывают.
// chars — уже загруженный список, если он у вызывающего есть (renderChars),
// иначе тянем сами.
async function renderCharDock(chars) {
  const dock = document.getElementById("charDock");
  let list = chars;
  if (!list) {
    try {
      list = await fetchCharacters();
    } catch {
      return; // сеть моргнула — оставляем прошлый ряд, он не мешает
    }
  }
  dock.innerHTML = "";
  for (const c of list) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "char-chip";
    chip.title = `${c.name} — открыть лист персонажа`;
    const avatar = document.createElement("span");
    avatar.className = "char-chip-avatar";
    // Видео-аватар (webm/mp4 токен-арт) как background не покажется —
    // такому персонажу оставляем ту же букву-заглушку, что и безаватарному.
    if (c.avatarUrl && !isVideoUrl(c.avatarUrl)) avatar.style.backgroundImage = `url("${c.avatarUrl}")`;
    else avatar.textContent = (c.name || "?").trim().charAt(0).toUpperCase();
    const name = document.createElement("span");
    name.className = "char-chip-name";
    name.textContent = c.name;
    chip.append(avatar, name);
    chip.onclick = () => openCharacterSheet(c);
    dock.appendChild(chip);
  }
}

let me = null;
let pendingAvatarUrl = "";
let editingCharId = null; // null — форма создаёт нового; иначе — id редактируемого
// vtt — модульная переменная (не const внутри boot), тем же приёмом, что и
// pages/dm.js: let vtt — нужна за пределами boot() обработчикам, которые
// регистрируются на верхнем уровне модуля (см. lootHubBtn/vtt:tokenLootRequest
// ниже), а не только внутри самого boot().
let vtt = null;

// drawPanel появляется только в boot(), когда есть vtt.sideMenu, а
// переключатель инструментов нужен раньше — отсюда изменяемая ссылка.
let drawPanel = null;
// closingDrawPanel — панель закрываем МЫ, потому что уходим на другой
// инструмент. Без этого флага закрытие дёргало бы свой onToggle, тот звал
// бы setPlayerTool("select") посреди уже идущего setPlayerTool("ruler"), и
// линейка включалась бы с погашенной кнопкой и сбитым playerTool.
let closingDrawPanel = false;

// PLAYER_DRAW_HELP — подсказка у игрока своя: про чужие пометки и про то,
// что право рисовать выдаёт ДМ, ему знать полезнее, чем про «Настройки»,
// которых у него нет.
const PLAYER_DRAW_HELP = {
  title: "Пометки",
  summary: "Быстрые пометки поверх карты: стрелка, круг, подпись. Видны всем за столом.",
  rows: [
    ["Цвет", "твой собственный — за столом видно, чья пометка"],
    ["Правка", "пока фигура не выбрана — тяни свои пометки"],
    ["Рисование", "выбери фигуру в панели"],
    ["Удаление", "«Ластик» или [ПКМ] по своей пометке"],
    ["Чужие", "трогать нельзя — только свои"],
  ],
};

(async function boot() {
  me = await fetchMe();
  if (!me || !isPlayer(me.role)) {
    location.href = "/";
    return;
  }
  document.getElementById("topbarUsername").textContent = me.username;
  document.getElementById("app").classList.add("ready");

  // Лоток кубов — ДО initVTT, и отдельным контейнером от лога: сам лоток
  // строкой в доке внизу, лог — плавающей плашкой над картой (см.
  // player.html), чтобы высота дока не прыгала от каждого броска. Порядок
  // важен: док задаёт высоту, которая остаётся канвасу, а Pixi снимает её
  // ровно один раз, внутри app.init() (см. vtt/index.js). Отправка идёт
  // через замыкание на vtt — до конца boot() кликать всё равно негде.
  initDiceRoller(document.getElementById("diceDock"), (msg) => vtt.send(msg));
  const rollLog = createRollLog(document.getElementById("diceLog"), { layout: "plate" });
  document.addEventListener("vtt:rollResult", (e) => rollLog.push(e.detail));
  renderCharDock();

  vtt = await initVTT({
    canvasId: "scene",
    role: "player",
    playerId: me.id,
    // Трекер инициативы встраивается в топбар (см. player.html), а не
    // плавает отдельным оверлеем поверх него (см. vtt/index.js/combat-bar.js).
    combatBarMount: document.getElementById("combatBarMount"),
  });
  // Справочник — та же боковая колонка канваса, что и у ДМ (см. pages/dm.js —
  // тот же sticky, см. комментарий там), первая иконка тут (игрок кубы
  // бросает через #diceDock снизу, не через sideMenu — у него это основной
  // инструмент, и он всегда на виду, а не за иконкой).
  const compendiumPanel = vtt.sideMenu.addIcon(icon("book-open", { size: 16 }), "Справочник", { width: 320, sticky: true, tip: PANEL_HELP.compendium });
  mountCompendiumMenu(compendiumPanel, { role: "player" });

  // Пометки — та же иконка и та же панель, что у ДМ (см. pages/dm.js и
  // web/src/draw-options.js), только без кнопки «Очистить слой»: она стирает
  // и чужое, сервер её от игрока всё равно не примет.
  //
  // Открытая панель = включённый инструмент, как у ДМ: закрыли её (своей
  // иконкой, Esc, другой иконкой колонки) — вернулись в «Выбор».
  drawPanel = vtt.sideMenu.addIcon(icon("pencil", { size: 16 }), "Пометки", {
    width: 250,
    keepOnCanvas: true,
    tip: PLAYER_DRAW_HELP,
    onToggle: (open) => {
      if (!open && (closingDrawPanel || playerTool !== "draw")) return;
      setPlayerTool(open ? "draw" : "select");
    },
  });
  const drawOptions = createDrawOptions(drawPanel);
  const drawHint = document.createElement("p");
  drawHint.className = "draw-hint";
  drawHint.textContent = "Наведи на фигуру — подскажет, каким жестом она рисуется.";
  drawPanel.appendChild(drawHint);
  // Иконки нет, пока ДМ не разрешил игрокам рисовать (см.
  // domain.CombatState.PlayerDrawingEnabled): выключил посреди сессии —
  // инструмент сам возвращается в «Выбор».
  drawPanel.host.style.display = "none";
  document.addEventListener("vtt:combatState", (e) => {
    const allowed = !!e.detail.playerDrawingEnabled;
    drawPanel.host.style.display = allowed ? "" : "none";
    if (!allowed && playerTool === "draw") {
      setPlayerTool("select");
      drawOptions.reset();
    }
  });
  // Доски — тот же список, что у ДМ (см. board-list.js). Игрок заводит свои
  // и видит те чужие, которые ему открыли: разбирается с этим сервер, панель
  // одинаковая.
  const boardsPanel = vtt.sideMenu.addIcon(icon("board", { size: 16 }), "Доски", {
    width: 280,
    sticky: true,
    tip: PANEL_HELP.boards,
    // Список перечитывается на открытии панели, а не подпиской: доски
    // заводят редко, и держать ради этого ещё один канал незачем.
    onToggle: (open) => {
      if (open) boardList.refresh();
    },
  });
  const boardList = createBoardList(boardsPanel);
  const boardsClose = document.createElement("button");
  boardsClose.type = "button";
  boardsClose.className = "board-item-btn";
  boardsClose.style.cssText = "position:absolute;right:8px;top:8px;";
  boardsClose.title = "Закрыть";
  boardsClose.innerHTML = icon("close", { size: 13 });
  boardsClose.onclick = () => boardsPanel.close();
  boardsPanel.style.position = "relative";
  boardsPanel.appendChild(boardsClose);

  // Журнал стола — та же страница, что и у ДМ (см. web/journal.html):
  // игрок пишет туда свои заметки и сам решает, кому их видно и кому можно
  // править. Кнопка, а не панель: журнал — полноценное окно, ему тесно в
  // выезжающей плашке бокового меню.
  vtt.sideMenu.addButton(icon("scroll", { size: 16 }), "Журнал стола", openJournalWindow, { tip: PANEL_HELP.journal });

  // Картинка «Показать игрокам» от ДМ — полноэкранный оверлей поверх карты
  // (см. web/src/showcase-overlay.js). Закрыть игрок не может, показом
  // управляет ДМ.
  initShowcaseOverlay({ role: "player" });

  document.addEventListener("vtt:authFailed", () => {
    document.getElementById("authFailedOverlay").classList.add("open");
    setTimeout(() => (location.href = "/"), 1500);
  });
})();

// openJournalWindow — плавающее окно журнала; entryId открывает его сразу
// на нужной записи (так работает «Показать игрокам» со стороны ДМ, см.
// vtt:journalShown ниже).
function openJournalWindow(entryId) {
  openFloatingWindow({
    key: "journal",
    title: "Журнал стола",
    url: "/journal.html" + (entryId ? "?id=" + encodeURIComponent(entryId) : ""),
    // Показ конкретной записи переводит на неё и уже открытое окно журнала
    // (см. navigate в floating-window.js); клик по иконке в меню — просто
    // поднимает окно, ничего не перезагружая.
    navigate: !!entryId,
    width: 900,
    height: 640,
    popoutFeatures: "width=900,height=640",
  });
}

// «Показать игрокам»: ДМ открыл запись журнала у всех за столом (см.
// relayJournalShow в internal/service/room.go). Доступ это не выдаёт — если
// записи игроку не открывали, окно покажет обычную ошибку «не найдено».
document.addEventListener("vtt:journalShown", (e) => openJournalWindow(e.detail.id));

document.getElementById("logoutBtn").onclick = async () => {
  await apiLogout();
  location.href = "/";
};

// ================= HUD зума =================
// Те же кнопки/события, что у ДМ (см. web/src/pages/dm.js) — interaction.js
// слушает vtt:zoomBy/vtt:resetView одинаково для всех трёх ролей, тут только
// не хватало кнопок в разметке (см. web/player.html: #zoomHud).
document.getElementById("zoomInBtn").onclick = () => document.dispatchEvent(new CustomEvent("vtt:zoomBy", { detail: 1.3 }));
document.getElementById("zoomOutBtn").onclick = () => document.dispatchEvent(new CustomEvent("vtt:zoomBy", { detail: 1 / 1.3 }));
document.getElementById("zoomResetBtn").onclick = () => document.dispatchEvent(new CustomEvent("vtt:resetView"));

// ================= инструменты карты =================
// Линейка живёт в топбаре, пометки — иконкой в боковой колонке над канвасом
// (как у ДМ, см. pages/dm.js: там панель тоже уехала из общего списка в
// быстрый доступ). Инструмент один на двоих: включил линейку — пометки
// выключились, и наоборот.
const rulerBtn = document.getElementById("rulerBtn");
let playerTool = "select";
function setPlayerTool(name) {
  playerTool = name;
  rulerBtn.classList.toggle("active", name === "ruler");
  // Панель пометок И ЕСТЬ включённый инструмент (см. её onToggle ниже):
  // ушли на другой инструмент — закрываем её.
  if (name !== "draw" && drawPanel) {
    closingDrawPanel = true;
    drawPanel.close();
    closingDrawPanel = false;
  }
  document.dispatchEvent(new CustomEvent("vtt:setTool", { detail: name }));
}

rulerBtn.onclick = () => setPlayerTool(playerTool === "ruler" ? "select" : "ruler");
attachTooltip(rulerBtn, TOOL_HELP.ruler);

// ================= "Настройки" =================
// Пока единственное поле — версия сервера (short commit hash, см.
// cmd/beacon-table/version.go); раздел заведён отдельно, чтобы будущим
// общим настройкам приложения было куда встать.
const settingsOverlay = document.getElementById("settingsOverlay");
document.getElementById("settingsBtn").onclick = async () => {
  settingsOverlay.classList.add("open");
  const el = document.getElementById("appVersion");
  try {
    const { version } = await fetchVersion();
    el.textContent = version;
  } catch {
    el.textContent = "неизвестна";
  }
};
document.getElementById("settingsCloseBtn").onclick = () => settingsOverlay.classList.remove("open");
settingsOverlay.addEventListener("mousedown", (e) => {
  if (e.target === settingsOverlay) settingsOverlay.classList.remove("open");
});

// ================= "Мои персонажи" =================
const charsOverlay = document.getElementById("charsOverlay");
const charsList = document.getElementById("charsList");
const charName = document.getElementById("charName");
const charAvatarUpload = document.getElementById("charAvatarUpload");
const charAvatarPreviewWrap = document.getElementById("charAvatarPreviewWrap");
const charAvatarPreview = document.getElementById("charAvatarPreview");
const charAvatarPreviewVideo = document.getElementById("charAvatarPreviewVideo");

// isVideoUrl — та же проверка по расширению, что и в web/src/geometry.js —
// своя копия, страница не подключает vtt-модуль ради одной функции.
function isVideoUrl(url) {
  return /\.(mp4|webm|m4v)(\?|#|$)/i.test(url || "");
}
function showAvatarPreview(url) {
  if (!url) {
    charAvatarPreviewWrap.style.display = "none";
    return;
  }
  if (isVideoUrl(url)) {
    charAvatarPreview.style.display = "none";
    charAvatarPreviewVideo.style.display = "block";
    charAvatarPreviewVideo.src = url;
  } else {
    charAvatarPreviewVideo.style.display = "none";
    charAvatarPreviewVideo.removeAttribute("src");
    charAvatarPreview.style.display = "block";
    charAvatarPreview.src = url;
  }
  charAvatarPreviewWrap.style.display = "block";
}
const charSaveBtn = document.getElementById("charSaveBtn");
const charCancelEditBtn = document.getElementById("charCancelEditBtn");
const charFormMsg = document.getElementById("charFormMsg");

function resetCharForm() {
  editingCharId = null;
  pendingAvatarUrl = "";
  charName.value = "";
  charAvatarUpload.value = "";
  charAvatarPreviewWrap.style.display = "none";
  charSaveBtn.textContent = "Создать персонажа";
  charCancelEditBtn.style.display = "none";
  charFormMsg.textContent = "";
}

// renderPregens — блок «Готовые персонажи приключения» над списком своих:
// свободные предгенерированные листы из импортированного модуля (см.
// internal/domain/pregen.go). «Взять» создаёт из шаблона обычного персонажа,
// принадлежащего игроку, — он тут же появляется в списке ниже и в доке.
// Пул пуст → блок скрыт целиком.
async function renderPregens() {
  const block = document.getElementById("pregensBlock");
  const list = document.getElementById("pregensList");
  let pregens = [];
  try {
    pregens = await fetchPregens();
  } catch {
    /* нет пула / сеть моргнула — просто не показываем блок */
  }
  list.innerHTML = "";
  if (!pregens.length) {
    block.style.display = "none";
    return;
  }
  block.style.display = "";
  for (const p of pregens) {
    const row = document.createElement("div");
    row.className = "char-row";
    const avatar = document.createElement("div");
    avatar.className = "char-avatar";
    if (p.avatarUrl && !isVideoUrl(p.avatarUrl)) avatar.style.backgroundImage = `url("${p.avatarUrl}")`;
    else avatar.textContent = (p.name || "?").trim().charAt(0).toUpperCase();
    const nameWrap = document.createElement("div");
    nameWrap.className = "char-name";
    nameWrap.textContent = p.name;
    const sub = [p.species, p.class && `${p.class}${p.level ? ` ${p.level} ур.` : ""}`].filter(Boolean).join(", ");
    if (sub) {
      const subEl = document.createElement("div");
      subEl.className = "char-sub";
      subEl.textContent = sub;
      nameWrap.appendChild(subEl);
    }
    const sheetBtn = document.createElement("button");
    sheetBtn.innerHTML = icon("scroll", { size: 13 });
    sheetBtn.title = "Посмотреть лист (без выбора)";
    sheetBtn.onclick = () =>
      openFloatingWindow({ key: "pregen-" + p.id, title: p.name, url: `/character-sheet.html?pregen=${p.id}` });
    const takeBtn = document.createElement("button");
    takeBtn.textContent = "Взять";
    takeBtn.onclick = async () => {
      takeBtn.disabled = true;
      try {
        await claimPregen(p.id);
        await renderChars();
      } catch (err) {
        takeBtn.disabled = false;
        showAlert("Не удалось взять персонажа: " + err.message);
      }
    };
    row.append(avatar, nameWrap, sheetBtn, takeBtn);
    list.appendChild(row);
  }
}

async function renderChars() {
  await renderPregens();
  let chars;
  try {
    chars = await fetchCharacters();
  } catch (err) {
    charsList.textContent = "Не удалось загрузить: " + err.message;
    return;
  }
  renderCharDock(chars);
  charsList.innerHTML = "";
  if (chars.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "opacity:0.6;font-size:12px;margin-bottom:10px;";
    empty.textContent = "Персонажей пока нет — заведи первого ниже.";
    charsList.appendChild(empty);
  }
  for (const c of chars) {
    const row = document.createElement("div");
    row.className = "char-row";
    const avatar = document.createElement("div");
    avatar.className = "char-avatar";
    if (c.avatarUrl) avatar.style.backgroundImage = `url("${c.avatarUrl}")`;
    else avatar.textContent = "—";
    const name = document.createElement("div");
    name.className = "char-name";
    name.textContent = c.name;
    const sheetBtn = document.createElement("button");
    sheetBtn.innerHTML = icon("scroll", { size: 13 });
    sheetBtn.title = "Лист персонажа";
    sheetBtn.onclick = () => openCharacterSheet(c);
    const editBtn = document.createElement("button");
    editBtn.innerHTML = icon("pencil", { size: 13 });
    editBtn.title = "Редактировать";
    editBtn.onclick = () => startEditChar(c);
    const delBtn = document.createElement("button");
    delBtn.className = "danger";
    delBtn.innerHTML = icon("trash", { size: 13 });
    delBtn.title = "Удалить";
    delBtn.onclick = () => deleteChar(c);
    row.append(avatar, name, sheetBtn, editBtn, delBtn);
    charsList.appendChild(row);
  }
}

function startEditChar(c) {
  editingCharId = c.id;
  pendingAvatarUrl = c.avatarUrl || "";
  charName.value = c.name;
  charAvatarUpload.value = "";
  showAvatarPreview(c.avatarUrl || "");
  charSaveBtn.textContent = "Сохранить изменения";
  charCancelEditBtn.style.display = "inline-block";
  charFormMsg.textContent = "";
}

async function deleteChar(c) {
  if (!(await showConfirm(`Удалить персонажа «${c.name}»?`, { title: "Удалить персонажа", okLabel: "Удалить", danger: true }))) return;
  try {
    await deleteCharacterApi(c.id);
    if (editingCharId === c.id) resetCharForm();
    await renderChars();
  } catch (err) {
    showAlert("Не удалось удалить: " + err.message);
  }
}

charAvatarUpload.onchange = async () => {
  const file = charAvatarUpload.files[0];
  if (!file) return;
  try {
    const { url } = await uploadFile(file, "tokens");
    pendingAvatarUrl = url;
    showAvatarPreview(url);
  } catch (err) {
    charFormMsg.textContent = "Не удалось загрузить аватар: " + err.message;
  }
};

charSaveBtn.onclick = async () => {
  const name = charName.value.trim();
  if (!name) {
    charFormMsg.textContent = "Введи имя персонажа.";
    return;
  }
  try {
    if (editingCharId) {
      await updateCharacterApi(editingCharId, name, pendingAvatarUrl);
    } else {
      await createCharacter(name, pendingAvatarUrl);
    }
    resetCharForm();
    await renderChars();
  } catch (err) {
    charFormMsg.textContent = err.message;
  }
};
charCancelEditBtn.onclick = resetCharForm;

document.getElementById("charsBtn").onclick = async () => {
  resetCharForm();
  charsOverlay.classList.add("open");
  await renderChars();
};
document.getElementById("charsCloseBtn").onclick = () => charsOverlay.classList.remove("open");
charsOverlay.addEventListener("mousedown", (e) => {
  if (e.target === charsOverlay) charsOverlay.classList.remove("open");
});

// ================= Компендиум (см. compendium-menu.js/catalog.js) =================
// Заклинания/Предметы/Справочник переехали из topbar-модалок в один
// плавающий список категорий на правой колонке канваса (иконка монтируется в
// boot(), см. vtt.sideMenu.addIcon ниже) — тот же компонент, что и у ДМ (см.
// pages/dm.js — идентичный блок, те же два моста, см. комментарий там).
window.addEventListener("message", (e) => {
  if (e.origin !== location.origin || !e.data) return;
  if (e.data.type === "beacon:openFloatingWindow") {
    openFloatingWindow({ key: e.data.key, title: e.data.title, url: e.data.url, navigate: !!e.data.navigate });
  } else if (
    e.data.type === "beacon:spellSaved" ||
    e.data.type === "beacon:itemSaved" ||
    e.data.type === "beacon:referenceSaved"
  ) {
    postToOpenWindows("catalog-", e.data);
  }
});

// ================= "Хаб" (domain.LootHub) и лут трупов =================
// Хаб — общий стол ДМ (см. internal/service/room.go: hubPayload), приходит
// по WS ("hub_state" → "vtt:hubState", см. vtt/net.js), тем же принципом,
// что и трекер инициативы. Лут трупа — снимок Token.Loot конкретного мёртвого
// токена (см. domain.Token.Loot), инициируется ПКМ по костям на карте (см.
// web/src/vtt/interaction.js: ветка ctx.isPlayer, событие "vtt:tokenLootRequest").
// Оба используют один и тот же компонент loot-take-modal.js — только разный
// набор entries/WS-команда на "забрать".
let latestHub = [];
document.addEventListener("vtt:hubState", (e) => {
  latestHub = e.detail || [];
});

// myCharactersForLoot — свои персонажи для выбора получателя в модалке (см.
// loot-take-modal.js: characters) — свежий список на каждое открытие, тем же
// принципом, что myCharacters у "Заклинаний" (панель могла поменяться, пока
// стол открыт).
async function myCharactersForLoot() {
  try {
    const chars = await fetchCharacters();
    return chars.map((c) => ({ id: c.id, name: c.name }));
  } catch {
    return [];
  }
}

document.getElementById("lootHubBtn").onclick = async () => {
  const characters = await myCharactersForLoot();
  showLootTakeModal({
    title: "Хаб",
    entries: latestHub,
    characters,
    onTake: (entryId, quantity, characterId) => {
      vtt.send({ type: "hub_take_item", entryId, characterId, quantity });
      return Promise.resolve();
    },
  });
};

// vtt:tokenLootRequest — диспатчится interaction.js при ПКМ по мёртвому
// токену с непустым Loot (и только пока ДМ включил
// CombatState.LootingEnabled — сервер это всё равно перепроверит сам в
// handleLootTakeItem, тут только не показываем кнопку/меню зря).
document.addEventListener("vtt:tokenLootRequest", async (e) => {
  const { tokenId, loot, name } = e.detail;
  const characters = await myCharactersForLoot();
  showLootTakeModal({
    title: "Труп: " + (name || "монстр"),
    entries: loot,
    characters,
    onTake: (entryId, quantity, characterId) => {
      vtt.send({ type: "loot_take_item", tokenId, entryId, characterId, quantity });
      return Promise.resolve();
    },
  });
});
