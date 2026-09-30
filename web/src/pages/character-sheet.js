// Лист персонажа D&D 2024 (PHB 2024, стиль бланка "Long Story Short") —
// отдельное окно, открывается из player.html ("Мои персонажи", кнопка 📜,
// владелец — редактирует) или из dm.html (панель "Персонажи", та же кнопка
// 📜 — ДМ редактирует ЛЮБОЙ лист наравне с владельцем, см. isAdminView
// ниже), по аналогии с note-window.html/note-window.js.
//
// "Умный бланк" (см. README и план реализации): почти все поля — свободный
// ввод, как в бумажном листе. Автоматически считаются только производные
// значения по формулам PHB 2024 — весь rules-блок ниже (abilityMod..spellAtk).
// Сервер (internal/domain/character_sheet.go) эти формулы не знает и не
// проверяет, только хранит присланный JSON целиком.
import {
  fetchMe,
  fetchItems,
  fetchCharacter,
  updateCharacterSheet,
  fetchAdminCharacter,
  updateAdminCharacterSheet,
  fetchCharacterInventory,
  updateCharacterInventoryItem,
  deleteCharacterInventoryItem,
  fetchPregen,
  updateAdminPregen,
  updateCharacterApi,
  updateAdminCharacter,
} from "../api.js";
import { openSocket } from "../ws-reconnect.js";
import { icon } from "../icons.js";
import { parseLssExport, applyLssImport } from "../lss-import.js";
import { normalizeSheet } from "../sheet-normalize.js";
import { enhanceRolls } from "../inline-rolls.js";
import { attachHpDrag, hpColor, hpFillRatios, parseQuickValue } from "../hp-bar.js";
import { renderStatusChips } from "../status-palette.js";
import { applyModifiers, collectModifiers, TARGET_HP_MAX } from "../modifiers.js";
import { showAlert, showConfirm, showPrompt, openModal } from "../modal.js";
import { uploadAvatarFile, recropAvatarUrl, isVideoAvatar } from "../avatar-cropper.js";
import { renderNoteHtml } from "../notes/markdown.js";
import { wireCatalogLinks } from "../catalog-links.js";
import { createRollLog } from "../roll-log.js";
import { isGM, isPlayer } from "../roles.js";
import { initFullscreenButton } from "../fullscreen.js";
import { cssUrl } from "../html.js";
import { withRollMode } from "../roll-mode.js";
import { announceOwnHeader } from "../embed.js";
import { coinRows, formatWeight, hasImporter, loadSystemProfile } from "../system-profile.js";
import { renderSchemaEdit, renderSchemaView } from "../schema-sheet.js";
import { loadSchemas, schemaFor } from "../schemas.js";
import { schemaHasPath } from "../schema-layout.js";
import { compileSchema, createEvaluator } from "../schema-formula.js";
import { cardSubtitle } from "../schema-list.js";
import { getPath, setPath } from "../schema-layout.js";

// ==================== PHB 2024 rules ====================

// ---- применение изменений (см. internal/domain/modifier.go) ----
// Лист и так считает производные числа сам (модификаторы характеристик,
// бонус владения, спасброски, СЛ заклинаний — весь rules-блок вокруг), так
// что надетая экипировка и висящие состояния — просто ещё одно слагаемое в
// том же расчёте. Правил приложение при этом не знает: ЧТО именно даёт
// кольчуга или ослепление, записано в карточке предмета/состояния человеком
// или импортом, а здесь это только складывается.

// activeModifiers — всё, что сейчас действует на персонажа: изменения от
// НАДЕТЫХ предметов инвентаря плюс изменения от наложенных состояний.
// Считается на каждое обращение, а не кэшируется: и то и другое меняется
// прямо во время просмотра листа (галочка «надето», метка из трекера).
function activeModifiers() {
  const equipped = inventory
    .filter((e) => e.equipped && e.itemId && itemCatalog.has(e.itemId))
    .map((e) => ({ name: e.name, modifiers: itemCatalog.get(e.itemId).modifiers }));
  return collectModifiers([...equipped, ...liveStatuses]);
}

function effectiveHPMax(sheet) {
  return applyModifiers(sheet.combat.hpMax || 0, TARGET_HP_MAX, activeModifiers());
}

// ==================== state ====================

let me = null;
let charId = null;
let character = null; // {id, name, avatarUrl, sheet, accountUsername?}
let sheet = null; // character.sheet, нормализованный
// readOnly — управляет ТОЛЬКО disabled-состоянием полей ниже по файлу;
// с тех пор как ДМ тоже полноценно редактирует чужой лист (см. isAdminView),
// это поле никогда не становится true, но название и условия оставлены как
// есть — переписывать каждый `if (readOnly)` в разметке смысла не было бы.
let readOnly = false;
// isAdminView — ДМ смотрит/правит лист ЧУЖОГО персонажа: влияет только на
// подзаголовок с именем игрока, баннер и то, какой из двух PUT-эндпоинтов
// (свой/админский) дёргать при автосохранении, см. doSave().
let isAdminView = false;
// isPregenAdmin — ДМ правит заготовку из пула «Готовые персонажи»
// (character-sheet.html?pregen=<id> под ролью admin, см. dm.js:
// createPregenFlow). Полноценная правка листа, но персонажа ещё нет —
// автосохранение уходит в updateAdminPregen, инвентаря и бросков нет.
let isPregenAdmin = false;
let pregenEditId = null;
let rollWS = null;
let rollLog = null; // общий виджет лога бросков (см. web/src/roll-log.js); null во встроенном листе — там лог показывает стол

// liveStatuses/liveStatusesEl — наложенные состояния этого персонажа (см.
// domain.AppliedStatus): приходят с сервера в combat_state тем же сокетом,
// что и броски (см. connectRollSocket), лист их только показывает.
let liveStatuses = [];
// itemCatalog — карточки библиотеки предметов по id, нужны РОВНО для одного:
// достать Item.Modifiers надетых вещей (см. activeModifiers). Записи
// инвентаря хранят только снимок имени/веса (см. domain.InventoryEntry), а
// цифры «пока надет» должны быть свежими — ДМ поправил кольчугу, и КД
// пересчитался у всех, а не только у новых владельцев.
let itemCatalog = new Map();
let liveStatusesEl = null;

// sheetHasRace — у листа мира поле «Вид» лежит в info.race (D&D 2014), а не
// в info.species: импорт LSS кладёт вид туда.
function sheetHasRace() {
  return schemaHasPath(schemaFor("sheet"), "info.race");
}

// schemaCtx — то, что лист по схеме берёт у этой страницы, а не копирует:
// сохранение, поля ввода, портрет, хиты, инвентарь, деньги, ресурсы,
// состояния, броски, вкладки. Собирается на каждую отрисовку: sheet
// меняется при перезагрузке листа (см. reloadSheet).
function schemaCtx() {
  sheetEvaluator(); // разобрать схему, если ещё не
  return {
    h, data: sheet, readOnly, compiled: compiledSheet,
    field, textareaInput, identitySection,
    scheduleSave, sendRoll, sendResolvedRoll, activeModifiers,
    onRefresh: (fn) => vRefresh.push(fn),
    refresh: refreshView,
    tabPanel,
    vCard, vText, vHero, vHpCard, vXpCard, liveStatusesHost, vResourcesCard, vInventoryCard, vMoneyCard,
  };
}

// tabPanel — панель вкладки правки по id вкладки схемы: "sheet" — «Лист»,
// "portrait" — «Портрет», остальные создаются кнопкой в шапке (см.
// clearSchemaTabs) с подписью title или id.
const PAGE_TABS = { sheet: "1", portrait: "2", inventory: "5" };
function tabPanel(id, title) {
  const n = PAGE_TABS[id] || "x-" + id;
  let panel = document.getElementById("tab" + n);
  if (!panel) {
    panel = h("div", { class: "tab-panel", id: "tab" + n, "data-schema-tab": "" });
    document.getElementById("app").appendChild(panel);
    const btn = h("button", { type: "button", class: "tab-btn", "data-tab": n, "data-schema-tab": "", text: title || id, onclick: () => switchTab(n) });
    document.querySelector("#topBar .tabs").appendChild(btn);
  }
  return panel;
}

// clearSchemaTabs — убрать свои вкладки схемы перед пересборкой правки (и
// вернуться на «Лист», если была открыта одна из них).
function clearSchemaTabs() {
  const active = document.querySelector('.tab-btn.active[data-schema-tab]');
  document.querySelectorAll("[data-schema-tab]").forEach((el) => el.remove());
  if (active) switchTab(1);
}

// ==================== DOM helpers ====================

function h(tag, attrs, children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(children || [])) {
    if (c === undefined || c === null || c === false) continue;
    e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
}

function field(labelText, inputEl) {
  return h("label", { class: "field" }, [h("span", { text: labelText }), inputEl]);
}

function textareaInput(get, set, opts) {
  const t = h("textarea", opts || {});
  t.value = get() ?? "";
  if (readOnly) t.disabled = true;
  else
    t.addEventListener("input", () => {
      set(t.value);
      scheduleSave();
    });
  return t;
}

// renderEditTabs — полная пересборка вкладок правки: при загрузке, после
// импорта из LSS и при возврате из режима чтения (там правятся хиты, ячейки и
// ресурсы — правка должна показать уже новые числа).
function renderEditTabs() {
  for (const n of ["3", "4"]) {
    const btn = document.querySelector(`.tab-btn[data-tab="${n}"]`);
    if (btn) btn.style.display = "none";
    if (btn && btn.classList.contains("active")) switchTab(1);
  }
  clearSchemaTabs();
  renderSchemaEdit(schemaCtx());
  if (hasImporter("lss")) document.getElementById("tab1").prepend(importSection());
}

// ==================== переиспользуемые секции (обе системы/вкладки) ====================

// ==================== импорт из Long Story Short ====================

// applyLssFile — общая точка для файла и вставленного текста: парсит,
// маппит через lss-import.js, мутирует sheet напрямую (applyLssImport), а
// не мержит патч — тот же принцип, что и у остального этого файла (sheet
// правится через геттеры/сеттеры на месте, не иммутабельно). Затрагивает
// поля почти всех 4 вкладок — после успеха перерисовываем всё.
async function applyLssFile(rawText, msgEl) {
  msgEl.classList.remove("error", "ok");
  msgEl.textContent = "";
  let parsed;
  try {
    parsed = parseLssExport(rawText);
  } catch (err) {
    msgEl.textContent = err.message;
    msgEl.classList.add("error");
    return;
  }
  const { name, warnings } = applyLssImport(sheet, parsed, sheetHasRace());
  msgEl.textContent = `Импортировано${name ? `: «${name}»` : ""}.` + (warnings.length ? " " + warnings.join(" ") : "");
  msgEl.classList.add("ok");
  renderEditTabs();
  await saveNow(); // сразу, не дожидаясь debounce — иначе теряется при быстром закрытии
}

function importSection() {
  const msg = h("div", { id: "lssImportMsg" });
  const fileInput = h("input", { type: "file", accept: "application/json,.json" });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) return;
    await applyLssFile(await file.text(), msg);
    fileInput.value = "";
  });
  const textarea = h("textarea", { placeholder: "...или вставь сюда содержимое JSON-файла экспорта", rows: 2 });
  const importBtn = h("button", { type: "button", text: "Импортировать вставленный JSON", onclick: () => applyLssFile(textarea.value, msg) });
  return h("div", { class: "section" }, [
    h("h3", { text: "Импорт из Long Story Short" }),
    h("p", { style: "margin:0 0 8px;color:var(--text-dim);font-size:11px;" }, "На lss экспортируй лист персонажа в JSON и выбери файл ниже (или вставь содержимое текстом). Уже заполненные текстовые поля не затираются — импорт дописывает к ним снизу."),
    field("Файл экспорта", fileInput),
    textarea,
    importBtn,
    msg,
  ]);
}

// ==================== tab 1: лист ====================

// ==================== имя и аватар персонажа ====================
// Правятся здесь — в шапке карточки чтения и на вкладке «Портрет»; в списках
// персонажей (у игрока «Мои персонажи», у ДМ панель «Персонажи») только
// заводят и удаляют. Уходит отдельным запросом, а не с листом: имя и аватар
// лежат в самой записи персонажа (domain.Character), а не в sheet.

// hostWindow — топ-документ стола: лист — плавающее окно-iframe, а вынесенный
// кнопкой 🗗 ведёт наверх через opener (см. catalog-links.js: hostWindow).
function hostWindow() {
  if (window.opener && window.opener !== window) return window.opener;
  return window.parent;
}

async function saveIdentity(patch) {
  const name = String(patch.name !== undefined ? patch.name : character.name || "").trim();
  const avatarUrl = patch.avatarUrl !== undefined ? patch.avatarUrl : character.avatarUrl || "";
  if (!name) {
    await showAlert("Имя персонажа не может быть пустым.");
    return false;
  }
  setSaveStatus("saving");
  try {
    if (isPregenAdmin) {
      // Пре-ген перезаписывается целиком — лист и метку модуля возвращаем как есть (см. doSave).
      await updateAdminPregen(pregenEditId, { name, avatarUrl, foundryModuleId: character.source || "", sheet });
    } else if (isAdminView) {
      await updateAdminCharacter(charId, name, avatarUrl);
    } else {
      await updateCharacterApi(charId, name, avatarUrl);
    }
  } catch (err) {
    setSaveStatus("error", err.message);
    await showAlert("Не удалось сохранить: " + err.message);
    return false;
  }
  character.name = name;
  character.avatarUrl = avatarUrl;
  document.getElementById("charTitle").textContent = name;
  setSaveStatus("saved");
  // Список персонажей и док держат свою копию — просим перечитать.
  hostWindow().postMessage({ type: "beacon:characterSaved", id: charId || pregenEditId }, location.origin);
  return true;
}

// redrawIdentity — имя и аватар стоят и в шапке чтения, и на вкладке правки.
function redrawIdentity() {
  if (mode === "view") renderView();
  else renderEditTabs();
}

// pickImageFile — системный выбор файла. Отмена не даёт change, поэтому
// слушаем ещё и cancel.
function pickImageFile() {
  return new Promise((resolve) => {
    const inp = h("input", { type: "file", accept: "image/*,video/mp4,video/webm", style: "display:none" });
    let done = false;
    const finish = (file) => {
      if (done) return;
      done = true;
      inp.remove();
      resolve(file);
    };
    inp.addEventListener("change", () => finish(inp.files[0] || null));
    inp.addEventListener("cancel", () => finish(null));
    document.body.appendChild(inp);
    inp.click();
  });
}

async function changeAvatarFlow() {
  const file = await pickImageFile();
  if (!file) return;
  let url;
  try {
    url = await uploadAvatarFile(file, { title: "Аватар персонажа" });
  } catch (err) {
    await showAlert("Не удалось загрузить: " + err.message);
    return;
  }
  if (!url) return; // передумали на кадрировании
  if (await saveIdentity({ avatarUrl: url })) redrawIdentity();
}

// recropAvatarFlow — переснять кадр без выбора файла: аватары, загруженные до
// кадрирования, иначе не поправить без исходника.
async function recropAvatarFlow() {
  let url;
  try {
    url = await recropAvatarUrl(character.avatarUrl, { title: "Аватар персонажа" });
  } catch (err) {
    await showAlert("Не удалось: " + err.message);
    return;
  }
  if (!url) return;
  if (await saveIdentity({ avatarUrl: url })) redrawIdentity();
}

async function removeAvatarFlow() {
  if (!(await showConfirm("Убрать аватар персонажа?", { title: "Аватар", okLabel: "Убрать", danger: true }))) return;
  if (await saveIdentity({ avatarUrl: "" })) redrawIdentity();
}

async function renameFlow() {
  const next = await showPrompt("Имя персонажа", {
    title: "Переименовать",
    value: character.name || "",
    okLabel: "Сохранить",
  });
  if (next === null || next.trim() === (character.name || "").trim()) return;
  if (await saveIdentity({ name: next })) redrawIdentity();
}

// identitySection — «Имя и портрет» на вкладке правки.
function identitySection() {
  const hasAvatar = !!character.avatarUrl;
  const isVideo = isVideoAvatar(character.avatarUrl);
  const portrait = hasAvatar
    ? isVideo
      ? h("video", { class: "portrait-img", src: character.avatarUrl, muted: true, loop: true, autoplay: true, playsinline: true })
      : h("img", { class: "portrait-img", src: character.avatarUrl })
    : h("div", { class: "portrait-placeholder", text: "нет аватара" });

  // readOnly — предпросмотр заготовки игроком: портрет показываем, менять нечего.
  const buttons = readOnly
    ? null
    : h("div", { class: "portrait-actions" }, [
        h("button", { type: "button", class: "portrait-btn", onclick: changeAvatarFlow }, [
          h("span", { html: icon("upload", { size: 13 }) }),
          hasAvatar ? "Заменить" : "Загрузить",
        ]),
        hasAvatar && !isVideo ? h("button", { type: "button", class: "portrait-btn", text: "Кадрировать", onclick: recropAvatarFlow }) : null,
        hasAvatar ? h("button", { type: "button", class: "portrait-btn", text: "Убрать", onclick: removeAvatarFlow }) : null,
      ]);

  const nameInput = h("input", { type: "text", maxlength: "60", value: character.name || "" });
  // По уходу из поля/Enter, а не на каждую букву: это отдельный запрос, а не
  // автосейв листа с его debounce.
  const commitName = async () => {
    const next = nameInput.value.trim();
    if (!next || next === (character.name || "").trim()) {
      nameInput.value = character.name || "";
      return;
    }
    if (await saveIdentity({ name: next })) redrawIdentity();
  };
  nameInput.addEventListener("change", commitName);
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") nameInput.blur();
  });

  if (readOnly) nameInput.disabled = true;

  return h("div", { class: "section" }, [
    h("h3", { text: "Имя и портрет" }),
    field("Имя персонажа", nameInput),
    portrait,
    buttons,
    h("div", {
      style: "margin-top:6px;color:var(--text-dim);font-size:11px;",
      text: isVideo
        ? "Анимированный токен-арт (mp4/webm) — кадрируется только картинка."
        : "Аватар кадрируется при загрузке: то, что попало в рамку, и станет фишкой на карте.",
    }),
  ]);
}

// ==================== tab 2: портрет и т.д. ====================

// ==================== tab 3: заметки ====================

// ==================== tab 4: заклинания ====================

// ==================== tab 5: инвентарь ====================
//
// В отличие от остального листа, инвентарь НЕ часть sheet/scheduleSave —
// своя sub-collection (см. api.js: fetchCharacterInventory и соседи), у неё
// собственные точечные запросы (см. internal/domain/character_sheet.go и
// repository.CharacterRepository про причину: инвентарь может писать не
// только сам игрок — ДМ через хаб, сервер при луте трупа — полная
// перезапись sheet_json по debounce-автосейву листа не должна откатывать
// только что выданный лут устаревшей копией). Доступна только владельцу
// (см. isAdminView ниже — у ДМ, открывшего ЧУЖОЙ лист, эндпоинты инвентаря
// вернут 404: они авторизуются по сессии текущего аккаунта, а не персонажа).
//
// Игрок НЕ может сам добавить себе предмет из каталога — только то, что
// выдал ДМ (хаб лута) или что удалось забрать с трупа (см. loot-take-modal.js,
// оба пути пишут через AddInventoryEntry в обход этого сервиса). Отсюда же
// правки количества в этой вкладке — только уменьшение (потратил/выбросил),
// см. qtyInput ниже.
let inventory = [];

function totalWeight() {
  const w = inventory.reduce((sum, e) => sum + (e.weightLb || 0) * (e.quantity || 0), 0);
  return Math.round(w * 100) / 100;
}

async function loadInventory() {
  try {
    inventory = await fetchCharacterInventory(charId);
  } catch {
    inventory = [];
  }
  // Карточки каталога нужны только ради Item.Modifiers надетых вещей (см.
  // activeModifiers) — тянем их вместе с инвентарём и одним запросом, а не
  // по одной на запись. Не загрузились — лист просто работает без учёта
  // экипировки, как до появления изменений.
  try {
    const items = await fetchItems();
    itemCatalog = new Map(items.map((it) => [it.id, it]));
  } catch {
    itemCatalog = new Map();
  }
  renderTab5();
  if (mode === "view") renderView();
}

function saveInventoryEntry(e, patch) {
  if ("equipped" in patch && patch.equipped !== e.equipped) {
    // Надеть/снять может расщепить стопку (надел одну штуку из трёх — в
    // инвентаре появляется отдельная надетая запись на 1 и обычная на 2) или
    // слить её обратно с такой же соседней записью (см.
    // internal/service/characters.go: UpdateInventoryItem), поэтому id и
    // количества строк после запроса могут не совпадать с тем, что было в
    // памяти — правим не локально, а перечитываем инвентарь целиком.
    updateCharacterInventoryItem(charId, e.id, e.quantity, patch.equipped, e.notes)
      .then(loadInventory)
      .catch((err) => showAlert("Не удалось сохранить: " + err.message));
    return;
  }
  Object.assign(e, patch);
  updateCharacterInventoryItem(charId, e.id, e.quantity, e.equipped, e.notes).catch((err) => showAlert("Не удалось сохранить: " + err.message));
}

function removeInventoryEntry(id) {
  deleteCharacterInventoryItem(charId, id)
    .then(() => {
      inventory = inventory.filter((e) => e.id !== id);
      renderTab5();
      if (mode === "view") renderView();
    })
    .catch((err) => showAlert("Не удалось удалить: " + err.message));
}

function renderTab5() {
  const root = document.getElementById("tab5");
  root.innerHTML = "";

  const listSection = h("div", { class: "section" }, [
    h("h3", { text: "Инвентарь" }),
    h("p", { class: "inv-total-weight" }, ["Общий вес: ", h("b", { text: formatWeight(totalWeight()) })]),
  ]);

  const table = h("table", { class: "dyn-table" }, [
    h("thead", {}, [
      h("tr", {}, [
        h("th", {}),
        h("th", { text: "Название" }),
        h("th", { text: "Вес/шт" }),
        h("th", { text: "Кол-во" }),
        h("th", { text: "Надето" }),
        h("th", { text: "Заметка" }),
        h("th", {}),
      ]),
    ]),
  ]);
  const tbody = h("tbody", {});
  for (const e of inventory) {
    const avatar = h("div", { class: "inv-avatar" });
    if (e.imageUrl) avatar.style.backgroundImage = cssUrl(e.imageUrl);

    // max = текущее количество — игрок может только потратить/выбросить
    // часть стопки, не приписать себе лишнее (см. комментарий у `let inventory`).
    const qtyInput = h("input", { type: "number", min: "0", max: String(e.quantity), value: String(e.quantity) });
    qtyInput.addEventListener("change", () => {
      const q = parseInt(qtyInput.value, 10);
      const clamped = Number.isFinite(q) ? Math.min(Math.max(q, 0), e.quantity) : e.quantity;
      // 0 — предмет потрачен весь, запись удаляется целиком (см. сервер:
      // UpdateInventoryItem), а не остаётся строкой "×0".
      if (clamped === 0) {
        removeInventoryEntry(e.id);
        return;
      }
      saveInventoryEntry(e, { quantity: clamped });
      renderTab5();
    });

    const equippedInput = h("input", { type: "checkbox" });
    equippedInput.checked = !!e.equipped;
    equippedInput.addEventListener("change", () => saveInventoryEntry(e, { equipped: equippedInput.checked }));

    const notesInput = h("input", { type: "text", value: e.notes || "", placeholder: "заметка" });
    notesInput.addEventListener("change", () => saveInventoryEntry(e, { notes: notesInput.value }));

    const delBtn = h("button", {
      type: "button",
      class: "row-del",
      html: icon("close", { size: 11 }),
      onclick: () => removeInventoryEntry(e.id),
    });

    const nameBtn = h("button", {
      type: "button",
      class: "inv-name-btn",
      title: "Открыть карточку предмета",
      text: e.name,
      onclick: (ev) => openItemPeek(e, ev.currentTarget),
    });

    tbody.appendChild(
      h("tr", {}, [
        h("td", {}, [avatar]),
        h("td", {}, [nameBtn]),
        h("td", { text: formatWeight(e.weightLb) }),
        h("td", {}, [qtyInput]),
        h("td", {}, [equippedInput]),
        h("td", {}, [notesInput]),
        h("td", {}, [delBtn]),
      ])
    );
  }
  table.appendChild(tbody);
  listSection.appendChild(table);

  root.append(listSection);
}

// ==================== режим чтения ====================
//
// Лист открывается СНАЧАЛА здесь, и только кнопка "Редактировать" в шапке
// пускает в бланк с полями ввода (renderTab1..5 выше). Причина — разные
// задачи: бланк заполняют раз в несколько уровней, а читают его каждый ход,
// и за столом с него нужны не поля ввода, а крупные числа и большие цели
// для клика.
//
// Что режим чтения УМЕЕТ менять (всё, что расходуется по ходу боя, — иначе
// пришлось бы прыгать в правку за каждой потраченной ячейкой): ХП и
// временные ХП, опыт, монеты, спасброски от смерти, истощение,
// вдохновение, ячейки заклинаний, ресурсы класса, количество/надетость
// предметов инвентаря. Всё остальное (характеристики, владения, тексты
// способностей, состав оружия и заклинаний) — только для чтения.
//
// Формулы PHB (модификаторы, бонусы навыков/спасбросков, СЛ заклинаний,
// пассивное восприятие) те же самые, что и в бланке — считаются теми же
// функциями rules-блока в начале файла, отдельной копии правил тут нет.

// mode — "view" (по умолчанию при каждом открытии листа) | "edit".
// Осознанно НЕ запоминается между открытиями: лист всегда открывается на
// чтение, правка — явное действие.
let mode = "view";

// vRefresh — точечные обновления чисел режима чтения (ХП, опыт, счётчики
// ресурсов): пересобирать весь экран на каждый клик по лампочке — терять
// прокрутку и фокус в поле быстрого ввода. Список живёт ровно одну
// отрисовку — renderView() очищает его первым делом.
let vRefresh = [];
function refreshView() {
  for (const fn of vRefresh) fn();
}

// Разбор "быстрого ввода" ("+5"/"-5"/"17") переехал в общий hp-bar.js —
// тем же полем и с теми же правилами правит хиты ДМ в трекере инициативы
// (combat-panel.js), и расходиться они не должны.
//
// quickInput — узкое поле быстрого ввода (см. parseQuickValue). Значение
// применяется по Enter или потере фокуса и поле сразу очищается: это не
// "поле со значением", а команда — текущее число всегда видно рядом крупно.
function quickInput(getCurrent, apply, opts) {
  const inp = h(
    "input",
    Object.assign(
      {
        type: "text",
        inputmode: "numeric",
        autocomplete: "off",
        placeholder: "+5",
        title: "«+5» — прибавить, «-5» — отнять, «17» — поставить ровно",
      },
      opts || {}
    )
  );
  function commit() {
    const parsed = parseQuickValue(inp.value, getCurrent());
    inp.value = "";
    if (!parsed) return;
    apply(parsed);
    scheduleSave();
    refreshView();
  }
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
      inp.blur();
    } else if (e.key === "Escape") {
      inp.value = "";
      inp.blur();
    }
  });
  // Enter выше уже вызвал commit и снял фокус — сюда долетит второй раз, но
  // поле к этому моменту пустое и parseQuickValue вернёт null.
  inp.addEventListener("blur", commit);
  return inp;
}

function stepBtn(label, cls, onclick) {
  return h("button", { type: "button", class: cls, text: label, onclick });
}

// vPips — ряд "лампочек" расходуемого ресурса: заполненная = ещё есть,
// погасшая = потрачена. Клик работает в обе стороны той же логикой, что
// лампы бланка (см. bulbRow): по заполненной крайней — гасит по неё
// включительно, по погасшей — зажигает по неё включительно.
function vPips(total, getFilled, setFilled, opts) {
  const o = opts || {};
  const wrap = h("div", { class: "v-pips" });
  const render = () => {
    wrap.innerHTML = "";
    const filled = getFilled();
    for (let i = 0; i < total; i++) {
      const isFilled = i < filled;
      wrap.appendChild(
        h("button", {
          type: "button",
          class: "v-pip" + (isFilled ? "" : " spent") + (o.tone ? " tone-" + o.tone : "") + (o.round ? " round" : ""),
          title: o.title || String(i + 1),
          onclick: () => {
            setFilled(filled > i ? i : i + 1);
            scheduleSave();
            render();
            refreshView();
          },
        })
      );
    }
  };
  render();
  return wrap;
}

// vText — блок свободного текста листа с кликабельными формулами внутри
// (см. inline-rolls.js): "1к8+3" в описании способности бросается кликом,
// как в карточке монстра. Пустой текст секции не создаёт вовсе.
function vText(title, value, opts) {
  const text = String(value || "").trim();
  if (!text) return null;
  const body = h("div", { class: "v-text", text });
  enhanceRolls(body, sendRoll);
  const o = opts || {};
  return h("details", { class: "v-fold v-card", open: o.open !== false }, [h("summary", { text: title }), body]);
}

function vCard(title, children, note) {
  const kids = [].concat(children).filter(Boolean);
  if (!kids.length) return null;
  return h("div", { class: "v-card" }, [
    h("div", { class: "v-card-head" }, [h("span", { text: title }), note ? h("span", { class: "v-card-note", text: note }) : null]),
    ...kids,
  ]);
}

// ---------- шапка ----------

function vHero() {
  const face =
    character.avatarUrl && !isVideoAvatar(character.avatarUrl)
      ? h("img", { class: "v-hero-avatar", src: character.avatarUrl, alt: "" })
      : h("div", { class: "v-hero-avatar", text: (character.name || "?").trim().charAt(0).toUpperCase() });
  // Клик по аватару в шапке — короткий путь к смене портрета, переходить в
  // правку не нужно. Полный набор действий — на вкладке «Портрет».
  const avatar = readOnly
    ? face
    : h("button", { type: "button", class: "v-hero-portrait", title: "Сменить аватар", onclick: changeAvatarFlow }, [
        face,
        h("span", { class: "v-hero-portrait-edit", html: icon("upload", { size: 12 }) }),
      ]);

  const sub = cardSubtitle(compiledSheet, sheet);

  return h("div", { class: "v-card" }, [
    h("div", { class: "v-hero" }, [
      avatar,
      h("div", { class: "v-hero-main" }, [
        h("div", { class: "v-hero-name" }, [
          h("span", { text: character.name || "—" }),
          readOnly
            ? null
            : h("button", {
                type: "button",
                class: "v-hero-rename",
                title: "Переименовать",
                html: icon("pencil", { size: 12 }),
                onclick: renameFlow,
              }),
        ]),
        h("div", { class: "v-hero-sub", text: sub }),
      ]),
    ]),
  ]);
}

// vXpCard — опыт по полю схемы f: значение, кнопки ±100 и быстрый ввод.
function vXpCard(f) {
  const xp = () => Number(getPath(sheet, f.path)) || 0;
  const setXp = (v) => setPath(sheet, f.path, Math.max(0, v));
  const value = h("b", { text: String(xp()) });
  vRefresh.push(() => (value.textContent = String(xp())));
  const bump = (delta) => {
    setXp(xp() + delta);
    scheduleSave();
    refreshView();
  };
  return h("div", { class: "v-card" }, [
    h("div", { class: "v-quick" }, [
      h("span", { class: "v-track-name" }, [h("small", { text: f.label }), value]),
      stepBtn("−100", "minus", () => bump(-100)),
      quickInput(xp, (r) => setXp(r.value), { placeholder: "+250", style: "flex:0 1 74px;" }),
      stepBtn("+100", "plus", () => bump(100)),
    ]),
  ]);
}

// ---------- ХП ----------

// clampHp — текущие ХП живут в 0..максимум: "в минус" бланк всё равно не
// умеет (для этого есть отдельный флаг "Умирает", см. domain.CombatStats),
// а перелечиться выше максимума нельзя по правилам. Максимум не заполнен
// (0) — не зажимаем сверху вообще, лист ещё не дозаполнен.
function clampHp(v) {
  // Потолок — эффективный максимум (см. effectiveHPMax): «максимум хитов
  // вдвое» от истощения или «+10 к максимуму» от заклинания меняют именно
  // его, а поле в бланке остаётся базой, как и у КЗ.
  const max = effectiveHPMax(sheet);
  return Math.max(0, max > 0 ? Math.min(max, v) : v);
}

// applyHp — урон, введённый ДЕЛЬТОЙ ("-7", кнопка −5), сначала съедает
// временные ХП и только остатком — текущие: за столом иначе этот вычет
// каждый раз делают в уме. Лечение и прямая установка числа ("17")
// временных не трогают.
function applyHp(r) {
  if (r.delta !== null && r.delta < 0) {
    let damage = -r.delta;
    const temp = sheet.combat.hpTemp || 0;
    const fromTemp = Math.min(temp, damage);
    if (fromTemp > 0) sheet.combat.hpTemp = temp - fromTemp;
    damage -= fromTemp;
    sheet.combat.hpCurrent = clampHp((sheet.combat.hpCurrent || 0) - damage);
    return;
  }
  sheet.combat.hpCurrent = clampHp(r.value);
}

function bumpHp(delta) {
  applyHp({ delta, value: (sheet.combat.hpCurrent || 0) + delta });
  scheduleSave();
  refreshView();
}

function vHpCard() {
  const cur = h("span", { class: "v-hp-big" });
  const max = h("span", { class: "v-hp-max" });
  const temp = h("span", { class: "v-hp-temp" });
  const fill = h("i", {});
  // preview — значение, за которым полоска идёт ПОКА ЕЁ ТЯНУТ: в бланк оно
  // ещё не записано (и не сохранено), но полоска и число обязаны идти за
  // пальцем, иначе жест не читается.
  let preview = null;
  const update = () => {
    const c = preview === null ? sheet.combat.hpCurrent || 0 : preview;
    const m = effectiveHPMax(sheet);
    const t = sheet.combat.hpTemp || 0;
    cur.textContent = String(c);
    max.textContent = "/ " + (m || "—");
    temp.textContent = t ? "+" + t + " врем." : "";
    temp.style.display = t ? "" : "none";
    const ratios = hpFillRatios({ current: c, temp: t, max: m });
    fill.style.width = (ratios.hp * 100).toFixed(1) + "%";
    fill.style.background = hpColor(ratios.hp);
    cur.style.color = m > 0 && c === 0 ? "#d9534f" : "";
  };
  vRefresh.push(update);
  update();

  // Полоску можно потянуть — тот же жест, что у ДМ в трекере инициативы
  // (см. hp-bar.js): "поставить примерно столько". Вниз это урон дельтой,
  // так что временные хиты съедаются первыми — как при вводе "-N" в поле
  // ниже (см. applyHp).
  const bar = h("div", { class: "v-bar", title: "Потяни, чтобы выставить хиты" }, [fill]);
  attachHpDrag(bar, {
    getState: () => ({ current: sheet.combat.hpCurrent || 0, max: effectiveHPMax(sheet) }),
    onPreview: (value) => {
      preview = value;
      update();
    },
    onCommit: (value) => {
      preview = null;
      applyHp({ delta: value - (sheet.combat.hpCurrent || 0), value });
      scheduleSave();
      refreshView();
    },
  });

  const hitDice = String(sheet.combat.hitDiceCurrent || sheet.combat.hitDiceTotal || "").trim();
  const hitDiceEl = hitDice
    ? h("div", { class: "v-track", style: "border-top:1px solid var(--border);margin-top:8px;" }, [
        h("span", { class: "v-track-name" }, [h("small", { text: "Кости хитов" }), h("span", { text: hitDice })]),
      ])
    : null;
  if (hitDiceEl) enhanceRolls(hitDiceEl, sendRoll);

  return h("div", { class: "v-card" }, [
    h("div", { class: "v-hp-row" }, [cur, max, temp]),
    bar,
    h("div", { class: "v-quick", title: "Урон сначала списывается с временных ХП" }, [
      stepBtn("−5", "minus", () => bumpHp(-5)),
      stepBtn("−1", "minus", () => bumpHp(-1)),
      quickInput(() => sheet.combat.hpCurrent || 0, applyHp),
      stepBtn("+1", "plus", () => bumpHp(1)),
      stepBtn("+5", "plus", () => bumpHp(5)),
    ]),
    h("div", { class: "v-quick", style: "margin-top:6px;" }, [
      h("span", { class: "v-track-name", text: "Временные ХП", style: "font-size:11px;color:var(--text-dim);" }),
      quickInput(
        () => sheet.combat.hpTemp || 0,
        (r) => (sheet.combat.hpTemp = Math.max(0, r.value)),
        { placeholder: "+0", style: "flex:0 1 66px;" }
      ),
    ]),
    hitDiceEl,
  ]);
}

// ---------- боевые плитки ----------

// ---------- состояние ----------

// liveStatusesHost/renderLiveStatuses — блок наложенных состояний (см.
// domain.AppliedStatus). Только для чтения: свободнотекстовое поле
// «Состояния» бланка (sheet.combat.conditions, строкой ниже) осталось как
// было — это заметка игрока, а метки в этом блоке живут на токене/бойце и
// приходят с сервера (см. connectRollSocket). Своей истины лист не держит —
// тот же принцип, что у трекера инициативы.
function liveStatusesHost() {
  liveStatusesEl = h("div", { class: "v-track", style: "margin-top:8px;display:block;" });
  renderLiveStatuses();
  return liveStatusesEl;
}

function renderLiveStatuses() {
  if (!liveStatusesEl) return;
  liveStatusesEl.innerHTML = "";
  if (liveStatuses.length === 0) return;
  liveStatusesEl.appendChild(h("small", { text: "Наложено" }));
  liveStatusesEl.appendChild(renderStatusChips(liveStatuses));
}

// ---------- характеристики и навыки ----------

// ---------- атаки ----------

// ---------- ресурсы и ячейки ----------

function vResourcesCard() {
  const rows = [];
  for (const r of sheet.resources) {
    const name = String(r.name || "").trim();
    const max = r.max || 0;
    if (!name && !max) continue;
    const count = h("span", { class: "v-track-count" });
    const update = () => (count.textContent = (r.current || 0) + " / " + max);
    vRefresh.push(update);
    update();
    // До 10 делений — лампочки (в бою кликают по ним); больше — только
    // ±1 и поле быстрого ввода, ряд из 30 лампочек нечитаем.
    const control =
      max > 0 && max <= 10
        ? vPips(max, () => Math.min(r.current || 0, max), (v) => (r.current = v))
        : h("div", { class: "v-quick" }, [
            stepBtn("−1", "minus", () => {
              r.current = Math.max(0, (r.current || 0) - 1);
              scheduleSave();
              refreshView();
            }),
            quickInput(
              () => r.current || 0,
              (q) => (r.current = Math.max(0, max > 0 ? Math.min(max, q.value) : q.value)),
              { placeholder: "+1", style: "flex:0 1 60px;" }
            ),
            stepBtn("+1", "plus", () => {
              r.current = max > 0 ? Math.min(max, (r.current || 0) + 1) : (r.current || 0) + 1;
              scheduleSave();
              refreshView();
            }),
          ]);
    rows.push(
      h("div", { class: "v-track" }, [
        h("span", { class: "v-track-name" }, [h("span", { text: name || "Ресурс" }), r.recovery ? h("small", { text: r.recovery }) : null]),
        count,
        control,
      ])
    );
  }
  return vCard("Ресурсы", rows);
}

// ---------- заклинания ----------

// ---------- деньги, настройка, инвентарь ----------

function vMoneyCard() {
  const grid = h("div", { class: "v-money" });
  for (const c of coinRows(sheet.coins)) {
    const value = h("b", { text: String(sheet.coins[c.key] || 0) });
    vRefresh.push(() => (value.textContent = String(sheet.coins[c.key] || 0)));
    const cell = h("div", { class: "v-money-cell" + (c.other ? " other" : ""), title: c.other ? "Валюта другой системы" : c.title }, [value, h("span", { text: c.label })]);
    cell.appendChild(
      quickInput(
        () => sheet.coins[c.key] || 0,
        (r) => (sheet.coins[c.key] = Math.max(0, r.value)),
        { placeholder: "+0", style: "width:100%;margin-top:4px;font-size:11px;padding:3px 2px;" }
      )
    );
    grid.appendChild(cell);
  }
  // Кошелёк показываем всегда, даже из одних нулей: игроку нужно место, куда
  // вписать первую добычу, не переключаясь в режим правки.
  return vCard("Деньги", grid);
}

// ==================== карточка предмета из инвентаря ====================
//
// Инвентарь хранит только id/имя/вес/кол-во (см. domain.InventoryEntry) —
// сами характеристики предмета лежат в общей библиотеке (domain.Item) и уже
// подтянуты целиком в itemCatalog (см. loadInventory, ради модификаторов
// надетых вещей). Здесь та же карточка используется ещё раз, чтобы её можно
// было посмотреть из инвентаря — в двух видах:
//   - openItemPeek  — мини-окно рядом с предметом, только самое важное;
//   - showItemCard  — полноценное модальное окно с описанием целиком, тот же
//     "read-режим", что и в pages/itembook.js (readHeader/readInfoGrid/
//     renderReadView), скопирован сюда по той же схеме, что используют
//     spellbook.js/bestiary.js — свой набор функций на страницу, без общего
//     модуля.
function itemLineIf(label, value) {
  const v = (value ?? "").toString().trim();
  if (!v) return null;
  return h("div", { class: "ib-line" }, [h("strong", { text: label + " " }), v]);
}

function itemAttunementText(it) {
  if (!it.requiresAttunement) return "";
  return it.attunementNote ? `требуется настройка (${it.attunementNote})` : "требуется настройка";
}

function itemReadInfoGrid(it) {
  const wrap = h("div", { class: "ib-info" });
  const add = (label, value) => {
    const line = itemLineIf(label, value);
    if (line) wrap.appendChild(line);
  };
  add("Настройка:", itemAttunementText(it));
  add("Стоимость:", it.cost);
  add("Вес:", it.weight || (it.weightLb ? formatWeight(it.weightLb) : ""));
  add("Активация:", it.activation);
  add("Урон:", it.damage);
  add("Класс доспеха:", it.armorClass);
  add("Свойства:", it.properties);
  add("Заряды:", it.charges);
  return wrap;
}

function itemReadHeader(it) {
  const portrait = it.imageUrl ? h("img", { class: "ib-portrait", src: it.imageUrl }) : null;
  const subtitleBits = [it.type, it.rarity].filter(Boolean).join(", ");
  const pills = [...(it.source ? [it.source] : []), ...(it.tags || [])].map((t) => h("span", { class: "ib-tag-pill", text: t }));
  const text = h("div", { class: "ib-header-text" }, [
    h("h2", { class: "ib-name", text: it.name || "Без имени" }),
    h("div", { class: "ib-subtitle", text: subtitleBits }),
    pills.length ? h("div", { class: "ib-tags" }, pills) : null,
  ]);
  return portrait ? h("div", { class: "ib-header" }, [portrait, text]) : text;
}

// showItemCard — вариант 2, "полноценное модальное окно": тот же bt-modal,
// что и у showAlert/showConfirm (см. modal.js), с телом целиком под карточку
// предмета вместо строки текста. cancelLabel: "" — как у showAlert, кнопка
// в подвале только закрывает, а не подтверждает что-либо.
function showItemCard(it) {
  openModal({
    title: it.name || "Предмет",
    okLabel: "Закрыть",
    cancelLabel: "",
    buildBody: (body) => {
      body.appendChild(itemReadHeader(it));
      body.appendChild(h("div", { class: "ib-hr" }));
      const info = itemReadInfoGrid(it);
      body.appendChild(info);
      enhanceRolls(info, sendRoll);
      const desc = (it.description || "").trim();
      if (desc) {
        body.appendChild(h("div", { class: "ib-hr" }));
        const prose = h("div", { class: "ib-prose" });
        prose.innerHTML = renderNoteHtml(it.description);
        enhanceRolls(prose, sendRoll);
        wireCatalogLinks(prose);
        body.appendChild(h("div", { class: "ib-block" }, [h("h3", { class: "ib-section-title", text: "Описание" }), prose]));
      }
      return null;
    },
    onOk: () => undefined,
    onCancel: () => undefined,
  });
}

// stripMarkup — грубая чистка markdown/HTML для превью в мини-окне: там нет
// места (и смысла) рендерить разметку целиком, только пара строк текста
// (обрезаются визуально, см. .item-peek-desc line-clamp в character-sheet.html).
function stripMarkup(text) {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

let itemPeekEl = null;
let itemPeekEntryId = null;

function closeItemPeek() {
  if (!itemPeekEl) return;
  itemPeekEl.remove();
  itemPeekEl = null;
  itemPeekEntryId = null;
  document.removeEventListener("mousedown", onItemPeekOutside, true);
  document.removeEventListener("keydown", onItemPeekKey, true);
  window.removeEventListener("scroll", closeItemPeek, true);
  window.removeEventListener("resize", closeItemPeek);
}

function onItemPeekOutside(ev) {
  if (itemPeekEl && !itemPeekEl.contains(ev.target)) closeItemPeek();
}

function onItemPeekKey(ev) {
  if (ev.key === "Escape") closeItemPeek();
}

function positionItemPeek(el, anchorEl) {
  const margin = 8;
  const r = anchorEl.getBoundingClientRect();
  const width = Math.min(300, window.innerWidth - margin * 2);
  el.style.width = width + "px";
  el.style.left = Math.min(Math.max(r.left, margin), window.innerWidth - width - margin) + "px";
  el.style.top = r.bottom + 6 + "px";
  // Высоту знаем только после вставки в DOM — если снизу не влезает, окно
  // переносится над предметом вместо того, чтобы вылезти за край экрана.
  const boxHeight = el.getBoundingClientRect().height;
  if (r.bottom + 6 + boxHeight > window.innerHeight - margin) {
    el.style.top = Math.max(margin, r.top - 6 - boxHeight) + "px";
  }
}

// openItemPeek — вариант 1, "мини-окно рядом с предметом": повторный клик по
// уже открытому предмету закрывает его же (тоггл), клик по другому —
// перерисовывает на новом месте. Нет карточки в библиотеке (itemId пуст —
// запись добавлена вручную, либо предмет с тех пор удалён из каталога, см.
// domain.InventoryEntry.ItemID) — показываем то, что есть в самой записи
// инвентаря, без кнопки "Открыть карточку" (открывать нечего).
function openItemPeek(entry, anchorEl) {
  if (itemPeekEl && itemPeekEntryId === entry.id) {
    closeItemPeek();
    return;
  }
  closeItemPeek();

  const it = entry.itemId ? itemCatalog.get(entry.itemId) : null;
  const children = [
    h("div", { class: "item-peek-head" }, [
      h("b", { text: entry.name }),
      h("button", { type: "button", class: "item-peek-close", html: icon("close", { size: 11 }), title: "Закрыть", onclick: closeItemPeek }),
    ]),
  ];
  if (it) {
    const sub = [it.type, it.rarity].filter(Boolean).join(", ");
    if (sub) children.push(h("div", { class: "item-peek-sub", text: sub }));
    children.push(itemReadInfoGrid(it));
    const desc = (it.description || "").trim();
    if (desc) children.push(h("p", { class: "item-peek-desc", text: stripMarkup(desc) }));
    children.push(
      h("div", { class: "item-peek-foot" }, [
        h("button", {
          type: "button",
          text: "Открыть карточку",
          onclick: () => {
            closeItemPeek();
            showItemCard(it);
          },
        }),
      ])
    );
  } else {
    children.push(h("div", { class: "item-peek-sub", text: "Предмета нет в библиотеке — правлен вручную" }));
    if (entry.notes) children.push(h("p", { class: "item-peek-desc", text: entry.notes }));
  }

  itemPeekEl = h("div", { class: "item-peek" }, children);
  document.body.appendChild(itemPeekEl);
  itemPeekEntryId = entry.id;
  positionItemPeek(itemPeekEl, anchorEl);

  // Подписка отложена на следующий тик — иначе тот же клик, что открыл окно
  // (mousedown на кнопке-триггере), тут же поймает себя как "клик мимо" и
  // закроет только что созданное окно.
  setTimeout(() => {
    document.addEventListener("mousedown", onItemPeekOutside, true);
    document.addEventListener("keydown", onItemPeekKey, true);
    window.addEventListener("scroll", closeItemPeek, true);
    window.addEventListener("resize", closeItemPeek);
  }, 0);
}

function vInventoryCard() {
  // У ДМ, открывшего ЧУЖОЙ лист, эндпоинты инвентаря отдают 404 (см.
  // renderTab5) — секции просто нет, как и вкладки.
  if (isAdminView || !inventory.length) return null;
  const rows = inventory.map((e) => {
    const qty = h("span", { class: "v-track-count", text: "×" + (e.quantity || 0) });
    const eq = h("button", {
      type: "button",
      class: "v-inv-eq" + (e.equipped ? " on" : ""),
      title: e.equipped ? "Надето — снять" : "Надеть",
      html: icon("check", { size: 12 }),
      onclick: () => saveInventoryEntry(e, { equipped: !e.equipped }),
    });
    return h("div", { class: "v-inv" }, [
      h(
        "button",
        { type: "button", class: "v-inv-name", title: "Открыть карточку предмета", onclick: (ev) => openItemPeek(e, ev.currentTarget) },
        [h("span", { text: e.name }), e.weightLb ? h("small", { text: " · " + formatWeight(e.weightLb) }) : null]
      ),
      qty,
      // Только "потратить" — набрать себе лишнего игрок не может (см.
      // комментарий у `let inventory`), пополнение только через лут/ДМ.
      h("button", {
        type: "button",
        class: "v-inv-eq",
        title: "Потратить одну штуку",
        html: icon("minus", { size: 12 }),
        onclick: () => {
          const next = Math.max(0, (e.quantity || 0) - 1);
          // 0 — предмет потрачен весь, запись удаляется целиком (см.
          // removeInventoryEntry), а не остаётся строкой "×0".
          if (next === 0) {
            removeInventoryEntry(e.id);
            return;
          }
          saveInventoryEntry(e, { quantity: next });
          renderView();
        },
      }),
      eq,
    ]);
  });
  return vCard("Инвентарь", rows, formatWeight(totalWeight()));
}

// ---------- сборка ----------

function renderView() {
  const root = document.getElementById("viewPanel");
  vRefresh = [];
  root.innerHTML = "";
  root.appendChild(renderSchemaView(schemaCtx()));
}

// setMode — переключение "чтение ⇄ правка". Обе стороны пересобираются от
// нуля: в режиме чтения меняются ХП/ячейки/ресурсы, в правке — всё
// остальное, и вернувшись обратно надо видеть свежие числа, а не то, что
// было отрисовано при загрузке.
function setMode(next) {
  mode = next;
  document.body.classList.toggle("mode-view", mode === "view");
  document.getElementById("viewPanel").classList.toggle("active", mode === "view");
  const btn = document.getElementById("modeBtn");
  const isView = mode === "view";
  btn.innerHTML = icon(isView ? "pencil" : "eye", { size: 13 }) + "<span>" + (isView ? "Редактировать" : "Готово") + "</span>";
  btn.title = isView ? "Открыть бланк для правки" : "Вернуться к режиму чтения";
  if (isView) renderView();
  else renderEditTabs();
}

// ==================== autosave ====================

let saveTimer = null;
let dirty = false;
const saveStatusEl = document.getElementById("saveStatus");

function setSaveStatus(kind, detail) {
  saveStatusEl.classList.remove("saving", "error");
  if (kind === "saving") {
    saveStatusEl.textContent = "Сохранение…";
    saveStatusEl.classList.add("saving");
  } else if (kind === "saved") {
    saveStatusEl.textContent = "Сохранено";
  } else if (kind === "error") {
    saveStatusEl.textContent = "Ошибка: " + (detail || "");
    saveStatusEl.classList.add("error");
  } else {
    saveStatusEl.textContent = "";
  }
}

function scheduleSave() {
  if (readOnly) return;
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 700);
}

// saveNow — сохранить немедленно, без debounce. Для разовых крупных правок
// (импорт LSS): ждать 700мс незачем, а если окно закроют раньше — правка
// терялась (fetch дебаунса умирает вместе с iframe, см. beaconFlush ниже).
async function saveNow() {
  if (readOnly) return;
  clearTimeout(saveTimer);
  dirty = true;
  await doSave();
}

// saveInFlight — промис текущей записи на сервер (null, когда её нет).
// beaconFlush ждёт именно его: dirty сбрасывается в начале doSave, так что
// без этого закрытие окна в момент «уже шлём» убило бы запрос.
let saveInFlight = null;

// lastOwnSaveAt — когда это окно само сохраняло лист. Сервер рассылает
// character_sheet_changed всем, включая автора правки, и без этой отметки
// бланк перечитывал бы себя после каждого автосейва.
let lastOwnSaveAt = 0;

async function doSave() {
  if (!dirty || readOnly) return;
  lastOwnSaveAt = Date.now();
  dirty = false;
  setSaveStatus("saving");
  const p = isPregenAdmin
    ? // Полная перезапись пре-гена — имя/аватар/метку модуля возвращаем как
      // есть, правится только лист (имя/аватар заготовки — в панели ДМ).
      updateAdminPregen(pregenEditId, {
        name: character.name,
        avatarUrl: character.avatarUrl || "",
        foundryModuleId: character.source || "",
        sheet,
      })
    : isAdminView
      ? updateAdminCharacterSheet(charId, sheet)
      : updateCharacterSheet(charId, sheet);
  saveInFlight = p;
  try {
    await p;
    setSaveStatus("saved");
  } catch (err) {
    dirty = true;
    setSaveStatus("error", err.message);
  } finally {
    if (saveInFlight === p) saveInFlight = null;
  }
}

window.addEventListener("beforeunload", () => {
  if (dirty && !readOnly) {
    // best-effort — большинство браузеров не ждут async в beforeunload,
    // но debounce всего 700мс, так что почти всегда уже сохранено к этому моменту.
    doSave();
  }
});

// beaconFlush — floating-window.js зовёт это ПЕРЕД удалением iframe (см.
// flushIframe там же). Удаление iframe не показывает beforeunload и убивает
// его fetch на полпути, поэтому debounce-сейв (700мс) терялся, если лист
// закрыть сразу после правки — заметнее всего на импорте LSS. Здесь ждём
// завершения записи по-настоящему.
window.beaconFlush = async () => {
  clearTimeout(saveTimer);
  if (dirty && !readOnly) await doSave();
  if (saveInFlight) await saveInFlight.catch(() => {});
};

// ==================== dice rolls ====================

function connectRollSocket() {
  // /ws/player требует роль "player" (см. internal/api/ws/routes.go) — ДМ
  // туда просто не пустят, поэтому в режиме ДМ бросок идёт через /ws/dm
  // (авторизован ролью admin из той же cookie сессии). Сервер разрешает DM
  // отправлять roll_dice как и все остальные типы сообщений (authorize) и
  // подписывает бросок именем ПЕРСОНАЖА этого листа, раз sendRoll шлёт его
  // characterId (room.go: handleRollDice/rollerName) — здесь важен только
  // сам roll_result, остальной трафик DM-сокета (снапшот сцены и т.п.)
  // молча игнорируется.
  // Своя подвальная лента лога — только у листа, вынесенного в настоящее
  // отдельное окно/вкладку. Внутри стола (боковой док sheet-dock.js или
  // плавающее окно floating-window.js — то есть iframe) приходит ТОТ ЖЕ
  // roll_result, что и в плашку стола (бросок ретранслируется всей комнате,
  // см. internal/service/room.go: relayRoll), и два лога в паре сантиметров
  // друг от друга дублировали бы строку — поэтому там rollLog остаётся null.
  if (!rollLog && !isEmbedded()) {
    rollLog = createRollLog(document.getElementById("rollLogWrap"), { layout: "strip" });
  }
  // Сокет с переподключением — см. web/src/ws-reconnect.js. Листу это нужнее
  // прочих окон: им же приезжают хиты, правленные ДМ в трекере, и лут из
  // хаба. После обрыва цифры на бланке молча расходились бы с тем, что
  // видит стол, до перезагрузки страницы.
  rollWS = openSocket(isAdminView ? "/ws/dm" : "/ws/player", {
    onMessage: (data) => {
    if (data.type === "roll_result") rollLog?.push(data);
    // Наложенные состояния этого персонажа (см. domain.AppliedStatus)
    // приезжают тем же сокетом в combat_state — сервер уже свёл их с токена
    // бойца (см. room_statuses.go: statusesOf) и вырезал скрытые от игрока.
    // Лист их только ПОКАЗЫВАЕТ: вешает и снимает метки ДМ (палитра в меню
    // токена или в трекере), собственного поля в бланке у них нет — иначе
    // получилось бы два источника истины. Если персонажа нет в инициативе,
    // список просто пустой: метка на токене вне боя сюда не долетает.
    if (data.type === "combat_state") {
      const mine = (data.combatants || []).find((c) => c.characterId === charId);
      liveStatuses = (mine && mine.statuses) || [];
      renderLiveStatuses();
      // Метки несут изменения (см. domain.AppliedStatus.Modifiers) — от них
      // зависят КЗ, скорость и всё, что считается от характеристик, поэтому
      // пересчитываем числа режима чтения, а не только строку чипов.
      if (mode === "view") refreshView();
    }
    // Хиты, изменённые ДМ в трекере инициативы: сервер пишет их в лист сам
    // (см. internal/service/room_character_hp.go) и присылает сюда, чтобы
    // цифра на экране игрока поменялась в момент удара, а не после
    // перезагрузки страницы. Кладём их в СВОЮ копию листа — иначе
    // ближайший автосейв бланка (debounce 700мс, см. scheduleSave) увёз бы
    // на сервер старые хиты и откатил правку ДМ.
    // Инвентарь пополняется не только с этого окна (хаб ДМа/труп на
    // player.html, см. service.Room: handleHubTakeItem/handleLootTakeItem) —
    // без этого сигнала новый лут появлялся бы только после перезагрузки
    // страницы с открытым бланком.
    if (data.type === "character_inventory" && data.characterId === charId) {
      loadInventory();
    }
    // Бланк переписали снаружи: ДМ правит лист игрока из своей панели, или
    // тот же лист открыт во втором окне. Раньше правка доезжала только
    // перезагрузкой страницы.
    if (data.type === "character_sheet_changed" && data.characterId === charId) {
      // Своё же сохранение (сервер шлёт и автору) и режим правки пропускаем:
      // в первом случае перечитывать нечего, во втором подмена разметки
      // съела бы недописанное — как и у хитов ниже.
      if (mode === "view" && Date.now() - lastOwnSaveAt > 2000 && !dirty) reloadSheet();
    }
    if (data.type === "character_hp" && data.characterId === charId && sheet) {
      sheet.combat.hpCurrent = data.hpCurrent;
      sheet.combat.hpTemp = data.hpTemp;
      sheet.combat.hpMax = data.hpMax;
      // В режиме правки перерисовывать нельзя: под курсором живые поля
      // ввода, и подмена разметки съела бы недописанное. Данные уже
      // обновлены, а увидит их бланк при следующем переключении режима.
      if (mode === "view") refreshView();
    }
    },
  });
}

// reloadSheet — перечитать бланк с сервера и перерисовать режим чтения.
// Имя и аватар тоже могли поменяться (ДМ правит их в своей панели), поэтому
// обновляем и заголовок окна.
async function reloadSheet() {
  let fresh;
  try {
    fresh = isAdminView ? await fetchAdminCharacter(charId) : await fetchCharacter(charId);
  } catch {
    return; // сеть моргнула — оставляем то, что на экране
  }
  character = fresh;
  sheet = normalizeSheet(character.sheet);
  document.getElementById("charTitle").textContent = character.name;
  // renderView, а не refreshView: последняя обновляет только «живые» числа
  // (опыт, хиты), а класс, уровень и прочая шапка строятся при сборке
  // разметки — их правку было бы не видно.
  if (mode === "view") renderView();
}

function sendRoll(formula, label) {
  if (!rollWS) return;
  // characterId — сервер сам подставит имя ПЕРСОНАЖА в общий лог вместо
  // логина игрока/роли "ДМ" сокета (см. room.go: handleRollDice/rollerName),
  // раз бросок сделан именно с его листа. Так лог всегда называет того, кто
  // за столом реально кидал кубик — даже когда открыто несколько листов
  // подряд или ДМ бросает за чужого персонажа.
  rollWS.send(withRollMode({ type: "roll_dice", formula, label, characterId: charId }));
}

// sheetEvaluator — формулы листа по схеме системы (schema-formula.js):
// значения с модификаторами надетого и висящих состояний. Схема
// разбирается один раз; у системы со старым бланком схемы нет — ссылки в
// формулах тогда только пути в JSON листа.
let compiledSheet = null;
function sheetEvaluator() {
  const schema = schemaFor("sheet");
  if (!compiledSheet || compiledSheet.schema !== schema) compiledSheet = schema ? compileSchema(schema) : null;
  return createEvaluator(compiledSheet, sheet, activeModifiers());
}

// sendResolvedRoll — бросок, уже сведённый к формуле сервера
// (schema-formula.js: dice / rollField): ошибка формулы — сообщение, а не
// битый бросок; формула без кубов — просто значение.
function sendResolvedRoll(r, label) {
  if (r.error) {
    showAlert(`«${label}»: ${r.error.message}`);
    return;
  }
  if (r.dice === 0) {
    showAlert(`«${label}»: кубов в формуле нет, значение — ${r.const}`);
    return;
  }
  sendRoll(r.formula, label);
}

// isEmbedded — лист открыт ВНУТРИ страницы стола: боковым доком
// (sheet-dock.js) или плавающим окном (floating-window.js), то есть в
// iframe, а не отдельной вкладкой/окном браузера.
function isEmbedded() {
  return window.parent !== window;
}

// ==================== boot ====================

function switchTab(n) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === String(n)));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
  document.getElementById("tab" + n).classList.add("active");
}
document.querySelectorAll(".tab-btn").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
document.getElementById("modeBtn").onclick = () => setMode(mode === "view" ? "edit" : "view");
initFullscreenButton(document.getElementById("fullscreenBtn"));

// Своя шапка с ✕ — рамке на телефоне своя не нужна (см. embed.js).
announceOwnHeader();
document.getElementById("closeBtn").onclick = () => {
  // По умолчанию лист открывается ВНУТРИ dm.html/player.html как плавающее
  // окно (см. web/src/floating-window.js) — это iframe, а не отдельная
  // вкладка, и window.close() у iframe молча ничего не делает. Родитель
  // слушает это сообщение и закрывает плавающее окно сам. Если же лист
  // вынесли кнопкой 🗗 в настоящее окно браузера (window.parent === window),
  // ведём себя как раньше.
  if (isEmbedded()) {
    // Родитель сам дёрнет beaconFlush перед удалением iframe (floating-window.js).
    window.parent.postMessage({ type: "beacon:closeFloatingWindow" }, location.origin);
  } else {
    window.beaconFlush().finally(() => window.close());
  }
};

function currentId() {
  return new URLSearchParams(location.search).get("id");
}

// pregenId — режим предпросмотра «готового персонажа» из пула мира БЕЗ
// захвата (character-sheet.html?pregen=<id>, см. internal/domain/pregen.go).
// Лист открывается только на чтение: у пре-гена ещё нет записи characters,
// сохранять и бросать кубы не за кого.
function currentPregenId() {
  return new URLSearchParams(location.search).get("pregen");
}

(async function boot() {
  me = await fetchMe();
  await Promise.all([loadSystemProfile(), loadSchemas()]); // единица веса, валюты и схемы мира
  if (!me || (!isPlayer(me.role) && !isGM(me.role))) {
    location.href = "/";
    return;
  }

  const pregenId = currentPregenId();
  if (pregenId) {
    try {
      character = await fetchPregen(pregenId);
    } catch (err) {
      document.getElementById("loadingHint").textContent = "Не удалось загрузить готового персонажа: " + err.message;
      return;
    }
    sheet = normalizeSheet(character.sheet);

    // ДМ открыл заготовку из пула — полноценная правка листа (шаблон
    // скопируется игроку при «Назначить»). Инвентарь и броски заготовке
    // недоступны — записи characters ещё нет.
    if (isGM(me.role)) {
      isPregenAdmin = true;
      pregenEditId = pregenId;
      document.getElementById("charTitle").textContent = character.name;
      document.getElementById("charSub").textContent = "заготовка из пула — ещё не назначена игроку";
      const banner = document.getElementById("readonlyBanner");
      banner.textContent = "Заготовка «Готовые персонажи». Заполни лист заранее — при назначении игроку он скопируется ему.";
      banner.classList.add("shown");
      const tab5Btn = document.querySelector('.tab-btn[data-tab="5"]');
      if (tab5Btn) tab5Btn.style.display = "none";
      setMode("view");
      document.getElementById("loadingHint").style.display = "none";
      document.getElementById("app").classList.add("ready");
      return;
    }

    readOnly = true;
    document.getElementById("charTitle").textContent = character.name;
    document.getElementById("charSub").textContent = "готовый персонаж приключения";
    const banner = document.getElementById("readonlyBanner");
    banner.textContent = "Предпросмотр — этого персонажа ещё никто не взял. Полноценно откроется после «Взять» / назначения ДМ.";
    banner.classList.add("shown");
    // Правка и инвентарь пре-гену недоступны — прячем переключатель режима,
    // статус автосохранения и вкладку инвентаря.
    document.getElementById("modeBtn").style.display = "none";
    saveStatusEl.style.display = "none";
    const tab5Btn = document.querySelector('.tab-btn[data-tab="5"]');
    if (tab5Btn) tab5Btn.style.display = "none";

    setMode("view");
    document.getElementById("loadingHint").style.display = "none";
    document.getElementById("app").classList.add("ready");
    return;
  }

  charId = currentId();
  if (!charId) {
    document.getElementById("loadingHint").textContent = "Не указан id персонажа (?id=...).";
    return;
  }
  isAdminView = isGM(me.role);
  try {
    character = isAdminView ? await fetchAdminCharacter(charId) : await fetchCharacter(charId);
  } catch (err) {
    document.getElementById("loadingHint").textContent = "Не удалось загрузить лист: " + err.message;
    return;
  }
  sheet = normalizeSheet(character.sheet);
  // Справочник (классы/архетипы/происхождения/виды, см. domain.Reference) —
  // источник подсказок для полей "Класс"/"Подкласс"/"Вид"/"Предыстория"
  // (см. suggestInput/classSubclassFields выше). Отсутствие/ошибка запроса
  // не должна ронять открытие листа — тогда поля просто останутся обычным
  // текстовым вводом без подсказок.
  document.getElementById("charTitle").textContent = character.name;
  document.getElementById("charSub").textContent = isAdminView && character.accountUsername ? "игрок: " + character.accountUsername : "";
  // Баннер больше не значит "только для чтения" (ДМ тоже редактирует) —
  // просто предупреждает, чей это лист, чтобы не перепутать со своим.
  document.getElementById("readonlyBanner").classList.toggle("shown", isAdminView);

  // Лист всегда открывается на ЧТЕНИЕ (см. setMode/renderView) — бланк с
  // полями ввода собирается только при первом переходе в правку.
  setMode("view");

  // Инвентарь — только у владельца (см. комментарий renderTab5 выше): у ДМ,
  // открывшего чужой лист, эндпоинты инвентаря вернули бы 404 (авторизация
  // по сессии текущего аккаунта), поэтому вкладку в режиме ДМ просто прячем,
  // а не показываем пустой/ошибающийся список.
  const tab5Btn = document.querySelector('.tab-btn[data-tab="5"]');
  if (isAdminView) {
    if (tab5Btn) tab5Btn.style.display = "none";
  } else {
    loadInventory();
  }

  document.getElementById("loadingHint").style.display = "none";
  document.getElementById("app").classList.add("ready");

  // Бросок кубов с листа — и у владельца, и у ДМ (см. connectRollSocket:
  // разные WS-эндпоинты под роль).
  connectRollSocket();
})();
