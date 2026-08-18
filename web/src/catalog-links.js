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
import { fetchItems, fetchSpells, fetchReferences, fetchBestiary } from "./api.js";

const KIND_CONFIG = {
  item: { fetchAll: fetchItems, urlFor: (id) => `/itembook.html?id=${id}`, keyPrefix: "item" },
  spell: { fetchAll: fetchSpells, urlFor: (id) => `/spellbook.html?id=${id}`, keyPrefix: "spell" },
  reference: { fetchAll: fetchReferences, urlFor: (id) => `/referencebook.html?id=${id}`, keyPrefix: "reference" },
  monster: { fetchAll: fetchBestiary, urlFor: (id) => `/bestiary.html?id=${id}`, keyPrefix: "monster" },
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

function openEntry(kind, id, name) {
  const cfg = KIND_CONFIG[kind];
  if (!cfg) return;
  window.parent.postMessage(
    { type: "beacon:openFloatingWindow", key: cfg.keyPrefix + "-" + id, title: name, url: cfg.urlFor(id) },
    location.origin
  );
}

// wireCatalogLinks — делегированный клик по containerEl, как и у
// enhanceRolls/wireWikiLinks — не нужно перевешивать обработчик при каждой
// перерисовке блока, один вызов после вставки HTML достаточно.
export function wireCatalogLinks(containerEl) {
  if (!containerEl) return;
  containerEl.addEventListener("click", async (e) => {
    const a = e.target.closest("a.catalog-ref");
    if (!a || !containerEl.contains(a)) return;
    e.preventDefault();
    const kind = a.dataset.kind;
    const name = a.dataset.name;
    if (!kind || !name) return;
    const list = await listFor(kind);
    const found = list.find((x) => x.name === name);
    if (!found) return; // карточки с таким именем нет в текущей библиотеке — ссылка просто ничего не делает, не ошибка
    openEntry(kind, found.id, found.name);
  });
}
