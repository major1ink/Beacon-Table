// catalog-links.js — превращает <a class="catalog-ref" data-kind="..."
// data-name="..."> внутри уже вставленного в DOM HTML (описания предметов/
// заклинаний/справочника/монстров, см. domain.*.Description) в кликабельные
// ссылки, открывающие карточку цели плавающим окном — тот же приём, что
// wireWikiLinks у заметок (notes/markdown.js) и enhanceRolls у формул
// (inline-rolls.js): постобработка готового HTML, а не свой рендерер.
//
// Разметку .catalog-ref эмитит только импорт (см. import-скрипты и
// cmd/beacon-table/systemdata — карточки "из коробки" на этапе сборки, там
// же, где @UUID[...] резолвится в читаемый текст, порт clean_html из
// scratch-конвертера в web/src/*-import.js пока не перенесён — ручные
// карточки такую ссылку сегодня не заводят); клиенту достаточно уметь её
// открывать.
//
// Открытие — postMessage "beacon:openFloatingWindow" в window.parent (топ-
// документ dm.html/player.html), тот же протокол, что и у списка компендиума
// (pages/catalog.js: openDetail) — сама эта страница тоже всегда живёт в
// плавающем окне-iframe, второй уровень вложенности не нужен (см.
// floating-window.js: все окна — прямые дети топ-документа).
import { fetchItems, fetchSpells, fetchReferences, fetchBestiary, fetchJournal } from "./api.js";

const KIND_CONFIG = {
  item: { fetchAll: fetchItems, urlFor: (id) => `/itembook.html?id=${id}`, keyPrefix: "item" },
  spell: { fetchAll: fetchSpells, urlFor: (id) => `/spellbook.html?id=${id}`, keyPrefix: "spell" },
  reference: { fetchAll: fetchReferences, urlFor: (id) => `/referencebook.html?id=${id}`, keyPrefix: "reference" },
  monster: { fetchAll: fetchBestiary, urlFor: (id) => `/bestiary.html?id=${id}`, keyPrefix: "monster" },
  // journal — журнал стола (domain.JournalEntry). Сюда же ведёт data-kind="note":
  // в Foundry сюжет приключения лежит в JournalEntry, ссылки на него
  // (@UUID[...JournalEntry...], см. internal/foundry/links.go) размечаются
  // как kind="note" и несут ещё data-folder — одноимённые записи в разных
  // ветках дерева нормальны (см. matchByName). Раньше журналы модуля могли
  // поехать и в личные заметки ДМ, теперь только в журнал стола.
  journal: { fetchAll: fetchJournal, urlFor: (id) => `/journal.html?id=${id}`, keyPrefix: "journal", single: true },
  // scene / playlist — не карточки в окне: сцену делают активной на столе,
  // плейлист открывают в разделе «Плейлисты». Записи в KIND_CONFIG нет, клик
  // обрабатывается отдельно — см. "kind === scene" / "kind === playlist" в
  // wireCatalogLinks.
};

// listCache — один запрос списка на kind на всё время жизни страницы: одно
// описание нередко ссылается на десяток заклинаний/черт, гонять сеть за
// каждой ссылкой по отдельности незачем. Игрок получит 403 на /api/bestiary
// (см. requireAdminAccount) — .catch(() => []) молча оставляет такие ссылки
// нерабочими вместо ошибки в консоли на каждый клик.
const listCache = new Map();
function listFor(kind) {
  const cfg = KIND_CONFIG[kind];
  if (!cfg) return Promise.resolve([]);
  if (!listCache.has(kind)) listCache.set(kind, cfg.fetchAll().catch(() => []));
  return listCache.get(kind);
}

// matchByName — найти цель ссылки в списке раздела. Имя сравнивается без
// учёта регистра и лишних пробелов: ссылка родом из чужого модуля, и
// требовать побайтового совпадения с тем, что легло в библиотеку, слишком
// строго. folder (только у заметок) сначала обязателен, а если такой папки
// уже нет — ДМ мог перенести заметку — берём тёзку из любой папки.
function matchByName(list, name, folder) {
  const norm = (s) => (s || "").trim().toLowerCase();
  const sameName = list.filter((x) => norm(x.name || x.title) === norm(name));
  if (!sameName.length) return null;
  if (folder) {
    const inFolder = sameName.find((x) => norm(x.folder) === norm(folder));
    if (inFolder) return inFolder;
  }
  return sameName[0];
}

// hostWindow — окно топ-документа стола (dm.html/player.html), которому шлём
// запрос открыть карточку/переключить сцену. Текст с ссылкой .catalog-ref
// живёт в одном из трёх мест: боковая панель самого топ-документа
// (window.parent === window), плавающее окно-iframe (window.parent — топ),
// либо ВЫНЕСЕННОЕ кнопкой 🗗 отдельное окно браузера (window.parent — оно
// само, а топ-документ — это window.opener, см. floating-window.js). Без
// разбора этого случая ссылки в вынесенном окне журнала молча не работали.
function hostWindow() {
  if (window.opener && window.opener !== window) return window.opener;
  return window.parent;
}

// openEntry — section — раздел внутри целевой записи: страница журнала
// Foundry у нас становится разделом «## Название» (см.
// internal/foundry/journal.go), и ссылка на неё должна открывать запись
// сразу на нужном месте. Передаётся хэшем в URL — его читает pages/journal.js.
function openEntry(kind, id, name, section) {
  const cfg = KIND_CONFIG[kind];
  if (!cfg) return;
  const url = cfg.urlFor(id) + (section ? "#" + encodeURIComponent(section) : "");
  // single: у журнала окно одно на весь стол (key "journal", см.
  // pages/player.js: openJournalWindow) — ссылка должна ПЕРЕВЕСТИ его на
  // нужную запись, а не открыть второй журнал рядом. Отсюда navigate (см.
  // floating-window.js).
  hostWindow().postMessage(
    {
      type: "beacon:openFloatingWindow",
      key: cfg.single ? cfg.keyPrefix : cfg.keyPrefix + "-" + id,
      title: cfg.single ? "Журнал стола" : name,
      url,
      navigate: !!cfg.single,
    },
    location.origin
  );
}

// wireCatalogLinks — делегированный клик по containerEl, как и у
// enhanceRolls/wireWikiLinks — не нужно перевешивать обработчик при каждой
// перерисовке блока, один вызов после вставки HTML достаточно.
export function wireCatalogLinks(containerEl, _opts = {}) {
  if (!containerEl) return;
  containerEl.addEventListener("click", async (e) => {
    const a = e.target.closest("a.catalog-ref");
    if (!a || !containerEl.contains(a)) return;
    e.preventDefault();
    const kind = a.dataset.kind;
    const name = a.dataset.name;
    if (!kind || !name) return;

    // Сцена — не карточка в плавающем окне, а карта стола: ссылка просит
    // страницу-хозяина (pages/dm.js) переключить активную сцену по имени.
    // У игрока сценами управлять нельзя — pages/player.js это сообщение
    // просто не слушает, ссылка молча ничего не делает.
    if (kind === "scene") {
      hostWindow().postMessage({ type: "beacon:switchScene", name }, location.origin);
      return;
    }
    // Плейлист — тоже не карточка в окне: просим хозяина открыть раздел
    // «Плейлисты» на нужном (см. pages/dm.js: beacon:openPlaylist).
    if (kind === "playlist") {
      hostWindow().postMessage({ type: "beacon:openPlaylist", name }, location.origin);
      return;
    }

    // kind="note" — историческая разметка ссылок на JournalEntry из Foundry
    // (см. internal/foundry/links.go); журналы модуля теперь всегда в журнале
    // стола, поэтому ищем там же, где и kind="journal".
    const k = kind === "note" ? "journal" : kind;
    const found = matchByName(await listFor(k), name, a.dataset.folder);
    if (found) {
      openEntry(k, found.id, found.name || found.title, a.dataset.section);
      return;
    }
    // Записи с таким именем нет — ссылка просто ничего не делает: цель могли
    // не импортировать или удалить, это не ошибка.
  });
}
