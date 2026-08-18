// compendium-taxonomy.js — чистые функции категоризации для единой панели
// "Компендиум" (см. compendium-menu.js/catalog.js). Ни Item.Type, ни
// Reference.Kind не enum — оба свободный текст (см. internal/domain/item.go,
// reference.go), сервер правил D&D не знает. Категории здесь — чисто
// клиентская эвристика для навигации по дереву, ничего не пишется обратно в
// карточку и не хранится на сервере.

// classifyItemType — грубое разбиение Item.Type на 7 бакетов, как в
// референсе (TTG Club). Item.Type при импорте из Foundry (см.
// item-import.js: buildType()) почти всегда начинается с одного из этих
// русских существительных, для карточек, заведённых руками — best-effort,
// несовпавшее падает в общий бакет "Безделушки".
const ITEM_TYPE_RULES = [
  { category: "Оружие", test: /оружие/i },
  { category: "Доспехи", test: /доспех|броня|щит/i },
  { category: "Кольца", test: /кольцо/i },
  { category: "Жезлы", test: /жезл|посох|палочк/i },
  { category: "Чудесные предметы", test: /чудесн/i },
  { category: "Инструменты", test: /инструмент/i },
];

export const ITEM_SUBCATEGORIES = [
  "Оружие",
  "Доспехи",
  "Безделушки",
  "Кольца",
  "Жезлы",
  "Чудесные предметы",
  "Инструменты",
];

export function classifyItemType(typeText) {
  const t = (typeText || "").trim();
  if (t) {
    for (const rule of ITEM_TYPE_RULES) {
      if (rule.test.test(t)) return rule.category;
    }
  }
  return "Безделушки"; // общий бакет — расходники/хлам/контейнеры/одежда/etc.
}

// classifyReferenceKind — группировка Reference.Kind в 4 узла дерева, как на
// скрине. Значения kind берутся из internal/domain/reference.go / README
// каталога "из коробки" (класс/архетип/происхождение/вид/черта класса), но
// поле свободнотекстовое — незнакомое значение (в т.ч. пустое) падает в
// общий бакет "trait", ближайший по смыслу.
export const REFERENCE_GROUPS = [
  { id: "class", label: "Классы", match: (k) => k === "класс" || k === "архетип" },
  { id: "species", label: "Виды", match: (k) => k === "вид" },
  { id: "background", label: "Предыстории", match: (k) => k === "происхождение" },
  { id: "trait", label: "Черты", match: () => true }, // catch-all, должен идти последним
];

export function classifyReferenceKind(kind) {
  const k = (kind || "").trim().toLowerCase();
  for (const g of REFERENCE_GROUPS) {
    if (g.match(k)) return g.id;
  }
  return "trait";
}
