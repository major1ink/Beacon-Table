// HTTP API клиент — перенесено из static/js/app.js дословно (нижняя треть
// файла, все функции вне initVTT). Не имеет отношения к canvas-рендеру,
// поэтому в переезде на PixiJS не меняется вообще — просто становится
// ES-модулем вместо глобальных функций classic-скрипта.

// Cookie сессии (beacon_session, HttpOnly) браузер прикладывает сам к любому
// fetch на тот же origin — apiFetch просто шлёт JSON и разбирает JSON-ответ/
// ошибку (см. internal/api/http: writeJSON/writeErr на сервере).
export async function apiFetch(url, options) {
  const opts = Object.assign({ headers: { "Content-Type": "application/json" } }, options || {});
  const res = await fetch(url, opts);
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* пустое тело (например 204) — не ошибка */
  }
  if (!res.ok) throw new Error((data && data.error) || res.statusText || "ошибка сервера");
  return data;
}

// fetchMe — текущий аккаунт по сессии, или null если не авторизован
// (используется dm.html/player.html при загрузке, чтобы решить, показывать
// контент или увести на "/").
export async function fetchMe() {
  try {
    return await apiFetch("/api/me");
  } catch {
    return null;
  }
}

export async function apiLogin(username, password) {
  return apiFetch("/api/login", { method: "POST", body: JSON.stringify({ username, password }) });
}
export async function apiRegister(username, password) {
  return apiFetch("/api/register", { method: "POST", body: JSON.stringify({ username, password }) });
}
export async function apiLogout() {
  return apiFetch("/api/logout", { method: "POST" });
}
export async function apiChangeOwnPassword(oldPassword, newPassword) {
  return apiFetch("/api/me/password", { method: "PUT", body: JSON.stringify({ oldPassword, newPassword }) });
}

// ---- миры (компании) — только ДМ, см. web/worlds.html ----
export async function fetchCompanies() {
  return apiFetch("/api/companies");
}
export async function createCompany(name, system) {
  return apiFetch("/api/companies", { method: "POST", body: JSON.stringify({ name, system }) });
}
export async function launchCompany(id) {
  return apiFetch(`/api/companies/${id}/launch`, { method: "POST" });
}
// stopActiveWorld — снять текущий мир со стола (ДМ вернулся на worlds.html):
// стол пустеет, игроки отваливаются до следующего launchCompany.
export async function stopActiveWorld() {
  return apiFetch("/api/companies/stop", { method: "POST" });
}
// deleteCompany — force=true сносит мир вместе с аккаунтами игроков, их
// персонажами и файлами мира на диске (см. handleCompanyDelete).
export async function deleteCompany(id, force) {
  return apiFetch(`/api/companies/${id}${force ? "?force=1" : ""}`, { method: "DELETE" });
}
// exportCompanyURL — прямая ссылка на .beacon-world.zip мира; отдаётся по
// cookie-сессии, качается обычной навигацией (Content-Disposition: attachment).
// withAccounts — тащить ли аккаунты игроков и их персонажей.
export function exportCompanyURL(id, withAccounts) {
  return `/api/companies/${id}/export${withAccounts ? "?accounts=1" : ""}`;
}
// importCompany — загрузка .zip мира (multipart, поле "file"), в обход
// apiFetch как uploadFile: браузер сам ставит boundary и шлёт cookie. Создаёт
// новый мир, запускать его ДМ должен сам.
export async function importCompany(file) {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/companies/import", { method: "POST", body: form });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error((data && data.error) || res.statusText || "ошибка импорта");
  }
  return res.json();
}

// fetchVersion — версия сервера (short commit hash из VCS-метаданных сборки,
// см. cmd/beacon-table/version.go), для раздела "Настройки" на экранах ДМ и
// игрока. Публичный эндпойнт, авторизация не нужна.
export async function fetchVersion() {
  return apiFetch("/api/version");
}

// ---- публичное демо ----
// Включён ли демо-режим (кнопка «Посмотреть демо» на входе) и вход гостем.
export async function fetchDemoStatus() {
  try {
    return await apiFetch("/api/demo");
  } catch {
    return { enabled: false };
  }
}
// enterDemo — role: "dm" (гость садится за ширму) или "player" (гость
// садится игроком: сервер выдаёт ему персонажа и ставит токен на карту, см.
// internal/api/http/demo_handlers.go).
export async function enterDemo(role) {
  return apiFetch("/api/demo/guest", { method: "POST", body: JSON.stringify({ role }) });
}

// ---- настройки сервера (раздел «Настройки» у ДМ) ----
// Список полей с их значениями, источником и признаком «можно ли менять
// отсюда» (см. internal/api/http/settings_handlers.go).
export async function fetchServerSettings() {
  return apiFetch("/api/settings");
}

// saveServerSettings — {ключ: значение}. Ответ говорит, каким настройкам
// нужен перезапуск, и отдаёт обновлённый список.
export async function saveServerSettings(values) {
  return apiFetch("/api/settings", { method: "PUT", body: JSON.stringify(values) });
}

// shutdownServer — выключить сервер (только ДМ). Единственный способ
// закончить по-человечески для того, кто запустил программу двойным кликом:
// консоли, где нажать Ctrl+C, у него нет (см. internal/api/http:
// handleShutdown).
export async function shutdownServer() {
  return apiFetch("/api/admin/shutdown", { method: "POST" });
}

// ---- первый запуск ----
// fetchFirstRun — временный пароль ДМ, если сервер запущен на ЭТОМ же
// компьютере и пароль ещё не сменили (см. internal/api/http:
// handleFirstRun). Иначе null: 204 без тела, ошибку тоже глотаем — форма
// входа должна работать в любом случае.
export async function fetchFirstRun() {
  try {
    return await apiFetch("/api/first-run");
  } catch {
    return null;
  }
}

// ---- трансляция (ТВ/проектор) ----
// Ссылка с ключом, по которой экран в комнате получает доступ к столу без
// аккаунта (см. internal/service/broadcast.go). Сервер отдаёт только путь —
// origin подставляем здесь: за обратным прокси своего внешнего адреса он не
// знает.
export async function fetchBroadcastLink() {
  const { key, path } = await apiFetch("/api/broadcast/link");
  return { key, path, url: location.origin + path };
}

// rotateBroadcastLink — перевыпуск ключа: прежняя ссылка перестаёт работать
// сразу у всех экранов, которым её раздали.
export async function rotateBroadcastLink() {
  const { key, path } = await apiFetch("/api/broadcast/link/rotate", { method: "POST" });
  return { key, path, url: location.origin + path };
}

// broadcastAccessGranted — пускают ли этот браузер смотреть трансляцию.
// Нужна самой странице трансляции, чтобы показать понятную подсказку вместо
// чёрного экрана с молча упавшим WebSocket.
export async function broadcastAccessGranted() {
  try {
    await apiFetch("/api/broadcast/access");
    return true;
  } catch {
    return false;
  }
}

// requestBroadcastAccess — заявка экрана, которому ссылку с ключом вбить
// некуда (пульт телевизора — не клавиатура): экран открывает broadcast.html
// как есть, показывает код и ждёт, пока ДМ пустит его со своего стола.
export async function requestBroadcastAccess() {
  return apiFetch("/api/broadcast/requests", { method: "POST" });
}

// broadcastRequestState — что ответил ДМ: "pending" / "approved" /
// "rejected" / "unknown" (заявка истекла — нужна новая). Вместе с "approved"
// сервер кладёт браузеру cookie зрителя, так что ключ нигде не показывается.
export async function broadcastRequestState(id) {
  return apiFetch(`/api/broadcast/requests/${encodeURIComponent(id)}`);
}

// ---- заявки экранов, сторона ДМ ----
export async function fetchBroadcastRequests() {
  return apiFetch("/api/broadcast/requests");
}
export async function approveBroadcastRequest(id) {
  return apiFetch(`/api/broadcast/requests/${encodeURIComponent(id)}/approve`, { method: "POST" });
}
export async function rejectBroadcastRequest(id) {
  return apiFetch(`/api/broadcast/requests/${encodeURIComponent(id)}/reject`, { method: "POST" });
}

// ---- персонажи (свои, по сессии) — web/player.html ----
export async function fetchCharacters() {
  return apiFetch("/api/characters");
}
export async function createCharacter(name, avatarUrl) {
  return apiFetch("/api/characters", { method: "POST", body: JSON.stringify({ name, avatarUrl }) });
}
export async function updateCharacterApi(id, name, avatarUrl) {
  return apiFetch(`/api/characters/${id}`, { method: "PUT", body: JSON.stringify({ name, avatarUrl }) });
}
export async function deleteCharacterApi(id) {
  return apiFetch(`/api/characters/${id}`, { method: "DELETE" });
}

// ---- лист персонажа (D&D 2024) — web/character-sheet.html ----
// Полный персонаж (имя/аватар/sheet), только свой — владелец редактирует.
export async function fetchCharacter(id) {
  return apiFetch(`/api/characters/${id}`);
}
export async function updateCharacterSheet(id, sheet) {
  return apiFetch(`/api/characters/${id}/sheet`, { method: "PUT", body: JSON.stringify(sheet) });
}

// ---- инвентарь персонажа — своя sub-collection, НЕ часть sheet выше (см.
// domain.InventoryEntry, internal/api/http/character_inventory_handlers.go)
// — точечные запросы, не задевают автосейв листа ----
export async function fetchCharacterInventory(id) {
  return apiFetch(`/api/characters/${id}/inventory`);
}
// Добавить предмет из каталога напрямую в свой инвентарь игрок не может (см.
// internal/service/characters.go) — только уменьшать/снимать/надевать то, что
// уже выдал ДМ или удалось забрать через loot-take-modal.js.
export async function updateCharacterInventoryItem(id, entryId, quantity, equipped, notes) {
  return apiFetch(`/api/characters/${id}/inventory/${entryId}`, {
    method: "PUT",
    body: JSON.stringify({ quantity, equipped, notes }),
  });
}
export async function deleteCharacterInventoryItem(id, entryId) {
  return apiFetch(`/api/characters/${id}/inventory/${entryId}`, { method: "DELETE" });
}
// Тот же лист, но ЛЮБОГО персонажа — только для ДМ. ДМ его тоже полноценно
// редактирует (не read-only), поэтому ниже есть и пара PUT рядом со своими.
export async function fetchAdminCharacter(id) {
  return apiFetch(`/api/admin/characters/${id}`);
}
export async function updateAdminCharacter(id, name, avatarUrl) {
  return apiFetch(`/api/admin/characters/${id}`, { method: "PUT", body: JSON.stringify({ name, avatarUrl }) });
}
export async function updateAdminCharacterSheet(id, sheet) {
  return apiFetch(`/api/admin/characters/${id}/sheet`, { method: "PUT", body: JSON.stringify(sheet) });
}

// ---- управление аккаунтами (только ДМ) — web/dm.html ----
export async function fetchAdminAccounts() {
  return apiFetch("/api/admin/accounts");
}
export async function createAdminAccount(username, password, role) {
  return apiFetch("/api/admin/accounts", { method: "POST", body: JSON.stringify({ username, password, role }) });
}
export async function approveAdminAccount(id) {
  return apiFetch(`/api/admin/accounts/${id}/approve`, { method: "POST" });
}
export async function deleteAdminAccount(id) {
  return apiFetch(`/api/admin/accounts/${id}`, { method: "DELETE" });
}
export async function setAdminAccountPassword(id, password) {
  return apiFetch(`/api/admin/accounts/${id}/password`, { method: "POST", body: JSON.stringify({ password }) });
}
export async function fetchAdminCharacters() {
  return apiFetch("/api/admin/characters");
}

// ---- «готовые персонажи» (пул предгенерированных листов мира, см.
// internal/domain/pregen.go) — импорт приключения Foundry складывает сюда
// актёров type "character"; игрок берёт свободного (fetchPregens/claimPregen),
// ДМ управляет пулом (fetch/assign/release/delete) ----

// fetchPregens — свободные пре-гены, которых игрок может взять (краткая
// карточка: id/name/avatarUrl/class/level/species).
export async function fetchPregens() {
  return apiFetch("/api/pregens");
}
// fetchPregen — полный лист одного пре-гена для предпросмотра без захвата
// (character-sheet.html?pregen=<id>, только чтение). Доступен и игроку, и ДМ.
export async function fetchPregen(id) {
  return apiFetch(`/api/pregens/${id}`);
}
// claimPregen — игрок берёт готового персонажа: создаётся обычная запись
// персонажа, принадлежащая ему (возвращается она же, с полным листом).
export async function claimPregen(id) {
  return apiFetch(`/api/pregens/${id}/claim`, { method: "POST" });
}

// fetchAdminPregens — весь пул + статус занятости (claimedBy/claimedByUsername/
// claimedCharacterId) и полный лист. Используется и панелью ДМ, и экраном
// импорта Foundry (createAdminPregen/updateAdminPregen — покарточное
// заведение, тот же контракт, что createMonster/updateMonster).
export async function fetchAdminPregens() {
  return apiFetch("/api/admin/pregens");
}
export async function createAdminPregen(name) {
  return apiFetch("/api/admin/pregens", { method: "POST", body: JSON.stringify({ name }) });
}
export async function updateAdminPregen(id, pregen) {
  return apiFetch(`/api/admin/pregens/${id}`, { method: "PUT", body: JSON.stringify(pregen) });
}
// assignPregen — ДМ назначает пре-гена аккаунту игрока (тот же захват, что и
// claimPregen, но с явным accountId).
export async function assignPregen(id, accountId) {
  return apiFetch(`/api/admin/pregens/${id}/assign`, { method: "POST", body: JSON.stringify({ accountId }) });
}
// releasePregen — вернуть пре-гена в пул (пометка занятости снимается,
// персонаж игрока не трогается).
export async function releasePregen(id) {
  return apiFetch(`/api/admin/pregens/${id}/release`, { method: "POST" });
}
export async function deleteAdminPregen(id) {
  return apiFetch(`/api/admin/pregens/${id}`, { method: "DELETE" });
}

// ---- плейлисты канала ДМ (только ДМ) — web/dm.html: модалка "Плейлисты" ----
export async function fetchAdminPlaylists() {
  return apiFetch("/api/admin/playlists");
}
export async function createPlaylist(name) {
  return apiFetch("/api/admin/playlists", { method: "POST", body: JSON.stringify({ name }) });
}
export async function renamePlaylist(id, name) {
  return apiFetch(`/api/admin/playlists/${id}`, { method: "PUT", body: JSON.stringify({ name }) });
}
export async function deletePlaylist(id) {
  return apiFetch(`/api/admin/playlists/${id}`, { method: "DELETE" });
}
export async function addPlaylistTrack(playlistId, url, name, volume, loop) {
  return apiFetch(`/api/admin/playlists/${playlistId}/tracks`, { method: "POST", body: JSON.stringify({ url, name, volume, loop }) });
}
export async function updatePlaylistTrack(playlistId, trackId, name, volume, loop) {
  return apiFetch(`/api/admin/playlists/${playlistId}/tracks/${trackId}`, { method: "PUT", body: JSON.stringify({ name, volume, loop }) });
}
export async function deletePlaylistTrack(playlistId, trackId) {
  return apiFetch(`/api/admin/playlists/${playlistId}/tracks/${trackId}`, { method: "DELETE" });
}
export async function movePlaylistTrack(playlistId, trackId, direction) {
  return apiFetch(`/api/admin/playlists/${playlistId}/tracks/${trackId}/move`, { method: "POST", body: JSON.stringify({ direction }) });
}

// ---- журнал стола (ДМ и игроки) — web/journal.html ----
// В отличие от заметок ДМ выше, у каждой записи есть автор и права:
// "default" — что достаётся всем за столом ("none" | "limited" | "observer" |
// "owner"), "access" — точечные выдачи {accountId: уровень} (см.
// domain.JournalEntry). Сервер возвращает вместе с записью и уже вычисленные
// для ТЕБЯ myAccess/canEdit/canManage — клиент права не пересчитывает.
export async function fetchJournal() {
  return apiFetch("/api/journal");
}
export async function fetchJournalEntry(id) {
  return apiFetch(`/api/journal/${id}`);
}
// fetchJournalMembers — кому можно раздать права: аккаунты этого мира
// ([{id, username}]). Доступно и игроку — права раздаёт автор записи.
export async function fetchJournalMembers() {
  return apiFetch("/api/journal/members");
}
export async function createJournalEntry({ content, folder = "", def = "none", access = {} } = {}) {
  return apiFetch("/api/journal", {
    method: "POST",
    body: JSON.stringify({ content, folder, default: def, access }),
  });
}
export async function updateJournalEntry(id, content) {
  return apiFetch(`/api/journal/${id}`, { method: "PUT", body: JSON.stringify({ content }) });
}
// setJournalAccess — отдельно от updateJournalEntry: текст автосейвится по
// таймеру при наборе, права меняются осознанным действием в диалоге (см.
// handleJournalAccess на сервере).
export async function setJournalAccess(id, def, access) {
  return apiFetch(`/api/journal/${id}/access`, { method: "PUT", body: JSON.stringify({ default: def, access }) });
}
export async function moveJournalEntry(id, folder) {
  return apiFetch(`/api/journal/${id}/folder`, { method: "PUT", body: JSON.stringify({ folder: folder || "" }) });
}
export async function deleteJournalEntry(id) {
  return apiFetch(`/api/journal/${id}`, { method: "DELETE" });
}

// ---- доски стола (ДМ и игроки) — web/board.html ----
// Права те же, что у записей журнала, и теми же словами (см. domain.Sharing):
// "default" — что достаётся всем за столом, "access" — точечные выдачи.
// Доска с default >= "observer" — общая, с "none" — личная; досок сколько
// угодно одновременно. Кому раздавать — тот же список, что у журнала
// (fetchJournalMembers), отдельного эндпоинта нет.
export async function fetchBoards() {
  return apiFetch("/api/boards");
}
export async function fetchBoard(id) {
  return apiFetch(`/api/boards/${id}`);
}
export async function createBoard({ name, def = "none", access = {} } = {}) {
  return apiFetch("/api/boards", { method: "POST", body: JSON.stringify({ name, default: def, access }) });
}
export async function renameBoard(id, name) {
  return apiFetch(`/api/boards/${id}/name`, { method: "PUT", body: JSON.stringify({ name }) });
}
export async function setBoardAccess(id, def, access) {
  return apiFetch(`/api/boards/${id}/access`, { method: "PUT", body: JSON.stringify({ default: def, access }) });
}
export async function deleteBoard(id) {
  return apiFetch(`/api/boards/${id}`, { method: "DELETE" });
}
// fetchBoardScene — сам холст доски в формате Excalidraw (см.
// internal/excalidraw). Отдельным запросом от fetchBoard: список и шапку
// читают часто, рисунок — только когда доску открыли.
export async function fetchBoardScene(id) {
  return apiFetch(`/api/boards/${id}/scene`);
}
// fetchBoardImages — картинки, уже загруженные на доски этого мира: их можно
// вставить повторно, не заливая тот же файл заново. Отдельно от fetchAssets —
// та библиотека ДМ-ская, а доску правит и игрок.
export async function fetchBoardImages() {
  return apiFetch("/api/board-images");
}
// importBoard — доска из файла Excalidraw: .excalidraw.md из ваулта Obsidian
// либо голый .excalidraw. Имя необязательно: без него сервер возьмёт имя
// файла. Не через apiFetch — тут multipart, а не JSON.
// images — [{name, file}]: картинка и то имя, которым доска называет её в
// разделе «## Embedded Files». В ваулте файлы лежат отдельно, и найти их —
// забота вызывающего (см. importDialog в board-list.js). Ответ, кроме самой доски, говорит, каких
// картинок не хватило и на какие заметки доска ссылается.
export async function importBoard(file, name, images = []) {
  const form = new FormData();
  form.append("file", file);
  if (name) form.append("name", name);
  // Пара «файл + под каким именем его знает доска»: имя из ваулта и имя
  // файла на диске совпадают не всегда (разная нормализация юникода).
  for (const { name, file } of images) {
    form.append("image", file, file.name);
    form.append("imageName", name);
  }
  const res = await fetch("/api/boards/import", { method: "POST", body: form });
  if (!res.ok) throw new Error((await res.text()) || "не удалось импортировать доску");
  return res.json();
}

export async function fetchJournalFolders() {
  return apiFetch("/api/journal-folders");
}
export async function createJournalFolder(folder) {
  return apiFetch("/api/journal-folders", { method: "POST", body: JSON.stringify({ folder }) });
}
export async function renameJournalFolder(from, to) {
  return apiFetch("/api/journal-folders", { method: "PUT", body: JSON.stringify({ from, to }) });
}
// deleteJournalFolder удаляет папку ВМЕСТЕ с записями внутри (игроку сервер
// разрешит только если все они его собственные) — спрашивать обязан UI.
export async function deleteJournalFolder(folder) {
  return apiFetch(`/api/journal-folders?folder=${encodeURIComponent(folder)}`, { method: "DELETE" });
}

// ---- бестиарий ДМ (только ДМ) — web/dm.html: раздел "Бестиарий", web/bestiary.html ----
export async function fetchBestiary() {
  return apiFetch("/api/bestiary");
}
export async function fetchMonster(id) {
  return apiFetch(`/api/bestiary/${id}`);
}
export async function createMonster(name) {
  return apiFetch("/api/bestiary", { method: "POST", body: JSON.stringify({ name }) });
}
export async function updateMonster(id, monster) {
  return apiFetch(`/api/bestiary/${id}`, { method: "PUT", body: JSON.stringify(monster) });
}
export async function deleteMonster(id) {
  return apiFetch(`/api/bestiary/${id}`, { method: "DELETE" });
}

// ---- библиотека заклинаний, общая на весь стол (и ДМ, и игроки) —
// web/dm.html: раздел "Заклинания", web/player.html: модалка "Заклинания",
// web/spellbook.html ----
export async function fetchSpells() {
  return apiFetch("/api/spells");
}
export async function fetchSpell(id) {
  return apiFetch(`/api/spells/${id}`);
}
export async function createSpell(name) {
  return apiFetch("/api/spells", { method: "POST", body: JSON.stringify({ name }) });
}
export async function updateSpell(id, spell) {
  return apiFetch(`/api/spells/${id}`, { method: "PUT", body: JSON.stringify(spell) });
}
export async function deleteSpell(id) {
  return apiFetch(`/api/spells/${id}`, { method: "DELETE" });
}

// ---- библиотека предметов, общая на весь стол (и ДМ, и игроки) —
// web/dm.html: раздел "Предметы", web/player.html: модалка "Предметы",
// web/itembook.html — та же схема доступа, что и у заклинаний ----
export async function fetchItems() {
  return apiFetch("/api/items");
}
export async function fetchItem(id) {
  return apiFetch(`/api/items/${id}`);
}
export async function createItem(name) {
  return apiFetch("/api/items", { method: "POST", body: JSON.stringify({ name }) });
}
export async function updateItem(id, item) {
  return apiFetch(`/api/items/${id}`, { method: "PUT", body: JSON.stringify(item) });
}
export async function deleteItem(id) {
  return apiFetch(`/api/items/${id}`, { method: "DELETE" });
}

// ---- справочник (классы/архетипы/происхождения/виды/черты), общий на весь
// стол (и ДМ, и игроки) — web/dm.html: раздел "Справочник", web/player.html:
// модалка "Справочник", web/referencebook.html — та же схема доступа, что и
// у предметов/заклинаний ----
export async function fetchReferences() {
  return apiFetch("/api/references");
}
export async function fetchReference(id) {
  return apiFetch(`/api/references/${id}`);
}
export async function createReference(name) {
  return apiFetch("/api/references", { method: "POST", body: JSON.stringify({ name }) });
}
export async function updateReference(id, ref) {
  return apiFetch(`/api/references/${id}`, { method: "PUT", body: JSON.stringify(ref) });
}
export async function deleteReference(id) {
  return apiFetch(`/api/references/${id}`, { method: "DELETE" });
}

// ---- состояния (ослепление/испуг/истощение и самодельные метки ДМ), общая
// на весь стол библиотека — web/conditions.html (конструктор), палитра
// быстрого наложения (web/src/status-palette.js), узел "Состояния" в
// компендиуме. Та же схема доступа, что у справочника: читают и правят все
// залогиненные, а вот НАЛОЖЕНИЕ метки на токен/бойца — WS-команды и только
// у ДМ (см. internal/service/room_statuses.go).
//
// Набор зависит от системы запущенного мира (см.
// internal/app.CompanyManager.Launch: systemdata/conditions/<system>) —
// клиенту фильтровать ничего не нужно, сервер и так отдаёт только то, что
// относится к текущему миру.
export async function fetchConditions() {
  return apiFetch("/api/conditions");
}
// fetchModifierTargets — закрытый список того, что модификатор умеет менять
// (см. internal/domain/modifier.go: ModifierTargetLabels). Не содержимое
// стола, а описание формата — нужен конструкторам состояний и предметов,
// чтобы список целей не дублировался константой в JS.
export async function fetchModifierTargets() {
  return apiFetch("/api/modifier-targets");
}
export async function fetchCondition(id) {
  return apiFetch(`/api/conditions/${id}`);
}
export async function createCondition(name) {
  return apiFetch("/api/conditions", { method: "POST", body: JSON.stringify({ name }) });
}
export async function updateCondition(id, cond) {
  return apiFetch(`/api/conditions/${id}`, { method: "PUT", body: JSON.stringify(cond) });
}
export async function deleteCondition(id) {
  return apiFetch(`/api/conditions/${id}`, { method: "DELETE" });
}

// ---- импорт компендиумов из пакетов Foundry VTT (только ДМ, см.
// internal/api/http/foundry_handlers.go, web/foundry-import.html) ----

// inspectFoundryPackage — разведка по ссылке на манифест: сервер скачивает
// и распаковывает архив (первый вызов может идти минуты — модуль с картами
// весит сотни мегабайт) и отдаёт {id,title,version,packs:[{name,label,type,
// count,targets:{раздел:сколько},error}]}. Распакованный модуль остаётся в
// кэше сервера, поэтому последующий importFoundryPack по той же ссылке уже
// не ходит в сеть.
export async function inspectFoundryPackage(url) {
  return apiFetch("/api/foundry/inspect", { method: "POST", body: JSON.stringify({ url }) });
}

// importFoundryPack — импорт ОДНОГО пака. targets — какие разделы брать
// ("items"/"spells"/"monsters"/"references"/"conditions"/"scenes"/
// "playlists"/"notes"), пусто — все. Возвращает {docs:{раздел:[документы
// Foundry]}, applied:{раздел:сколько}, skipped, assets, warnings}: сцены,
// плейлисты и заметки сервер уже разложил сам (applied), а документы
// карточек приезжают сырыми — их маппят те же функции, что и импорт
// одиночного файла (см. web/src/item-import.js и соседей).
export async function importFoundryPack(url, pack, targets) {
  return apiFetch("/api/foundry/import", { method: "POST", body: JSON.stringify({ url, pack, targets }) });
}

// fetchFoundryModules — пакеты Foundry VTT, уже импортированные в этот мир
// (раздел "Настройки"): [{id,title,version,manifestUrl,importedAt}]. Без
// сети — сама проверка новых версий отдельным запросом (см.
// checkFoundryModuleUpdates), чтобы открытие настроек не ждало по манифесту
// на каждый установленный пакет.
// linkFoundrySceneTokens — «доставить статблоки токенам импортированных
// сцен»: сводит токены сцен с карточками бестиария по id актёра Foundry (см.
// internal/service/foundry.go: LinkSceneTokens — там же о том, почему это
// отдельный шаг, а не часть импорта пака). Возвращает {linked: N}.
export async function linkFoundrySceneTokens() {
  return apiFetch("/api/foundry/link-scene-tokens", { method: "POST" });
}

export async function fetchFoundryModules() {
  return apiFetch("/api/foundry/modules");
}

// checkFoundryModuleUpdates — для каждого установленного пакета заново
// скачивает его манифест и сравнивает версию с той, что стояла на момент
// импорта: [{id,title,installedVersion,latestVersion,updateAvailable,error}].
export async function checkFoundryModuleUpdates() {
  return apiFetch("/api/foundry/modules/check", { method: "POST" });
}

// deleteFoundryModule — "Удалить модуль" целиком: карточки (существа/
// заклинания/предметы/справочник/состояния), помеченные его id, файлы,
// скопированные его импортом в библиотеку загрузок, и саму запись об
// установке. Сцены/плейлисты/заметки, заведённые тем же импортом, НЕ трогает
// (см. internal/service/foundry.go: FoundryService.Delete). Возвращает
// {cards:{раздел:сколько удалено},warnings}.
export async function deleteFoundryModule(id) {
  return apiFetch(`/api/foundry/modules/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// Загрузка файла (карта, токен-арт, аватар персонажа или ассет карты) на
// сервер, возвращает {url}. kind — "maps"/"audio"/"props" (только ДМ) или
// "tokens" (любой авторизованный аккаунт — сюда же грузят аватары
// персонажей). folder — необязательная подпапка внутри kind (сейчас реально
// используют только ассеты, см. web/dm.html: раздел "Ассеты"). Авторизация —
// cookie сессии, браузер прикладывает её сам (см. internal/api/http:
// handleUpload), никаких ручных заголовков не нужно.
export async function uploadFile(file, kind, folder) {
  const form = new FormData();
  form.append("file", file);
  if (kind) form.append("kind", kind);
  if (folder) form.append("folder", folder);
  const res = await fetch("/upload", { method: "POST", body: form });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// Список уже загруженных карт/токенов/аудио/ассетов с сервера —
// {maps:[{url,name,path}], tokens:[...], audio:[...], props:[...],
// folders:{props:[{path}], ...}}. Только для ДМ (см. internal/api/http:
// handleAssets).
export async function fetchAssets() {
  const res = await fetch("/assets");
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// Папки библиотеки ассетов — создание/удаление (см. internal/api/http:
// handleAssetFolderCreate/handleAssetFolderDelete). path — полный путь от
// корня kind, posix-разделители ("Огонь/Костры").
export async function createAssetFolder(kind, path) {
  return apiFetch("/api/asset-folders", { method: "POST", body: JSON.stringify({ kind, path }) });
}
export async function deleteAssetFolder(kind, path) {
  return apiFetch(`/api/asset-folders?kind=${encodeURIComponent(kind)}&path=${encodeURIComponent(path)}`, { method: "DELETE" });
}

// Удаление одного файла библиотеки ассетов по его URL (см.
// internal/api/http: handleAssetDelete).
export async function deleteAsset(kind, url) {
  return apiFetch(`/api/assets?kind=${encodeURIComponent(kind)}&url=${encodeURIComponent(url)}`, { method: "DELETE" });
}
