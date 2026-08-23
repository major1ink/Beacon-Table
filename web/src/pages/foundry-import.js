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
  fetchNotes, fetchNote, createNote, updateNote,
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
  // Заметки: текст и папку готовит сервер (см. service.FoundryImport.Notes),
  // но заводит их эта страница — потому что заметка с тем же названием в той
  // же папке может уже существовать, и что с ней делать, решает ДМ (см.
  // importNotes).
  { id: "notes", label: "Заметки ДМ", notes: true },
  // Ниже — то, что раскладывает сам сервер (см. foundry.ServerSideTargets):
  // здесь у них нет ни маппера, ни создания — только галочка и счётчик.
  { id: "scenes", label: "Сцены", server: true },
  { id: "playlists", label: "Плейлисты", server: true },
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
// noteConflictDefault — ответ ДМ «применить ко всем» из диалога про
// совпавшую заметку ("overwrite" | "duplicate" | "skip"); сбрасывается на
// каждый запуск импорта.
let noteConflictDefault = null;

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
  noteConflictDefault = null;
  importBtn.disabled = true;
  urlInput.disabled = true;
  inspectBtn.disabled = true;
  cancelBtn.style.display = "";
  const total = { created: 0, applied: 0, updated: 0, skipped: 0, failed: 0, assets: 0 };

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
    if ((result.notes || []).length) {
      const stats = await importNotes(result.notes, p);
      total.created += stats.created;
      total.updated += stats.updated;
      total.skipped += stats.skipped;
      total.failed += stats.failed;
    }
    for (const t of TARGETS) {
      if (t.server || t.notes) continue;
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
    `Создано: ${total.created}, сцен и плейлистов: ${total.applied}, ` +
    (total.updated ? `перезаписано заметок: ${total.updated}, ` : "") +
    (total.skipped ? `пропущено без изменений: ${total.skipped}, ` : "") +
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

// ==================== заметки ====================

// noteKey — по чему считаем, что «такая заметка уже есть»: папка + заголовок.
// Не по содержимому (тогда любая правка ДМ выглядела бы новой записью) и не
// по одному заголовку (одноимённые «Обзор» в разных главах — норма).
function noteKey(folder, title) {
  return (folder || "") + " " + (title || "").trim().toLowerCase();
}

// sameNoteText — содержимое совпадает «полностью». Переводы строк и хвостовые
// пробелы не в счёт: они меняются от одного сохранения в редакторе.
function sameNoteText(a, b) {
  const norm = (s) => (s || "").replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
  return norm(a) === norm(b);
}

// importNotes заводит подготовленные сервером заметки, разбираясь с
// совпадениями: одинаковую пропускаем молча, различающуюся — как скажет ДМ.
async function importNotes(notes, pack) {
  const stats = { created: 0, updated: 0, skipped: 0, failed: 0 };
  let index;
  try {
    index = new Map((await fetchNotes()).map((n) => [noteKey(n.folder, n.title), n]));
  } catch (err) {
    log(`  Заметки ДМ: не удалось прочитать библиотеку — ${err.message}`);
    stats.failed += notes.length;
    return stats;
  }

  for (let i = 0; i < notes.length; i++) {
    if (cancelled) break;
    const note = notes[i];
    setStatus(`${pack.label || pack.name} → Заметки ДМ: ${i + 1} из ${notes.length}…`, { busy: true });
    setProgress((packProgress.done + (i + 1) / notes.length) / packProgress.total);

    const existing = index.get(noteKey(note.folder, note.title));
    let action = "create";
    if (existing) {
      let current;
      try {
        current = await fetchNote(existing.id);
      } catch (err) {
        stats.failed++;
        console.warn(`[${pack.name}] ${note.title}: ${err.message}`);
        continue;
      }
      if (sameNoteText(current.content, note.content)) {
        stats.skipped++;
        continue;
      }
      action = noteConflictDefault || (await askNoteConflict(note, current));
      if (action === "stop") {
        cancelled = true;
        break;
      }
      if (action === "skip") {
        stats.skipped++;
        continue;
      }
    }

    try {
      if (action === "overwrite") {
        await updateNote(existing.id, note.content);
        stats.updated++;
      } else {
        const created = await createNote(note.content, note.folder);
        // Дубликат кладём в индекс под тем же ключом только если его там
        // ещё нет: иначе следующая такая же заметка сравнивалась бы с
        // копией, а не с оригиналом.
        if (!index.has(noteKey(note.folder, note.title))) {
          index.set(noteKey(note.folder, note.title), { id: created.id, title: created.title, folder: created.folder });
        }
        stats.created++;
      }
    } catch (err) {
      stats.failed++;
      console.warn(`[${pack.name}] ${note.title}: ${err.message}`);
    }
  }

  const parts = [`создано ${stats.created}`];
  if (stats.updated) parts.push(`перезаписано ${stats.updated}`);
  if (stats.skipped) parts.push(`пропущено ${stats.skipped}`);
  if (stats.failed) parts.push(`ошибок ${stats.failed}`);
  log(`  Заметки ДМ: ${parts.join(", ")} (из ${notes.length})`);
  return stats;
}

// askNoteConflict — диалог «заметка уже есть, но отличается». confirm() тут
// не годится: вариантов больше двух, да и показать, ЧЕМ отличается (папка,
// размер, дата), надо. Возвращает "overwrite" | "duplicate" | "skip" |
// "stop"; галочка «ко всем остальным» запоминается в noteConflictDefault.
function askNoteConflict(note, existing) {
  return new Promise((resolve) => {
    const overlay = h("div", { class: "modal-overlay" });
    const applyAll = h("input", { type: "checkbox", id: "noteConflictAll" });

    const finish = (action) => {
      if (applyAll.checked && action !== "stop") noteConflictDefault = action;
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(action);
    };
    const onKey = (e) => {
      if (e.key === "Escape") finish("skip");
    };

    const button = (label, action, primary) =>
      h("button", { class: primary ? "primary" : "", text: label, onclick: () => finish(action) });

    overlay.appendChild(
      h("div", { class: "modal" }, [
        h("h3", { text: "Такая заметка уже есть" }),
        h("p", { class: "hint" }, [
          `«${note.title}» в папке «${note.folder || "корень библиотеки"}» уже существует, ` +
            "но содержимое отличается от того, что в модуле.",
        ]),
        h("dl", { class: "modal-diff" }, [
          h("dt", { text: "В библиотеке" }),
          h("dd", { text: `${(existing.content || "").length} символов, изменена ${formatWhen(existing.updatedAt)}` }),
          h("dt", { text: "В модуле" }),
          h("dd", { text: `${note.content.length} символов` }),
        ]),
        h("div", { class: "modal-buttons" }, [
          button("Перезаписать", "overwrite", true),
          button("Оставить обе", "duplicate"),
          button("Пропустить", "skip"),
          button("Остановить импорт", "stop"),
        ]),
        h("label", { class: "modal-all" }, [applyAll, "Так же поступать со всеми остальными"]),
      ])
    );
    document.body.appendChild(overlay);
    document.addEventListener("keydown", onKey);
  });
}

function formatWhen(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "—" : d.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
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
