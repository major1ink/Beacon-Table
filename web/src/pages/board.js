// pages/board.js — страница одной доски: забрать холст с сервера, отдать его
// редактору (см. board/editor.js) и показать, кто ещё за ней сидит.
//
// Сохранением страница не занимается вовсе: правки уходят по WebSocket, на
// диск пишет сервер.
import { createElement } from "react";
import {
  fetchMe,
  fetchBoard,
  fetchBoardScene,
  fetchJournal,
  fetchJournalEntry,
  uploadFile,
  fetchBoardImages,
  fetchBestiary,
  fetchMonster,
  fetchCharacters,
  fetchCharacter,
  fetchAdminCharacters,
  fetchAdminCharacter,
  fetchAdminPlaylists,
  fetchAssets,
  fetchScenes,
} from "../api.js";
import { mountBoardEditor } from "../board/editor.js";
import {
  parseWikilink,
  wikilink,
  findEntryByTitle,
  parseCardLink,
  monsterLink,
  characterLink,
  sceneLink,
  audioLink,
  isBoardLink,
  sceneLinksOf,
} from "../board/links.js";
import { openModal, showAlert } from "../modal.js";
import { renderNoteHtml } from "../notes/markdown.js";
import { openFloatingWindow } from "../floating-window.js";
import { icon } from "../icons.js";
import { isGM } from "../roles.js";

const editorRoot = document.getElementById("editorRoot");
const statusEl = document.getElementById("status");
const nameEl = document.getElementById("boardName");
const metaEl = document.getElementById("boardMeta");
const readonlyBadge = document.getElementById("readonlyBadge");
const linkState = document.getElementById("linkState");
const linkBtn = document.getElementById("linkBtn");
const imageBtn = document.getElementById("imageBtn");
const monsterBtn = document.getElementById("monsterBtn");
const charBtn = document.getElementById("charBtn");
const musicBtn = document.getElementById("musicBtn");
const sceneBtn = document.getElementById("sceneBtn");
const linkScenesBtn = document.getElementById("linkScenesBtn");
const peersEl = document.getElementById("peers");

// Доска открывается плавающим окном по ссылке board.html?id=… — см.
// openBoardWindow в board-list.js.
const boardId = new URLSearchParams(location.search).get("id") || "";

function fail(msg) {
  statusEl.textContent = msg;
  statusEl.style.display = "";
}

let me = "";
// gm — ДМ: бестиарий, чужие листы, плейлисты и музыка на стол.
let gm = false;
let editor = null;
// Записи журнала для связывания. Читаются один раз при открытии доски:
// заводят их редко, а ходить в сеть на каждый клик по ссылке незачем.
let entries = [];
let selected = null;
// Текст записей для врезок. Держим отдельно от списка: список приходит без
// текста (см. handleJournalList), а врезка рисуется на каждый кадр — ходить
// в сеть оттуда нельзя.
const noteHtml = new Map();

// loadNote кладёт в кэш готовый HTML записи. Возвращает, изменилось ли что-то
// — по этому редактор решает, надо ли перерисовывать врезки.
async function loadNote(entry) {
  try {
    const full = await fetchJournalEntry(entry.id);
    const html = renderNoteHtml(full.content || "");
    if (noteHtml.get(entry.id) === html) return false;
    noteHtml.set(entry.id, html);
    return true;
  } catch {
    return false; // нет доступа или запись удалили — врезка покажет, что пусто
  }
}

// renderNote — содержимое врезки. Excalidraw зовёт это на отрисовку, поэтому
// только чтение из кэша, никакой сети.
function renderNote(element) {
  const title = parseWikilink(element.link);
  if (!title) return null;
  const entry = findEntryByTitle(entries, title);
  const html = entry ? noteHtml.get(entry.id) : null;
  return createElement("div", { className: "board-note" }, [
    createElement("div", { className: "board-note-title", key: "t" }, title),
    html
      ? createElement("div", {
          className: "board-note-body",
          key: "b",
          dangerouslySetInnerHTML: { __html: html },
        })
      : createElement("div", { className: "board-note-empty", key: "b" },
          entry ? "Запись пока пуста." : "Такой записи в журнале нет."),
  ]);
}

// ---- карточки стола: монстр, персонаж, трек (см. board/links.js) ----
//
// Данные в кэше: врезка рисуется на каждый кадр. Первый раз грузим прямо из
// отрисовки — так подтягивается и карточка, вставленная соседом.
const cardData = new Map(); // "monster:id" → { card, data } | { card, error }
const cardLoading = new Set();
// deadAudio — адреса треков, которые не загрузились: файл удалён из библиотеки.
const deadAudio = new Set();

function cardKey(card) {
  return card.kind + ":" + card.id;
}

function cardName(card) {
  if (card.kind === "audio") return card.name;
  if (card.kind === "scene") return sceneName(card.id) || card.name;
  const got = cardData.get(cardKey(card));
  return (got && got.data && got.data.name) || (card.kind === "monster" ? "Монстр" : "Персонаж");
}

// loadCard — монстр или персонаж в кэш и перерисовка. Ошибку (чужой лист
// игроку) тоже кладём: карточка скажет об этом словами. force — перечитать.
async function loadCard(card, force = false) {
  const key = cardKey(card);
  if (cardLoading.has(key) || (!force && cardData.has(key))) return;
  cardLoading.add(key);
  try {
    let data;
    if (card.kind === "monster") data = await fetchMonster(card.id);
    else data = gm ? await fetchAdminCharacter(card.id) : await fetchCharacter(card.id);
    cardData.set(key, { card, data });
  } catch (err) {
    cardData.set(key, { card, error: (err && err.message) || "не удалось загрузить" });
  } finally {
    cardLoading.delete(key);
  }
  editor?.repaint();
}

function abilityMod(score) {
  const n = Math.floor(((score || 0) - 10) / 2);
  return n >= 0 ? "+" + n : String(n);
}

const ABILITIES = [
  ["str", "Сил"],
  ["dex", "Лов"],
  ["con", "Тел"],
  ["int", "Инт"],
  ["wis", "Муд"],
  ["cha", "Хар"],
];

function abilitiesRow(abilities) {
  return createElement(
    "div",
    { className: "board-card-abilities", key: "ab" },
    ABILITIES.map(([k, label]) => {
      const v = (abilities && abilities[k]) || 10;
      return createElement("div", { className: "board-card-ability", key: k }, [
        createElement("span", { className: "board-card-ability-label", key: "l" }, label),
        createElement("span", { key: "v" }, v + " (" + abilityMod(v) + ")"),
      ]);
    })
  );
}

function statCell(label, value, key) {
  return createElement("div", { className: "board-card-stat", key }, [
    createElement("span", { className: "board-card-stat-label", key: "l" }, label),
    createElement("span", { key: "v", title: value }, value),
  ]);
}

function cardButton({ key, icon: name, label, title, onClick }) {
  return createElement("button", { type: "button", className: "board-card-btn", key, title, onClick }, [
    iconSpan(name, "i"),
    " " + label,
  ]);
}

function iconSpan(name, key) {
  return createElement("span", {
    className: "board-card-icon",
    key,
    dangerouslySetInnerHTML: { __html: icon(name, { size: 12 }) },
  });
}

// cardHead — портрет, имя (кнопка на полную карточку) и подзаголовок.
function cardHead({ image, name, subtitle, onOpen, openTitle }) {
  return createElement("div", { className: "board-card-head", key: "head" }, [
    image
      ? createElement("img", { className: "board-card-portrait", src: image, alt: "", key: "img" })
      : createElement("div", { className: "board-card-portrait board-card-portrait-empty", key: "img" }),
    createElement("div", { className: "board-card-titles", key: "t" }, [
      createElement(
        "button",
        { type: "button", className: "board-card-name", title: openTitle, onClick: onOpen, key: "n" },
        name || "Без имени"
      ),
      subtitle ? createElement("div", { className: "board-card-sub", key: "s" }, subtitle) : null,
    ]),
  ]);
}

function cardShell(kind, children) {
  return createElement("div", { className: "board-card board-card-" + kind }, children);
}

function cardMessage(kind, text) {
  return cardShell(kind, [createElement("div", { className: "board-card-msg", key: "m" }, text)]);
}

// Значок ссылки есть и у недоступной карточки (чужой лист, бестиарий у
// игрока) — страница карточки увела бы на «/», лучше сказать здесь.
function openMonster(id, name) {
  if (!gm) {
    showAlert("Статблок открывает только ДМ.");
    return;
  }
  openWindow({ key: "monster-" + id, title: name, url: "/bestiary.html?id=" + encodeURIComponent(id) });
}

function openCharacter(id, name) {
  const got = cardData.get("character:" + id);
  if (got && got.error) {
    showAlert("Лист недоступен: " + got.error);
    return;
  }
  openWindow({ key: "char-" + id, title: name, url: "/character-sheet.html?id=" + encodeURIComponent(id) });
}

// renderMonsterCard — сжатый статблок; полный — по имени, окном бестиария.
function renderMonsterCard(card) {
  const got = cardData.get(cardKey(card));
  if (!got) {
    loadCard(card);
    return cardMessage("monster", "Загружаю…");
  }
  if (got.error) return cardMessage("monster", "Монстр недоступен: " + got.error);
  const m = got.data;
  const subtitle = [m.size, m.type].filter(Boolean).join(" ") + (m.alignment ? ", " + m.alignment : "");
  const hp = m.hp ? String(m.hp) + (m.hitDice ? " (" + m.hitDice + ")" : "") : "—";
  const ac = m.ac ? String(m.ac) + (m.acNote ? " (" + m.acNote + ")" : "") : "—";
  return cardShell("monster", [
    cardHead({
      image: m.imageUrl,
      name: m.name,
      subtitle,
      onOpen: () => openMonster(card.id, m.name),
      openTitle: "Открыть статблок",
    }),
    createElement("div", { className: "board-card-stats", key: "stats" }, [
      statCell("КД", ac, "ac"),
      statCell("Хиты", hp, "hp"),
      statCell("Скорость", m.speed || "—", "spd"),
    ]),
    abilitiesRow(m.abilities),
    createElement("div", { className: "board-card-foot", key: "foot" }, [
      createElement("span", { key: "cr" }, "Опасность " + (m.cr || "—")),
      m.proficiencyBonus ? createElement("span", { key: "pb" }, "Мастерство +" + m.proficiencyBonus) : null,
    ]),
    monsterControls(card, m),
  ]);
}

// monsterControls — «на стол» для монстра: токен на карту и в инициативу
// (делает стол, см. pages/dm.js), статблок — у себя.
function monsterControls(card, m) {
  if (!gm) return null;
  const out = [];
  if (hasHost) {
    out.push(
      cardButton({ key: "map", icon: "map", label: "На карту", title: "Токен в центр текущего вида", onClick: () => askHost({ type: "beacon:placeMonster", id: card.id }) }),
      cardButton({ key: "fight", icon: "sword", label: "В бой", title: "Добавить в трекер инициативы", onClick: () => askHost({ type: "beacon:addCombatant", monsterId: card.id }) })
    );
  }
  out.push(cardButton({ key: "open", icon: "scroll", label: "Статблок", title: "Открыть полную карточку", onClick: () => openMonster(card.id, m.name) }));
  return createElement("div", { className: "board-card-controls", key: "c" }, out);
}

function renderCharacterCard(card) {
  const got = cardData.get(cardKey(card));
  if (!got) {
    loadCard(card);
    return cardMessage("character", "Загружаю…");
  }
  if (got.error) return cardMessage("character", "Лист недоступен: " + got.error);
  const c = got.data;
  const sheet = c.sheet || {};
  const info = sheet.info || {};
  const combat = sheet.combat || {};
  const who = [info.class, info.level ? info.level + " ур." : ""].filter(Boolean).join(" ");
  const kin = info.species || info.race || "";
  const player = info.playerName || c.accountUsername || "";
  const subtitle = [who, kin].filter(Boolean).join(" · ") + (player ? " — " + player : "");
  let hp = combat.hpMax ? (combat.hpCurrent || 0) + " / " + combat.hpMax : "—";
  if (combat.hpTemp) hp += " +" + combat.hpTemp;
  return cardShell("character", [
    cardHead({
      image: c.avatarUrl,
      name: c.name,
      subtitle,
      onOpen: () => openCharacter(card.id, c.name),
      openTitle: "Открыть лист персонажа",
    }),
    createElement("div", { className: "board-card-stats", key: "stats" }, [
      statCell("КД", combat.ac ? String(combat.ac) : "—", "ac"),
      statCell("Хиты", hp, "hp"),
      statCell("Скорость", combat.speed ? combat.speed + " фт." : "—", "spd"),
    ]),
    abilitiesRow(sheet.abilities),
  ]);
}

// playOnTable — трек всем за столом. Шлёт сам стол (pages/dm.js слушает
// beacon:playCue/playSfx): у доски сокета сцены нет.
function playOnTable(card) {
  askHost(
    card.sfx
      ? { type: "beacon:playSfx", sfx: { url: card.url, name: card.name, volume: card.volume } }
      : { type: "beacon:playCue", cue: { url: card.url, name: card.name, volume: card.volume, loop: card.loop } }
  );
}

function stopOnTable() {
  askHost({ type: "beacon:stopCue" });
}

// askHost — просьба столу (dm.html); без стола и не у ДМ молча ничего.
function askHost(msg) {
  if (!gm || !hasHost) return;
  hostWindow().postMessage(msg, location.origin);
}

// renderAudioCard — кнопки «на стол» только у ДМ за столом; <audio> у всех.
function renderAudioCard(card) {
  const tags = [];
  if (card.sfx) tags.push("эффект");
  else if (card.loop) tags.push("зациклен");
  const dead = deadAudio.has(card.url);
  if (dead) tags.push("файла нет в загрузках");
  const controls = [];
  if (gm && hasHost && !dead) {
    controls.push(
      cardButton({ key: "play", icon: "play", label: card.sfx ? "Запустить" : "На стол", title: card.sfx ? "Проиграть всем за столом" : "Включить всем за столом", onClick: () => playOnTable(card) })
    );
    if (!card.sfx) controls.push(cardButton({ key: "stop", icon: "pause", label: "Стоп", title: "Остановить канал ДМ", onClick: stopOnTable }));
  }
  controls.push(
    createElement("audio", {
      className: "board-card-audio",
      controls: true,
      preload: "metadata",
      src: card.url,
      key: "audio",
      title: "Слушать у себя",
      onError: () => {
        if (deadAudio.has(card.url)) return;
        deadAudio.add(card.url);
        editor?.repaint();
      },
    })
  );
  return cardShell("audio", [
    createElement("div", { className: "board-card-head", key: "head" }, [
      iconSpan(card.sfx ? "zap" : "music", "i"),
      createElement("div", { className: "board-card-titles", key: "t" }, [
        createElement("div", { className: "board-card-name", key: "n" }, card.name),
        tags.length ? createElement("div", { className: "board-card-sub", key: "s" }, tags.join(" · ")) : null,
      ]),
    ]),
    createElement("div", { className: "board-card-controls", key: "c" }, controls),
  ]);
}

// ---- сцены ----
//
// Список сцен есть только у ДМ (см. handleSceneList): у него имя и фон
// живые, игрок видит имя из ссылки карточки. Связи между сценами — стрелки
// между их карточками (см. sceneLinksOf), «телепорт» ходит по ним.
let scenes = null; // [{id, name, mapUrl, current}] | null — не грузили
let scenesLoading = false;
// scenesStale — список не приехал: карточки живут именами из ссылок.
let scenesStale = false;
// deadMaps — фоны сцен, которые не загрузились (видео или удалённый файл).
const deadMaps = new Set();

async function loadScenes(force = false) {
  if (!gm || scenesLoading || (!force && scenes)) return;
  scenesLoading = true;
  try {
    scenes = await fetchScenes();
    scenesStale = false;
  } catch {
    scenes = scenes || [];
    scenesStale = true;
  } finally {
    scenesLoading = false;
  }
  editor?.repaint();
}

function sceneById(id) {
  return (scenes || []).find((s) => s.id === id) || null;
}

// sceneName — живое имя у ДМ, иначе из ссылки любой карточки этой сцены.
function sceneName(id) {
  const live = sceneById(id);
  if (live) return live.name;
  for (const e of editor?.elements() || []) {
    const card = parseCardLink(e.link);
    if (card && card.kind === "scene" && card.id === id) return card.name;
  }
  return "";
}

// goToScene — переключить стол на сцену. Делает стол (pages/dm.js слушает
// beacon:switchSceneId); у себя отмечаем сразу, не дожидаясь ответа.
function goToScene(id) {
  if (!gm || !hasHost) return;
  askHost({ type: "beacon:switchSceneId", id });
  if (scenes) {
    for (const s of scenes) s.current = s.id === id;
    editor?.repaint();
  }
}

const canTeleport = () => gm && hasHost;

// sceneChip — сосед в телепорте: кнопка у ДМ за столом, иначе просто имя.
function sceneChip(id) {
  const name = sceneName(id) || "Сцена";
  if (!canTeleport()) return createElement("span", { className: "board-card-chip", key: id }, name);
  return createElement(
    "button",
    { type: "button", className: "board-card-btn board-card-chip", key: id, title: "Перейти на сцену", onClick: () => goToScene(id) },
    [iconSpan("arrow-right", "i"), " " + name]
  );
}

// renderSceneCard — сцена: фон, имя, «перейти» и телепорт по связанным.
function renderSceneCard(card) {
  if (gm && !scenes) {
    loadScenes();
    return cardMessage("scene", "Загружаю…");
  }
  const live = sceneById(card.id);
  if (gm && !live && !scenesStale) return cardMessage("scene", "Сцены «" + card.name + "» за столом больше нет.");
  const name = live ? live.name : card.name;
  const map = live && live.mapUrl && !deadMaps.has(live.mapUrl) ? live.mapUrl : "";
  const linked = [...(sceneLinksOf(editor?.elements() || []).get(card.id) || [])];
  const subtitle = live && live.current ? "сцена на столе сейчас" : "сцена";
  const head = createElement("div", { className: "board-card-head", key: "head" }, [
    map
      ? createElement("img", {
          className: "board-card-map",
          src: map,
          alt: "",
          key: "img",
          onError: () => {
            deadMaps.add(map);
            editor?.repaint();
          },
        })
      : createElement("div", { className: "board-card-map board-card-portrait-empty", key: "img" }, iconSpan("map", "i")),
    createElement("div", { className: "board-card-titles", key: "t" }, [
      canTeleport()
        ? createElement(
            "button",
            { type: "button", className: "board-card-name", title: "Перейти на сцену", onClick: () => goToScene(card.id), key: "n" },
            name
          )
        : createElement("div", { className: "board-card-name", key: "n" }, name),
      createElement("div", { className: "board-card-sub", key: "s" }, subtitle),
    ]),
  ]);
  const teleport = createElement("div", { className: "board-card-teleport", key: "tp" }, [
    createElement("span", { className: "board-card-stat-label", key: "l" }, "Телепорт"),
    linked.length
      ? createElement("div", { className: "board-card-controls", key: "c" }, linked.map(sceneChip))
      : createElement("div", { className: "board-card-msg", key: "c" }, "Свяжи стрелкой с другой сценой."),
  ]);
  const controls = canTeleport()
    ? createElement("div", { className: "board-card-controls", key: "c" }, [
        cardButton({ key: "go", icon: "map", label: "Перейти", title: "Показать эту сцену всем за столом", onClick: () => goToScene(card.id) }),
      ])
    : null;
  return cardShell("scene", [head, teleport, controls]);
}

// renderEmbed — содержимое врезки: запись журнала или карточка.
function renderEmbed(element) {
  const card = parseCardLink(element.link);
  if (!card) return renderNote(element);
  if (card.kind === "monster") return renderMonsterCard(card);
  if (card.kind === "character") return renderCharacterCard(card);
  if (card.kind === "scene") return renderSceneCard(card);
  return renderAudioCard(card);
}

// CARD_SIZE — размер карточки при вставке.
const CARD_SIZE = {
  monster: { width: 320, height: 236 },
  character: { width: 320, height: 176 },
  scene: { width: 300, height: 150 },
  audio: { width: 300, height: 104 },
};

// pickFromList — диалог выбора: поиск и список.
async function pickFromList({ title, okLabel, items, empty, render }) {
  if (!items.length) {
    showAlert(empty);
    return null;
  }
  let chosen = null;
  return openModal({
    title,
    okLabel,
    buildBody: (body, submit) => {
      const search = document.createElement("input");
      search.type = "search";
      search.className = "bt-modal-input";
      search.placeholder = "Поиск";
      const list = document.createElement("div");
      list.className = "pick-list";
      const rows = items.map((item) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "pick-row";
        render(row, item);
        row.onclick = () => {
          chosen = item;
          for (const r of rows) r.classList.toggle("on", r === row);
        };
        row.ondblclick = () => {
          chosen = item;
          submit();
        };
        list.appendChild(row);
        return row;
      });
      search.oninput = () => {
        const q = search.value.trim().toLowerCase();
        for (const row of rows) row.hidden = q !== "" && !row.textContent.toLowerCase().includes(q);
      };
      body.append(search, list);
      return search;
    },
    onOk: () => chosen,
    onCancel: () => null,
  });
}

function pickRowText(row, main, meta) {
  const a = document.createElement("span");
  a.className = "pick-main";
  a.textContent = main;
  row.appendChild(a);
  if (meta) {
    const b = document.createElement("span");
    b.className = "pick-meta";
    b.textContent = meta;
    row.appendChild(b);
  }
}

async function pickMonster() {
  const list = await fetchBestiary().catch(() => []);
  const picked = await pickFromList({
    title: "Монстр на доску",
    okLabel: "Вставить",
    items: list,
    empty: "Бестиарий пуст — заведи монстра или импортируй модуль.",
    render: (row, m) =>
      pickRowText(row, m.name, [m.type, m.cr ? "опасность " + m.cr : ""].filter(Boolean).join(" · ")),
  });
  return picked ? { link: monsterLink(picked.id), ...CARD_SIZE.monster } : null;
}

async function pickCharacter() {
  const list = await (gm ? fetchAdminCharacters() : fetchCharacters()).catch(() => []);
  const picked = await pickFromList({
    title: "Персонаж на доску",
    okLabel: "Вставить",
    items: list,
    empty: gm ? "Персонажей за столом пока нет." : "У тебя пока нет персонажей.",
    render: (row, c) => pickRowText(row, c.name, c.accountUsername || ""),
  });
  return picked ? { link: characterLink(picked.id), ...CARD_SIZE.character } : null;
}

async function pickScene() {
  await loadScenes(true);
  const picked = await pickFromList({
    title: "Сцена на доску",
    okLabel: "Вставить",
    items: scenes || [],
    empty: "Сцен за столом пока нет.",
    render: (row, s) => pickRowText(row, s.name, s.current ? "на столе сейчас" : ""),
  });
  return picked ? { link: sceneLink(picked.id, picked.name), ...CARD_SIZE.scene } : null;
}

// Трек, чьего файла уже нет в загрузках (плейлист пережил удаление музыки
// из библиотеки), не предлагаем: он молчит и в панели плейлистов.
async function pickTrack() {
  const [playlists, assets] = await Promise.all([
    fetchAdminPlaylists().catch(() => []),
    fetchAssets().catch(() => null),
  ]);
  const known = assets ? new Set((assets.audio || []).map((a) => a.url)) : null;
  const items = [];
  let dead = 0;
  for (const p of playlists) {
    for (const t of p.tracks || []) {
      if (known && !known.has(t.url)) dead++;
      else items.push({ playlist: p, track: t });
    }
  }
  const picked = await pickFromList({
    title: "Музыка на доску",
    okLabel: "Вставить",
    items,
    empty: dead
      ? "Файлов треков нет в загрузках — плейлисты ссылаются на удалённую музыку."
      : "Плейлисты пусты — добавь треки в разделе «Плейлисты».",
    render: (row, { playlist, track }) =>
      pickRowText(row, track.name, playlist.name + (playlist.kind === "sfx" ? " · эффект" : "")),
  });
  if (!picked) return null;
  const { playlist, track } = picked;
  return {
    link: audioLink({ url: track.url, name: track.name, volume: track.volume, loop: track.loop, sfx: playlist.kind === "sfx" }),
    ...CARD_SIZE.audio,
  };
}

// hostWindow — окно стола: parent у iframe, opener у вынесенного 🗗 окна
// (см. floating-window.js). Открытая по прямому адресу доска — сама себе.
function hostWindow() {
  if (window.opener && window.opener !== window) return window.opener;
  return window.parent;
}

const hasHost = hostWindow() !== window;

// openWindow — окном стола, иначе карточка встала бы внутрь рамки доски.
function openWindow(spec) {
  if (hasHost) {
    hostWindow().postMessage({ type: "beacon:openFloatingWindow", ...spec }, location.origin);
  } else {
    openFloatingWindow(spec);
  }
}

// openJournal — то же окно журнала, что открывают значки заметок на карте и
// боковое меню (key "journal", см. pages/dm.js).
function openJournal(entryId) {
  openWindow({
    key: "journal",
    title: "Журнал стола",
    url: "/journal.html?id=" + encodeURIComponent(entryId),
    navigate: true,
    width: 900,
    height: 640,
    popoutFeatures: "width=900,height=640",
  });
}

// followLink — true, если ссылку разобрали и открыли сами; прочие адреса
// открывает Excalidraw.
function followLink(link) {
  const card = parseCardLink(link);
  if (card) {
    if (card.kind === "monster") openMonster(card.id, cardName(card));
    else if (card.kind === "character") openCharacter(card.id, cardName(card));
    else if (card.kind === "scene") goToScene(card.id);
    else if (card.kind === "audio") playOnTable(card);
    return true;
  }
  const title = parseWikilink(link);
  if (!title) return false;
  const entry = findEntryByTitle(entries, title);
  if (!entry) {
    showAlert("Записи «" + title + "» в журнале нет. Ссылка ведёт на заметку ваулта Obsidian.");
    return true;
  }
  openJournal(entry.id);
  return true;
}

// Кнопка живёт в шапке, а не в меню Excalidraw: своё меню он подменяет
// целиком, вместе со всеми стандартными пунктами.
function showSelection(el) {
  selected = el;
  linkBtn.hidden = !el;
  // Две карточки сцен — можно связать стрелкой одной кнопкой.
  const pair = (editor?.selectedElements() || []).filter((e) => parseCardLink(e.link)?.kind === "scene");
  linkScenesBtn.hidden = pair.length !== 2;
  if (!el) return;
  // У карточки ссылка занята.
  linkBtn.hidden = parseCardLink(el.link) !== null;
  const title = parseWikilink(el.link);
  linkBtn.textContent = title ? "Связано: " + title : "Связать с журналом";
}

async function pickEntry(current) {
  let select = null;
  let asNote = null;
  const ok = await openModal({
    title: "Связать с записью журнала",
    okLabel: "Связать",
    buildBody: (body) => {
      const hint = document.createElement("p");
      hint.className = "bt-modal-text";
      hint.textContent =
        "Ссылка хранится названием записи, как в Obsidian: та же доска в ваулте откроет одноимённую заметку.";
      body.appendChild(hint);
      select = document.createElement("select");
      select.className = "bt-modal-input";
      const none = document.createElement("option");
      none.value = "";
      none.textContent = "— без ссылки —";
      select.appendChild(none);
      for (const e of entries) {
        const opt = document.createElement("option");
        opt.value = e.title;
        opt.textContent = e.title + (e.folder ? " · " + e.folder : "");
        select.appendChild(opt);
      }
      select.value = current || "";
      body.appendChild(select);

      // Врезка — это уже не фигура со ссылкой, а рамка с текстом записи:
      // формы у неё не остаётся. Поэтому выбор явный, а не по умолчанию.
      asNote = document.createElement("label");
      asNote.className = "bt-modal-text";
      asNote.style.cssText = "display:flex;align-items:center;gap:8px;";
      const box = document.createElement("input");
      box.type = "checkbox";
      const cap = document.createElement("span");
      cap.textContent = "Показывать текст записи прямо на доске";
      asNote.append(box, cap);
      asNote.check = box;
      body.appendChild(asNote);

      const note = document.createElement("p");
      note.className = "bt-modal-text";
      note.textContent = "Тогда фигура станет рамкой с текстом — своей формы у неё не останется. Текст живой: правка записи видна на доске, в файле доски он не хранится.";
      body.appendChild(note);
    },
    onOk: () => ({ title: select.value, asNote: asNote.check.checked }),
    onCancel: () => null,
  });
  return ok;
}

// Пока связь есть, писать об этом нечего — а вот её отсутствие надо
// увидеть: правки в это время никуда не уходят.
function showStatus(state) {
  linkState.textContent = state === "online" ? "" : "нет связи";
  linkState.classList.toggle("err", state !== "online");
}

function showPeers(list) {
  const others = list.filter((p) => p.id !== me);
  peersEl.textContent = others.length ? "тут ещё: " + others.map((p) => p.name).join(", ") : "";
}

// uploadImage — картинку с доски кладём в загрузки стола, а в файле доски
// остаётся только адрес (см. board_files в internal/service/boardroom.go).
// Excalidraw отдаёт её data-адресом, поэтому переводим обратно в файл.
async function uploadImage(file) {
  try {
    const blob = await (await fetch(file.dataURL)).blob();
    const name = "board-" + (file.id || Date.now()) + extFor(blob.type);
    const { url } = await uploadFile(new File([blob], name, { type: blob.type }), "boards");
    return url;
  } catch (err) {
    showAlert("Не удалось загрузить картинку: " + ((err && err.message) || "ошибка"));
    return null;
  }
}

function extFor(mime) {
  if (mime === "image/png") return ".png";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/gif") return ".gif";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/svg+xml") return ".svg";
  return "";
}

// MAX_INSERT — во сколько вписываем картинку при вставке. Полноразмерная
// карта на 4000 пикселей закрыла бы весь холст; растянуть обратно можно
// руками.
const MAX_INSERT = 600;

// pickImage — выбор из уже загруженного. Размеры берём у самой картинки:
// сервер их не хранит, а Excalidraw ждёт готовые ширину и высоту.
async function pickImage() {
  let images = [];
  try {
    images = await fetchBoardImages();
  } catch {
    images = [];
  }
  if (!images.length) {
    showAlert("Картинок пока нет. Перетащи файл на доску — он попадёт сюда.");
    return null;
  }
  let chosen = null;
  const ok = await openModal({
    title: "Картинка на доску",
    okLabel: "Вставить",
    buildBody: (body) => {
      const grid = document.createElement("div");
      grid.className = "image-grid";
      for (const img of images) {
        const cell = document.createElement("button");
        cell.type = "button";
        cell.className = "image-cell";
        cell.title = img.name;
        const pic = document.createElement("img");
        pic.src = img.url;
        pic.alt = img.name;
        cell.appendChild(pic);
        cell.onclick = () => {
          chosen = img;
          for (const el of grid.children) el.classList.toggle("on", el === cell);
        };
        grid.appendChild(cell);
      }
      body.appendChild(grid);
    },
    onOk: () => chosen,
    onCancel: () => null,
  });
  if (!ok) return null;
  // Натуральный размер знает только сама картинка.
  const size = await new Promise((resolve) => {
    const probe = new Image();
    probe.onload = () => resolve({ w: probe.naturalWidth, h: probe.naturalHeight });
    probe.onerror = () => resolve({ w: 320, h: 240 });
    probe.src = ok.url;
  });
  const k = Math.min(1, MAX_INSERT / Math.max(size.w, size.h));
  return { url: ok.url, width: Math.round(size.w * k), height: Math.round(size.h * k) };
}

(async function boot() {
  if (!boardId) {
    fail("Доска не указана.");
    return;
  }

  let board;
  let scene;
  try {
    // Свой id нужен, чтобы не показывать себя же в списке соседей.
    const account = await fetchMe();
    me = account?.id || "";
    gm = isGM(account?.role);
    board = await fetchBoard(boardId);
    scene = await fetchBoardScene(boardId);
  } catch (err) {
    fail((err && err.message) || "Не удалось открыть доску.");
    return;
  }

  nameEl.textContent = board.name;
  document.title = "Beacon Table — " + board.name;
  const who = board.ownerName ? "автор: " + board.ownerName : "заведена ДМ";
  metaEl.textContent = board.shared ? who + " · общая" : who + " · личная";
  // canEdit считает сервер, см. boardJSON в
  // internal/api/http/board_handlers.go.
  const readOnly = !board.canEdit;
  readonlyBadge.classList.toggle("on", readOnly);

  // Журнал нужен и на чтение ссылок, и на их раздачу. Не приехал — ссылки
  // просто не разрешатся по названию, доска от этого не ломается.
  entries = await fetchJournal().catch(() => []);

  statusEl.style.display = "none";
  editor = mountBoardEditor(editorRoot, {
    boardId,
    scene,
    readOnly,
    onStatus: showStatus,
    onPeers: showPeers,
    onSelection: readOnly ? undefined : showSelection,
    onLinkOpen: followLink,
    renderEmbed,
    isEmbedLink: isBoardLink,
    uploadImage,
  });

  // Записи и карточки перечитываем при возврате в окно: их правят в других
  // окнах.
  async function refreshNotes() {
    for (const { card } of cardData.values()) loadCard(card, true);
    if (scenes) loadScenes(true);
    const wanted = new Set();
    for (const e of scene.elements || []) {
      const title = e && parseWikilink(e.link);
      const entry = title && findEntryByTitle(entries, title);
      if (entry) wanted.add(entry);
    }
    for (const link of editor.linkedNotes()) {
      const title = parseWikilink(link);
      const entry = title && findEntryByTitle(entries, title);
      if (entry) wanted.add(entry);
    }
    const changed = await Promise.all([...wanted].map(loadNote));
    if (changed.some(Boolean)) editor.repaint();
  }
  await refreshNotes();
  window.addEventListener("focus", refreshNotes);

  imageBtn.hidden = readOnly;
  imageBtn.onclick = async () => {
    const picked = await pickImage();
    if (picked) await editor.insertImage(picked);
  };

  // Бестиарий и плейлисты — только у ДМ; своих персонажей игрок кладёт сам.
  monsterBtn.hidden = readOnly || !gm;
  charBtn.hidden = readOnly;
  musicBtn.hidden = readOnly || !gm;
  sceneBtn.hidden = readOnly || !gm;
  const insertCard = (pick) => async () => {
    const picked = await pick();
    if (picked) editor.insertCard(picked);
  };
  monsterBtn.onclick = insertCard(pickMonster);
  charBtn.onclick = insertCard(pickCharacter);
  musicBtn.onclick = insertCard(pickTrack);
  sceneBtn.onclick = insertCard(pickScene);

  linkScenesBtn.onclick = () => {
    const pair = editor.selectedElements().filter((e) => parseCardLink(e.link)?.kind === "scene");
    if (pair.length !== 2) return;
    editor.linkCards(pair[0].id, pair[1].id);
  };

  linkBtn.onclick = async () => {
    if (!selected) return;
    const picked = await pickEntry(parseWikilink(selected.link));
    if (picked === null) return;
    const { title, asNote } = picked;
    const entry = title && findEntryByTitle(entries, title);
    if (entry) await loadNote(entry);
    editor.setLink(selected.id, title ? wikilink(title) : null, title, asNote && !!title);
    showSelection(editor.selectedElement());
  };

  // pagehide, а не beforeunload: срабатывает и когда вкладку убирают в фон
  // на телефоне, откуда она может не вернуться.
  window.addEventListener("pagehide", () => editor.flush());
})();
