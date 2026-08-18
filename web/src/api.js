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
export async function deleteCompany(id) {
  return apiFetch(`/api/companies/${id}`, { method: "DELETE" });
}

// fetchVersion — версия сервера (short commit hash из VCS-метаданных сборки,
// см. cmd/beacon-table/version.go), для раздела "Настройки" на экранах ДМ и
// игрока. Публичный эндпойнт, авторизация не нужна.
export async function fetchVersion() {
  return apiFetch("/api/version");
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
export async function addCharacterInventoryItem(id, itemId, quantity) {
  return apiFetch(`/api/characters/${id}/inventory`, { method: "POST", body: JSON.stringify({ itemId, quantity }) });
}
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

// ---- заметки ДМ (только ДМ) — web/dm.html: раздел "Заметки", web/note-window.html ----
export async function fetchNotes() {
  return apiFetch("/api/notes");
}
export async function fetchNote(id) {
  return apiFetch(`/api/notes/${id}`);
}
export async function createNote(content) {
  return apiFetch("/api/notes", { method: "POST", body: JSON.stringify({ content }) });
}
export async function updateNote(id, content) {
  return apiFetch(`/api/notes/${id}`, { method: "PUT", body: JSON.stringify({ content }) });
}
export async function deleteNote(id) {
  return apiFetch(`/api/notes/${id}`, { method: "DELETE" });
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
