// Перенос inline-скрипта static/player.html — механически, DOM/HTTP-логика
// не менялась, только глобальные вызовы app.js заменены на импорты.
import { initVTT } from "../vtt/index.js";
import { initDiceRoller } from "../dice.js";
import { openFloatingWindow, postToOpenWindows } from "../floating-window.js";
import {
  fetchMe,
  apiLogout,
  fetchVersion,
  fetchCharacters,
  createCharacter,
  updateCharacterApi,
  deleteCharacterApi,
  uploadFile,
} from "../api.js";
import { icon } from "../icons.js";
import { showLootTakeModal } from "../loot-take-modal.js";
import { mountCompendiumMenu } from "../compendium-menu.js";

// openCharacterSheet — лист персонажа по умолчанию открывается ВНУТРИ
// страницы плавающим окном (см. floating-window.js), как в Foundry; 🗗 в его
// шапке выносит в настоящее отдельное окно браузера для тех, кому нужно
// держать лист на втором мониторе отдельно от стола.
function openCharacterSheet(c) {
  openFloatingWindow({ key: "char-" + c.id, title: c.name, url: `/character-sheet.html?id=${c.id}` });
}

let me = null;
let pendingAvatarUrl = "";
let editingCharId = null; // null — форма создаёт нового; иначе — id редактируемого
// vtt — модульная переменная (не const внутри boot), тем же приёмом, что и
// pages/dm.js: let vtt — нужна за пределами boot() обработчикам, которые
// регистрируются на верхнем уровне модуля (см. lootHubBtn/vtt:tokenLootRequest
// ниже), а не только внутри самого boot().
let vtt = null;

(async function boot() {
  me = await fetchMe();
  if (!me || me.role !== "player") {
    location.href = "/";
    return;
  }
  document.getElementById("topbarUsername").textContent = me.username;
  document.getElementById("app").classList.add("ready");

  vtt = await initVTT({ canvasId: "scene", role: "player", playerId: me.id });
  initDiceRoller(document.getElementById("diceDock"), vtt.send);
  // Справочник — та же боковая колонка канваса, что и у ДМ (см. pages/dm.js —
  // тот же sticky, см. комментарий там), первая иконка тут (игрок кубы
  // бросает через #diceDock снизу, не через sideMenu).
  const compendiumPanel = vtt.sideMenu.addIcon(icon("book-open", { size: 16 }), "Справочник", { width: 320, sticky: true });
  mountCompendiumMenu(compendiumPanel, { role: "player" });

  document.addEventListener("vtt:authFailed", () => {
    document.getElementById("authFailedOverlay").classList.add("open");
    setTimeout(() => (location.href = "/"), 1500);
  });
})();

document.getElementById("logoutBtn").onclick = async () => {
  await apiLogout();
  location.href = "/";
};

// ================= "Линейка" =================
// Единственный "инструмент" карты, доступный игроку (см. web/src/vtt/
// interaction.js: ветка ctx.isPlayer слушает то же "vtt:setTool", что и ДМ)
// — ЛКМ-драг по карте показывает линию и расстояние в формате текущей
// сцены, отпустил — замер исчезает.
const rulerBtn = document.getElementById("rulerBtn");
let rulerOn = false;
rulerBtn.onclick = () => {
  rulerOn = !rulerOn;
  rulerBtn.classList.toggle("active", rulerOn);
  document.dispatchEvent(new CustomEvent("vtt:setTool", { detail: rulerOn ? "ruler" : "select" }));
};

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

async function renderChars() {
  let chars;
  try {
    chars = await fetchCharacters();
  } catch (err) {
    charsList.textContent = "Не удалось загрузить: " + err.message;
    return;
  }
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
  if (!confirm(`Удалить персонажа «${c.name}»?`)) return;
  try {
    await deleteCharacterApi(c.id);
    if (editingCharId === c.id) resetCharForm();
    await renderChars();
  } catch (err) {
    alert("Не удалось удалить: " + err.message);
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
    openFloatingWindow({ key: e.data.key, title: e.data.title, url: e.data.url });
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
