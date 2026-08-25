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
  fetchMe, inspectFoundryPackage, importFoundryPack, linkFoundrySceneTokens,
  fetchItems, createItem, updateItem,
  fetchSpells, createSpell, updateSpell,
  fetchBestiary, createMonster, updateMonster,
  fetchReferences, createReference, updateReference,
  fetchConditions, createCondition, updateCondition,
  fetchNotes, fetchNote, createNote, updateNote,
  fetchJournal, fetchJournalEntry, createJournalEntry, updateJournalEntry,
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
// fetchAll у карточек — не только для галочки в отчёте: по этому списку
// импорт проверяет, нет ли такой карточки в библиотеке уже (см. importCards).
const TARGETS = [
  // linkField — куда положить id исходного документа Foundry. Только у
  // существ: по нему потом сойдутся карточка бестиария и токены, уже
  // стоящие на импортированных сценах (см. domain.Token.FoundryActorID и
  // вызов linkFoundrySceneTokens в конце импорта).
  { id: "monsters", label: "Существа", fetchAll: fetchBestiary, createOne: createMonster, updateOne: updateMonster, mapOne: mapFoundryMonsterJson, art: tokenArt, linkField: "foundryActorId" },
  { id: "spells", label: "Заклинания", fetchAll: fetchSpells, createOne: createSpell, updateOne: updateSpell, mapOne: mapFoundrySpellJson },
  { id: "items", label: "Снаряжение", fetchAll: fetchItems, createOne: createItem, updateOne: updateItem, mapOne: mapFoundryItemJson, art: itemArt },
  { id: "references", label: "Справочник", fetchAll: fetchReferences, createOne: createReference, updateOne: updateReference, mapBatch: mapFoundryReferenceBatch },
  { id: "conditions", label: "Состояния", fetchAll: fetchConditions, createOne: createCondition, updateOne: updateCondition, mapBatch: mapFoundryConditionBatch },
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

// NOTE_DESTINATIONS — куда класть журналы модуля. В Foundry весь сюжет
// приключения лежит в JournalEntry, и у него два разумных адреса на столе:
//   notes   — личная вики ДМ (как было всегда): текст приключения, врезки
//             для Мастера, то, что игрокам видеть рано;
//   journal — журнал стола (см. web/journal.html): то, чем ДМ будет
//             делиться — раздаточные материалы, карты для игроков, хроника.
// Различаются только четырьмя операциями над хранилищем, поэтому сам импорт
// (importNotes) их не различает вовсе — получает готовый набор.
//
// Записи журнала заводятся ЗАКРЫТЫМИ (default: "none"): импорт приключения
// не должен разом выложить игрокам всё, включая ответы. Открыть нужное — уже
// осознанное действие ДМ в диалоге прав.
const NOTE_DESTINATIONS = {
  notes: {
    id: "notes",
    label: "Заметки ДМ",
    fetchAll: fetchNotes,
    fetchOne: fetchNote,
    create: (note) => createNote(note.content, note.folder),
    update: (id, content) => updateNote(id, content),
  },
  journal: {
    id: "journal",
    label: "Журнал стола",
    fetchAll: fetchJournal,
    fetchOne: fetchJournalEntry,
    create: (note) => createJournalEntry({ content: note.content, folder: note.folder, def: "none" }),
    update: (id, content) => updateJournalEntry(id, content),
  },
};

// ==================== состояние ====================

let pkg = null; // ответ /api/foundry/inspect
let manifestUrl = "";
const selectedPacks = new Set();
const selectedTargets = new Set(TARGETS.map((t) => t.id));
// notesToJournal — галочка «журналы → журнал стола» (см. NOTE_DESTINATIONS).
// По умолчанию выключена: прежнее поведение — сюжет в заметки ДМ.
let notesToJournal = false;

function noteDestination() {
  return notesToJournal ? NOTE_DESTINATIONS.journal : NOTE_DESTINATIONS.notes;
}

// targetLabel — подпись раздела в чипах пака и в отчёте. У журналов она
// зависит от галочки: «Заметки ДМ: 4» или «Журнал стола: 4» — иначе отчёт
// говорил бы не туда, куда всё поехало.
function targetLabel(id) {
  return id === "notes" ? noteDestination().label : TARGET_BY_ID[id].label;
}
let running = false;
let cancelled = false;
// packProgress — сколько паков уже позади из скольких; нужен importCards,
// чтобы посчитать общую долю (см. setProgress).
let packProgress = { done: 0, total: 1 };
// conflictDefaults — ответ ДМ «так же поступать с остальными» из диалога о
// совпавшей записи, ПО РАЗДЕЛАМ: id раздела → "overwrite" | "duplicate" |
// "skip" (см. resolveConflict). Сбрасывается на каждый запуск импорта.
let conflictDefaults = {};

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
  // toJournalBox — подчинённая галочка «журналы → в журнал стола»; её
  // доступность зависит от галочки самих журналов, поэтому держим ссылку и
  // правим точечно. Перерисовывать весь список на каждое переключение
  // нельзя: клик по одной галочке подменял бы DOM-узлы всех остальных.
  let toJournalBox = null;
  for (const t of TARGETS) {
    const box = h("input", { type: "checkbox" });
    box.checked = selectedTargets.has(t.id);
    box.addEventListener("change", () => {
      if (box.checked) selectedTargets.add(t.id);
      else selectedTargets.delete(t.id);
      if (t.id === "notes" && toJournalBox) toJournalBox.disabled = !box.checked;
      renderPacks(); // счётчики пака показывают только выбранные разделы
    });
    targetsEl.appendChild(h("label", {}, [box, t.id === "notes" ? "Журналы" : t.label]));

    // Куда именно кладём журналы — подчинённая галочка сразу под своим
    // разделом, а не отдельная настройка где-то в стороне: она осмысленна
    // только когда журналы вообще импортируются.
    if (t.id === "notes") {
      toJournalBox = h("input", { type: "checkbox" });
      toJournalBox.checked = notesToJournal;
      toJournalBox.disabled = !selectedTargets.has("notes");
      toJournalBox.addEventListener("change", () => {
        notesToJournal = toJournalBox.checked;
        renderPacks();
      });
      targetsEl.appendChild(
        h(
          "label",
          {
            class: "sub-target",
            title:
              "Иначе журналы модуля едут в личные заметки ДМ. В журнал они лягут закрытыми — откроешь игрокам те, что нужно",
          },
          [toJournalBox, "→ в журнал стола"]
        )
      );
    }
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
      chips.appendChild(h("span", { class: "chip", text: `${targetLabel(target)}: ${count}` }));
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
  conflictDefaults = {};
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
      log(`  ${targetLabel(target)}: ${count} (разложено сервером)`);
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
      total.created += stats.created;
      total.updated += stats.updated;
      total.skipped += stats.skipped;
      total.failed += stats.failed;
      if (cancelled) break;
    }
    for (const warning of result.warnings || []) log(`  ! ${warning}`);
  }

  // Токены на импортированных сценах — это фигурки существ, но статблок им
  // на этапе разбора сцены взять было неоткуда: карточки существ приезжают
  // ДРУГИМ паком и заводятся уже здесь, в браузере (см.
  // internal/foundry/scene.go: mapToken сохраняет только id актёра). Теперь,
  // когда весь импорт позади, просим сервер свести одно с другим.
  //
  // Зовём даже после остановки на полпути (cancelled): часть карточек уже
  // заведена, и статблоки для них — уже польза. Промах здесь не должен
  // выглядеть провалом импорта — всё остальное уже на месте, а шаг можно
  // повторить следующим импортом, он идемпотентен.
  try {
    const { linked } = await linkFoundrySceneTokens();
    if (linked) log(`Статблоки подставлены токенам на импортированных сценах: ${linked}`);
  } catch (err) {
    log(`  ! статблоки токенам сцен подставить не удалось: ${err.message}`);
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
    (total.updated ? `перезаписано: ${total.updated}, ` : "") +
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

// cardKey — по чему считаем, что «такая карточка уже есть». Имя (без учёта
// регистра и лишних пробелов) — то, что видит ДМ в списке и по чему на
// карточку ссылаются описания (см. web/src/catalog-links.js). У состояний
// ключ машинный — slug: именно им состояние вешается на токен, и два
// «Ослепления» с одним slug'ом — точно одна и та же карточка.
function cardKey(target, card) {
  if (target.id === "conditions" && card.slug) return "slug:" + String(card.slug).trim().toLowerCase();
  return (card.name || "").trim().toLowerCase();
}

// sameCard — импорт НИЧЕГО не изменит в существующей карточке: каждое поле,
// которое он собирается записать, уже там такое же. Сравниваем только
// importируемые поля — то, что ДМ дописал сам (свои теги, заметки в
// описании соседних полей), карточку «изменившейся» не делает.
function sameCard(existing, mapped) {
  for (const [key, value] of Object.entries(mapped)) {
    const before = existing[key];
    const isComposite = (v) => v !== null && typeof v === "object";
    if (isComposite(value) || isComposite(before)) {
      if (JSON.stringify(before ?? null) !== JSON.stringify(value ?? null)) return false;
      continue;
    }
    if (String(before ?? "") !== String(value ?? "")) return false;
  }
  return true;
}

// importCards — маппинг и заведение карточек одного раздела. Батчевые
// мапперы (справочник, состояния) получают весь пак разом: архетипу нужно
// найти класс-родителя среди соседей, а состояния схлопываются по slug (см.
// reference-import.js/condition-import.js).
//
// Совпадения разбираются так же, как у заметок (см. importNotes): точно
// такая же карточка пропускается молча, отличающаяся — как решит ДМ.
async function importCards(target, docs, pack) {
  const stats = { created: 0, updated: 0, skipped: 0, failed: 0 };
  // sourceIds — карточка -> _id документа Foundry, из которого она собрана.
  // Отдельная карта, а не поле карточки: якорь проставляется ПОСЛЕ сравнения
  // "не изменилась ли карточка" (см. ниже, там же и про foundryModuleId),
  // а до тех пор он не должен попасть ни в sameCard, ни в глаза ДМ в
  // диалоге конфликта.
  const sourceIds = new Map();
  const mapped = target.mapBatch
    ? target.mapBatch(docs)
    : docs.map((doc) => {
        try {
          const card = target.mapOne(doc);
          if (target.art && !card.imageUrl) card.imageUrl = target.art(doc);
          if (target.linkField && doc && doc._id) sourceIds.set(card, String(doc._id));
          return card;
        } catch (err) {
          console.warn(`[${pack.name}] ${doc && doc.name}: ${err.message}`);
          return null;
        }
      });

  const list = mapped.filter(Boolean);
  stats.failed += mapped.length - list.length;

  let index;
  try {
    index = new Map((await target.fetchAll()).map((x) => [cardKey(target, x), x]));
  } catch (err) {
    log(`  ${target.label}: не удалось прочитать библиотеку — ${err.message}`);
    stats.failed += list.length;
    return stats;
  }

  for (let i = 0; i < list.length; i++) {
    if (cancelled) break;
    const card = list[i];
    if (i % 5 === 0 || i === list.length - 1) {
      setStatus(`${pack.label || pack.name} → ${target.label}: ${i + 1} из ${list.length}…`, { busy: true });
      setProgress((packProgress.done + (i + 1) / list.length) / packProgress.total);
    }

    const key = cardKey(target, card);
    const existing = index.get(key);
    let action = "create";
    if (existing) {
      if (sameCard(existing, card)) {
        stats.skipped++;
        continue;
      }
      action = await resolveConflict(target, {
        title: card.name,
        // Карточку каталога «из коробки» сервер править не даст (см.
        // itemfile.Catalog: ErrForbidden) — перезапись для неё не предлагается.
        allowOverwrite: !existing.system,
        where: existing.system ? "каталог «из коробки»" : "библиотека мира",
        existingInfo: describeCard(existing),
        incomingInfo: describeCard(card),
      });
      if (action === "stop") {
        cancelled = true;
        break;
      }
      if (action === "skip") {
        stats.skipped++;
        continue;
      }
    }

    // Метка "из какого пакета" — единственное назначение: "Удалить модуль" в
    // настройках (см. pages/dm.js: openFoundryUpdateWindow и
    // internal/service/foundry.go: FoundryService.Delete), сама карточка это
    // поле нигде не показывает. Проставляется здесь, ПОСЛЕ sameCard/
    // resolveConflict выше, а не раньше: иначе она сама попала бы в
    // сравнение "не изменилось ли" и превращала бы любую руками заведённую
    // карточку, совпадающую с модулем по остальным полям, в «конфликт» на
    // пустом месте. Перезаписывается при каждом импорте/обновлении карточки —
    // если её потом перезаписал другой модуль, "своей" она считается уже у него.
    card.foundryModuleId = pkg.id;
    // Тот же момент и та же причина — якорь на исходный документ Foundry
    // (см. sourceIds выше): служебная метка не должна сама превращать
    // совпадающую карточку в «конфликт».
    if (target.linkField && sourceIds.has(card)) card[target.linkField] = sourceIds.get(card);

    try {
      if (action === "overwrite") {
        await target.updateOne(existing.id, Object.assign({}, existing, card));
        stats.updated++;
      } else {
        const created = await target.createOne(card.name);
        const saved = await target.updateOne(created.id, Object.assign({}, created, card));
        // Копию кладём в индекс, только если ключа там ещё нет: иначе
        // следующая такая же карточка сравнивалась бы с копией, а не с
        // оригиналом.
        if (!index.has(key)) index.set(key, saved || Object.assign({ id: created.id }, card));
        stats.created++;
      }
    } catch (err) {
      stats.failed++;
      console.warn(`[${pack.name}] ${card.name}: ${err.message}`);
    }
  }

  log(`  ${target.label}: ${statsLine(stats)} (из ${docs.length})`);
  return stats;
}

// describeCard — чем карточки отличаются, одной строкой для диалога. Полный
// diff тут не нужен: ДМ решает «перезаписать своим модулем или нет», а не
// вычитывает изменения по полям.
function describeCard(card) {
  const parts = [];
  if (card.type) parts.push(String(card.type));
  if (card.kind) parts.push(String(card.kind));
  if (card.level !== undefined && card.level !== null) parts.push(`круг ${card.level}`);
  if (card.cr) parts.push("CR " + card.cr);
  if (card.slug) parts.push(card.slug);
  const description = String(card.description || "");
  parts.push(`описание ${description.length} символов`);
  if (card.updatedAt) parts.push("изменена " + formatWhen(card.updatedAt));
  return parts.join(", ");
}

function statsLine(stats) {
  const parts = [`создано ${stats.created}`];
  if (stats.updated) parts.push(`перезаписано ${stats.updated}`);
  if (stats.skipped) parts.push(`пропущено ${stats.skipped}`);
  if (stats.failed) parts.push(`ошибок ${stats.failed}`);
  return parts.join(", ");
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
  const dest = noteDestination();
  const stats = { created: 0, updated: 0, skipped: 0, failed: 0 };
  let index;
  try {
    index = new Map((await dest.fetchAll()).map((n) => [noteKey(n.folder, n.title), n]));
  } catch (err) {
    log(`  ${dest.label}: не удалось прочитать библиотеку — ${err.message}`);
    stats.failed += notes.length;
    return stats;
  }

  for (let i = 0; i < notes.length; i++) {
    if (cancelled) break;
    const note = notes[i];
    setStatus(`${pack.label || pack.name} → ${dest.label}: ${i + 1} из ${notes.length}…`, { busy: true });
    setProgress((packProgress.done + (i + 1) / notes.length) / packProgress.total);

    const existing = index.get(noteKey(note.folder, note.title));
    let action = "create";
    if (existing) {
      let current;
      try {
        current = await dest.fetchOne(existing.id);
      } catch (err) {
        stats.failed++;
        console.warn(`[${pack.name}] ${note.title}: ${err.message}`);
        continue;
      }
      if (sameNoteText(current.content, note.content)) {
        stats.skipped++;
        continue;
      }
      action = await resolveConflict(dest, {
        title: note.title,
        where: note.folder ? `папка «${note.folder}»` : `корень: ${dest.label.toLowerCase()}`,
        existingInfo: `${(current.content || "").length} символов, изменена ${formatWhen(current.updatedAt)}`,
        incomingInfo: `${note.content.length} символов`,
      });
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
        await dest.update(existing.id, note.content);
        stats.updated++;
      } else {
        const created = await dest.create(note);
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

  log(`  ${dest.label}: ${statsLine(stats)} (из ${notes.length})`);
  return stats;
}

// resolveConflict — что делать с совпавшей записью: ответ «ко всем
// остальным» для этого раздела помнится с прошлого раза (conflictDefaults),
// иначе спрашиваем. Дефолт хранится ПО РАЗДЕЛАМ: «перезаписывать все
// заметки» — не то же самое, что «перезаписывать все статблоки».
async function resolveConflict(target, info) {
  const remembered = conflictDefaults[target.id];
  // Запомненная перезапись не годится для карточки каталога «из коробки» —
  // её сервер править не даст, спрашиваем заново.
  if (remembered && (remembered !== "overwrite" || info.allowOverwrite !== false)) return remembered;
  return askConflict(target, info);
}

// askConflict — диалог «такая запись уже есть, но отличается». confirm() тут
// не годится: вариантов больше двух, да и показать, ЧЕМ отличается, надо.
// Возвращает "overwrite" | "duplicate" | "skip" | "stop".
function askConflict(target, { title, where, existingInfo, incomingInfo, allowOverwrite = true }) {
  return new Promise((resolve) => {
    const overlay = h("div", { class: "modal-overlay" });
    const applyAll = h("input", { type: "checkbox" });

    const finish = (action) => {
      if (applyAll.checked && action !== "stop") conflictDefaults[target.id] = action;
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(action);
    };
    const onKey = (e) => {
      if (e.key === "Escape") finish("skip");
    };

    const button = (label, action, primary) =>
      h("button", { class: primary ? "primary" : "", text: label, onclick: () => finish(action) });

    const buttons = [];
    if (allowOverwrite) buttons.push(button("Перезаписать", "overwrite", true));
    buttons.push(button("Оставить обе", "duplicate", !allowOverwrite));
    buttons.push(button("Пропустить", "skip"));
    buttons.push(button("Остановить импорт", "stop"));

    overlay.appendChild(
      h("div", { class: "modal" }, [
        h("h3", { text: `${target.label}: такая запись уже есть` }),
        h("p", { class: "hint" }, [
          `«${title}» уже есть (${where}), но отличается от того, что в модуле.` +
            (allowOverwrite ? "" : " Карточка каталога «из коробки» доступна только для чтения — перезаписать её нельзя."),
        ]),
        h("dl", { class: "modal-diff" }, [
          h("dt", { text: "Сейчас" }),
          h("dd", { text: existingInfo }),
          h("dt", { text: "В модуле" }),
          h("dd", { text: incomingInfo }),
        ]),
        h("div", { class: "modal-buttons" }, buttons),
        h("label", { class: "modal-all" }, [applyAll, `Так же поступать с остальными: ${target.label.toLowerCase()}`]),
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
// открытые списки компендиума (catalog.js) на них перечитывают себя. Плюс
// "beacon:foundryImported" — им импорт сообщает о СЕБЕ, а не о карточках:
// после него в мире появились новые заметки, сцены и сам пакет в списке
// установленных, и открытые разделы левой панели ДМ (Заметки, Настройки)
// должны перечитаться, а не висеть со старым списком до F5 (см.
// pages/dm.js: refreshOpenPanel).
function notifySaved() {
  const messages = ["beacon:monsterSaved", "beacon:spellSaved", "beacon:itemSaved", "beacon:referenceSaved", "beacon:conditionSaved"];
  const target = window.parent !== window ? window.parent : window;
  for (const type of messages) target.postMessage({ type }, location.origin);
  target.postMessage({ type: "beacon:foundryImported" }, location.origin);
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
    return;
  }
  // ?url= — окно открыто из настроек кнопкой "Обновить" у уже
  // установленного пакета (см. pages/dm.js: openFoundryUpdateWindow):
  // подставляем ссылку на манифест и сразу запускаем разведку, как будто ДМ
  // сам вставил её и нажал "Проверить" — дальше тот же выбор паков/разделов,
  // что и при первой установке.
  const prefillURL = new URLSearchParams(location.search).get("url");
  if (prefillURL) {
    urlInput.value = prefillURL;
    urlForm.requestSubmit();
  }
})();
