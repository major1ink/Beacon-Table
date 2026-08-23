// foundry-import.js — импорт компендиумов целого пакета Foundry VTT по
// ссылке на манифест (см. web/foundry-import.html, открывается плавающим
// окном из панели «Справочник», только у ДМ).
//
// Разделение труда с сервером ровно то же, что и у импорта одиночного файла:
// контейнер (скачать архив, распаковать, вытащить документы из LevelDB/NeDB,
// перенести картинки и треки в библиотеку загрузок) — на сервере (см.
// internal/foundry), формат карточек dnd5e — здесь, теми же чистыми
// функциями, что и раньше (item-import.js и соседи). Сцены, плейлисты и
// заметки сервер раскладывает сам — у них клиентского маппера нет, здесь
// они только считаются в отчёте.
//
// Импорт идёт пак за паком, а не одним запросом: так виден прогресс и ответ
// не разрастается до сотен мегабайт на большом модуле.
import {
  fetchMe, inspectFoundryPackage, importFoundryPack,
  createItem, updateItem,
  createSpell, updateSpell,
  createMonster, updateMonster,
  createReference, updateReference,
  createCondition, updateCondition,
} from "../api.js";
import { mapFoundryItemJson } from "../item-import.js";
import { mapFoundrySpellJson } from "../spell-import.js";
import { mapFoundryMonsterJson } from "../monster-import.js";
import { mapFoundryReferenceBatch } from "../reference-import.js";
import { mapFoundryConditionBatch } from "../condition-import.js";

// tokenArt/itemArt — картинка документа Foundry. Мапперы карточек её не
// трогают (существу/предмету арт задаёт ДМ, а не экспорт), но при импорте
// целого пака сервер уже перенёс файл в /uploads и переписал ссылку — грех
// не подставить. У существа арт токена приоритетнее портрета: на карте
// стоять будет именно он.
function tokenArt(doc) {
  const token = doc.prototypeToken || doc.token || {};
  const texture = token.texture || {};
  return texture.src || token.img || doc.img || "";
}
function itemArt(doc) {
  return doc.img || "";
}

// TARGETS — разделы стола, по которым разъезжается пакет. Порядок задаёт и
// порядок галочек, и порядок импорта внутри пака.
const TARGETS = [
  { id: "monsters", label: "Существа", createOne: createMonster, updateOne: updateMonster, mapOne: mapFoundryMonsterJson, art: tokenArt },
  { id: "spells", label: "Заклинания", createOne: createSpell, updateOne: updateSpell, mapOne: mapFoundrySpellJson },
  { id: "items", label: "Снаряжение", createOne: createItem, updateOne: updateItem, mapOne: mapFoundryItemJson, art: itemArt },
  { id: "references", label: "Справочник", createOne: createReference, updateOne: updateReference, mapBatch: mapFoundryReferenceBatch },
  { id: "conditions", label: "Состояния", createOne: createCondition, updateOne: updateCondition, mapBatch: mapFoundryConditionBatch },
  // Ниже — то, что раскладывает сам сервер (см. foundry.ServerSideTargets):
  // здесь у них нет ни маппера, ни создания — только галочка и счётчик.
  { id: "scenes", label: "Сцены", server: true },
  { id: "playlists", label: "Плейлисты", server: true },
  { id: "notes", label: "Заметки ДМ", server: true },
];
const TARGET_BY_ID = Object.fromEntries(TARGETS.map((t) => [t.id, t]));

// ==================== состояние ====================

let pkg = null; // ответ /api/foundry/inspect
let manifestUrl = "";
const selectedPacks = new Set();
const selectedTargets = new Set(TARGETS.map((t) => t.id));
let running = false;
let cancelled = false;
// packProgress — сколько паков уже позади из скольких; нужен importCards,
// чтобы посчитать общую долю (см. setProgress).
let packProgress = { done: 0, total: 1 };

// ==================== DOM ====================

const urlForm = document.getElementById("urlForm");
const urlInput = document.getElementById("manifestUrl");
const inspectBtn = document.getElementById("inspectBtn");
const statusEl = document.getElementById("status");
const progressEl = document.getElementById("progress");
const progressBarEl = document.getElementById("progressBar");
const packsSection = document.getElementById("packsSection");
const packsEl = document.getElementById("packs");
const targetsEl = document.getElementById("targets");
const importBtn = document.getElementById("importBtn");
const cancelBtn = document.getElementById("cancelBtn");
const logPane = document.getElementById("logPane");
const logEl = document.getElementById("log");
const logClearBtn = document.getElementById("logClearBtn");

// setStatus — строка состояния. busy рисует рядом крутилку: и разведка
// (сервер тем временем качает и распаковывает сотню мегабайт), и импорт
// идут минутами, и без явного признака работы это выглядит как зависание.
function setStatus(text, { busy = false, error = false } = {}) {
  statusEl.textContent = "";
  if (busy) statusEl.appendChild(h("span", { class: "spinner" }));
  statusEl.appendChild(document.createTextNode(text || ""));
  statusEl.classList.toggle("error", error);
}

// setProgress — полоска под строкой состояния. Без аргументов прячет её,
// с null — «работаем, но сколько осталось, неизвестно» (скачивание архива),
// с числом 0..1 — обычный прогресс по карточкам.
function setProgress(value) {
  if (value === undefined) {
    progressEl.style.display = "none";
    progressEl.classList.remove("indeterminate");
    progressBarEl.style.width = "0";
    return;
  }
  progressEl.style.display = "block";
  if (value === null) {
    progressEl.classList.add("indeterminate");
    progressBarEl.style.width = "";
    return;
  }
  progressEl.classList.remove("indeterminate");
  progressBarEl.style.width = Math.round(Math.max(0, Math.min(1, value)) * 100) + "%";
}

function log(line) {
  logPane.style.display = "flex";
  logEl.textContent += (logEl.textContent ? "\n" : "") + line;
  logEl.scrollTop = logEl.scrollHeight;
}

logClearBtn.addEventListener("click", () => {
  logEl.textContent = "";
  logPane.style.display = "none";
});

function h(tag, attrs, children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(children || [])) {
    if (c === undefined || c === null || c === false) continue;
    e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
}

// ==================== разведка ====================

urlForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;
  manifestUrl = url;
  inspectBtn.disabled = true;
  inspectBtn.textContent = "Проверяем…";
  packsSection.style.display = "none";
  // Полоска «неизвестно сколько»: сервер качает архив целиком и о ходе
  // загрузки не отчитывается, но молчащая страница выглядит зависшей.
  setProgress(null);
  setStatus("Скачиваем и распаковываем пакет… Первый раз это может занять несколько минут — архив модуля тянется целиком.", { busy: true });
  try {
    pkg = await inspectFoundryPackage(url);
  } catch (err) {
    setStatus("Не получилось: " + err.message, { error: true });
    setProgress();
    return;
  } finally {
    inspectBtn.disabled = false;
    inspectBtn.textContent = "Проверить";
  }
  setProgress();
  selectedPacks.clear();
  for (const p of pkg.packs || []) {
    if (!p.error && p.count > 0) selectedPacks.add(p.name);
  }
  renderPackage();
});

function renderPackage() {
  setStatus(`${pkg.title}${pkg.version ? " " + pkg.version : ""} — компендиумов: ${(pkg.packs || []).length}`);
  renderTargets();
  renderPacks();
  packsSection.style.display = "";
}

function renderTargets() {
  targetsEl.innerHTML = "";
  for (const t of TARGETS) {
    const box = h("input", { type: "checkbox" });
    box.checked = selectedTargets.has(t.id);
    box.addEventListener("change", () => {
      if (box.checked) selectedTargets.add(t.id);
      else selectedTargets.delete(t.id);
      renderPacks(); // счётчики пака показывают только выбранные разделы
    });
    targetsEl.appendChild(h("label", {}, [box, t.label]));
  }
}

function renderPacks() {
  packsEl.innerHTML = "";
  for (const p of pkg.packs || []) {
    const box = h("input", { type: "checkbox" });
    box.checked = selectedPacks.has(p.name);
    box.disabled = !!p.error || !p.count;
    box.addEventListener("change", () => {
      if (box.checked) selectedPacks.add(p.name);
      else selectedPacks.delete(p.name);
    });

    const chips = h("div", { class: "chips" });
    for (const [target, count] of Object.entries(p.targets || {})) {
      if (target === "skipped" || !selectedTargets.has(target)) continue;
      chips.appendChild(h("span", { class: "chip", text: `${TARGET_BY_ID[target].label}: ${count}` }));
    }
    if (!chips.children.length && !p.error) {
      chips.appendChild(h("span", { class: "chip", text: "нечего переносить" }));
    }

    const meta = [p.type, p.system].filter(Boolean).join(" · ");
    packsEl.appendChild(
      h("div", { class: "pack-row" }, [
        h("label", {}, [
          box,
          h("span", { class: "pack-name", text: p.label || p.name }),
          h("span", { class: "pack-meta", text: meta }),
        ]),
        p.error ? h("span", { class: "hint error", text: p.error }) : chips,
      ])
    );
  }
}

// ==================== импорт ====================

cancelBtn.addEventListener("click", () => {
  cancelled = true;
  setStatus("Останавливаем после текущей карточки…", { busy: true });
});

importBtn.addEventListener("click", async () => {
  if (running) return;
  const packs = (pkg.packs || []).filter((p) => selectedPacks.has(p.name));
  if (!packs.length) {
    setStatus("Не выбран ни один компендиум.", { error: true });
    return;
  }
  const targets = [...selectedTargets];
  if (!targets.length) {
    setStatus("Не выбран ни один раздел.", { error: true });
    return;
  }

  running = true;
  cancelled = false;
  importBtn.disabled = true;
  urlInput.disabled = true;
  inspectBtn.disabled = true;
  cancelBtn.style.display = "";
  const total = { created: 0, applied: 0, failed: 0, assets: 0 };

  for (let packIndex = 0; packIndex < packs.length; packIndex++) {
    const p = packs[packIndex];
    if (cancelled) break;
    // packProgress — доля уже пройденных паков; внутри пака importCards
    // добавляет к ней долю своих карточек, чтобы полоска ехала непрерывно,
    // а не прыгала на границе паков.
    packProgress = { done: packIndex, total: packs.length };
    setProgress(packIndex / packs.length);
    log(`— ${p.label || p.name}`);
    setStatus(`Читаем «${p.label || p.name}»…`, { busy: true });
    let result;
    try {
      result = await importFoundryPack(manifestUrl, p.name, targets);
    } catch (err) {
      log(`  ошибка: ${err.message}`);
      total.failed++;
      continue;
    }
    total.assets += result.assets || 0;
    if (result.assetsMissing) {
      // Официальные компендиумы ссылаются иконками на ассеты самого Foundry
      // ("icons/magic/…") — их в архиве модуля нет и быть не может, карточки
      // просто приедут без картинок. Пишем числом, чтобы это не выглядело
      // сбоем импорта.
      log(`  файлов не нашлось в архиве: ${result.assetsMissing} (обычно это иконки самого Foundry)`);
    }
    for (const [target, count] of Object.entries(result.applied || {})) {
      if (!count) continue;
      total.applied += count;
      log(`  ${TARGET_BY_ID[target].label}: ${count} (разложено сервером)`);
    }
    for (const t of TARGETS) {
      if (t.server) continue;
      const docs = (result.docs || {})[t.id] || [];
      if (!docs.length) continue;
      const stats = await importCards(t, docs, p);
      total.created += stats.ok;
      total.failed += stats.failed;
      if (cancelled) break;
    }
    for (const warning of result.warnings || []) log(`  ! ${warning}`);
  }

  running = false;
  importBtn.disabled = false;
  urlInput.disabled = false;
  inspectBtn.disabled = false;
  cancelBtn.style.display = "none";
  setProgress();
  const summary =
    (cancelled ? "Остановлено. " : "Готово. ") +
    `Карточек создано: ${total.created}, сцен/плейлистов/заметок: ${total.applied}, ` +
    `файлов перенесено: ${total.assets}` +
    (total.failed ? `, ошибок: ${total.failed} (подробности в журнале ниже и в консоли браузера)` : "");
  setStatus(summary);
  log(summary);
  // Списки открытых окон компендиума обновятся сами по этим сообщениям —
  // тот же механизм, которым карточка сообщает о своей правке (см.
  // floating-window.js: postToOpenWindows).
  notifySaved();
});

// importCards — маппинг и заведение карточек одного раздела. Батчевые
// мапперы (справочник, состояния) получают весь пак разом: архетипу нужно
// найти класс-родителя среди соседей, а состояния схлопываются по slug (см.
// reference-import.js/condition-import.js).
async function importCards(target, docs, pack) {
  const mapped = target.mapBatch
    ? target.mapBatch(docs)
    : docs.map((doc) => {
        try {
          const card = target.mapOne(doc);
          if (target.art && !card.imageUrl) card.imageUrl = target.art(doc);
          return card;
        } catch (err) {
          console.warn(`[${pack.name}] ${doc && doc.name}: ${err.message}`);
          return null;
        }
      });

  let ok = 0;
  let failed = 0;
  const list = mapped.filter(Boolean);
  failed += mapped.length - list.length;
  for (let i = 0; i < list.length; i++) {
    if (cancelled) break;
    const card = list[i];
    if (i % 5 === 0 || i === list.length - 1) {
      setStatus(`${pack.label || pack.name} → ${target.label}: ${i + 1} из ${list.length}…`, { busy: true });
      setProgress((packProgress.done + (i + 1) / list.length) / packProgress.total);
    }
    try {
      const created = await target.createOne(card.name);
      await target.updateOne(created.id, Object.assign({}, created, card));
      ok++;
    } catch (err) {
      failed++;
      console.warn(`[${pack.name}] ${card.name}: ${err.message}`);
    }
  }
  log(`  ${target.label}: ${ok} из ${docs.length}` + (failed ? `, не удалось ${failed}` : ""));
  return { ok, failed };
}

// notifySaved — те же сообщения, что шлёт отредактированная карточка:
// открытые списки компендиума (catalog.js) на них перечитывают себя.
function notifySaved() {
  const messages = ["beacon:monsterSaved", "beacon:spellSaved", "beacon:itemSaved", "beacon:referenceSaved", "beacon:conditionSaved"];
  const target = window.parent !== window ? window.parent : window;
  for (const type of messages) target.postMessage({ type }, location.origin);
}

// ==================== закрыть / boot ====================

// CLOSE_WARNING — один текст на все три двери наружу: ✕ этой страницы, ✕
// плавающего окна (его рисует родитель, см. floating-window.js:
// beaconCloseGuard) и закрытие вкладки браузера.
const CLOSE_WARNING =
  "Импорт ещё идёт. Если закрыть окно, он прервётся на текущей карточке — " +
  "уже созданные записи останутся, остальные не импортируются. Прервать импорт?";

// beaconCloseGuard — контракт с floating-window.js: родитель спрашивает у
// встроенной страницы, можно ли её закрывать, и показывает вернувшийся текст
// в confirm. Пусто/нет функции — закрывать молча, как у всех остальных
// страниц в плавающих окнах.
window.beaconCloseGuard = () => (running ? CLOSE_WARNING : "");

// Отдельное окно браузера (кнопка 🗗 или открытая напрямую страница): там
// родителя нет, сторожит стандартный диалог самого браузера. Свой текст он
// показать не даст — покажет собственную формулировку про несохранённые
// изменения, это ожидаемо.
window.addEventListener("beforeunload", (e) => {
  if (!running) return;
  e.preventDefault();
  e.returnValue = "";
});

document.getElementById("closeBtn").onclick = () => {
  if (running && !confirm(CLOSE_WARNING)) return;
  cancelled = true; // импорт остановится на текущей карточке, даже если окно ещё живо
  if (window.parent !== window) {
    window.parent.postMessage({ type: "beacon:closeFloatingWindow" }, location.origin);
  } else {
    window.close();
  }
};

(async function boot() {
  const me = await fetchMe();
  if (!me) {
    location.href = "/";
    return;
  }
  // "admin" — роль аккаунта ДМ (см. domain.Account.Role, не путать с
  // ClientRole комнаты), та же проверка, что в dm.js/bestiary.js.
  if (me.role !== "admin") {
    packsSection.style.display = "none";
    urlForm.style.display = "none";
    setStatus("Импорт пакетов Foundry доступен только ДМ.", true);
  }
})();
