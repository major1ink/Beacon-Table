// board/links.js — связь элемента доски с записью журнала.
//
// Храним в поле link самого элемента, и не своим форматом, а обсидиановским:
// `[[Название]]`. Плагин Excalidraw в ваулте пишет туда ровно это (в
// импортированных досках такие ссылки уже лежат), так что одна и та же доска
// работает и за столом, и в ваулте — там ссылка ведёт на заметку, у нас на
// запись журнала с тем же названием.
//
// Отсюда же следует, что связь по НАЗВАНИЮ, а не по id. Название можно
// переименовать и ссылка отвалится — но id записи ваулту ничего не говорит, а
// совместимость мы выбрали осознанно.

const WIKILINK = /^\s*\[\[([^\]]+)\]\]\s*$/;

// parseWikilink — «[[Таверна]]» → «Таверна»; всё прочее (обычные адреса) —
// null, такую ссылку открывает сам Excalidraw.
export function parseWikilink(link) {
  if (typeof link !== "string") return null;
  const m = WIKILINK.exec(link);
  if (!m) return null;
  // «[[Заметка|как показать]]» и «[[Заметка#Раздел]]» — синтаксис Obsidian;
  // нам нужно только имя.
  return m[1].split("|")[0].split("#")[0].trim() || null;
}

export function wikilink(title) {
  return "[[" + title + "]]";
}

// findEntryByTitle — запись журнала с таким названием. Одноимённые записи за
// столом бывают (в разных папках), берём первую: угадывать, какую из них имел
// в виду ваулт, всё равно не по чему.
export function findEntryByTitle(entries, title) {
  const want = title.trim().toLowerCase();
  return entries.find((e) => (e.title || "").trim().toLowerCase() === want) || null;
}

// ---- карточки стола: монстр, персонаж, сцена, трек ----
//
// Свой протокол beacon://, а не вики-ссылка: в ваулте этих сущностей нет.
// Трек хранится адресом файла, не id из плейлиста — у игрока к плейлистам
// доступа нет, а слышать трек он должен.
const CARD_LINK = /^beacon:\/\/([a-z]+)(?:\/([^?]*))?(?:\?(.*))?$/;

// parseCardLink — «beacon://monster/abc» → { kind, id } (так же character);
// «beacon://scene/abc?name=…» → { kind, id, name };
// «beacon://audio?url=…» → { kind, url, name, volume, loop, sfx }; иначе null.
export function parseCardLink(link) {
  if (typeof link !== "string") return null;
  const m = CARD_LINK.exec(link.trim());
  if (!m) return null;
  const [, kind, id, query] = m;
  if (kind === "monster" || kind === "character") {
    return id ? { kind, id: decodeURIComponent(id) } : null;
  }
  // Имя сцены лежит в ссылке: списка сцен у игрока нет (см.
  // handleSceneList), а карточку он видеть должен.
  if (kind === "scene") {
    if (!id) return null;
    const q = new URLSearchParams(query || "");
    return { kind, id: decodeURIComponent(id), name: q.get("name") || "Сцена" };
  }
  if (kind === "audio") {
    const q = new URLSearchParams(query || "");
    const url = q.get("url") || "";
    if (!url.startsWith("/")) return null;
    const volume = parseFloat(q.get("volume"));
    return {
      kind,
      url,
      name: q.get("name") || "Без названия",
      volume: Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0.8,
      loop: q.get("loop") === "1",
      sfx: q.get("sfx") === "1",
    };
  }
  return null;
}

export function monsterLink(id) {
  return "beacon://monster/" + encodeURIComponent(id);
}

export function characterLink(id) {
  return "beacon://character/" + encodeURIComponent(id);
}

export function sceneLink(id, name) {
  const q = new URLSearchParams();
  q.set("name", name || "");
  return "beacon://scene/" + encodeURIComponent(id) + "?" + q.toString();
}

export function audioLink({ url, name, volume, loop, sfx }) {
  const q = new URLSearchParams();
  q.set("url", url);
  q.set("name", name || "");
  q.set("volume", String(typeof volume === "number" ? volume : 0.8));
  if (loop) q.set("loop", "1");
  if (sfx) q.set("sfx", "1");
  return "beacon://audio?" + q.toString();
}

// isBoardLink — врезка, которую доска рисует сама: запись или карточка.
export function isBoardLink(link) {
  return parseWikilink(link) !== null || parseCardLink(link) !== null;
}

// sceneLinksOf — какие сцены связаны на доске: стрелка между двумя
// карточками сцен связывает их в обе стороны. Возвращает id сцены → Set id
// соседей. Считает и доска (телепорт в карточке), и стол (телепорт в панели
// сцен, см. pages/dm.js).
export function sceneLinksOf(elements) {
  const sceneOf = new Map(); // id элемента → id сцены
  for (const e of elements || []) {
    if (!e || e.isDeleted || e.type !== "embeddable") continue;
    const card = parseCardLink(e.link);
    if (card && card.kind === "scene") sceneOf.set(e.id, card.id);
  }
  const out = new Map();
  const add = (a, b) => {
    if (!out.has(a)) out.set(a, new Set());
    out.get(a).add(b);
  };
  for (const e of elements || []) {
    if (!e || e.isDeleted || e.type !== "arrow") continue;
    const a = e.startBinding && sceneOf.get(e.startBinding.elementId);
    const b = e.endBinding && sceneOf.get(e.endBinding.elementId);
    if (!a || !b || a === b) continue;
    add(a, b);
    add(b, a);
  }
  return out;
}
