// foundry-import-cards.js — чистая часть импорта пакета Foundry (см.
// pages/foundry-import.js): как документ пака превращается в карточку раздела
// и как импорт решает, что такая карточка уже есть. Вынесено со страницы,
// чтобы это можно было проверить тестами без DOM и сервера (см.
// test/import-golden.test.js).

// tokenArt/itemArt — картинка документа Foundry. Мапперы карточек её не
// трогают (существу/предмету арт задаёт ДМ, а не экспорт), но при импорте
// целого пака сервер уже перенёс файл в /uploads и переписал ссылку — грех
// не подставить. У существа арт токена приоритетнее портрета: на карте
// стоять будет именно он.
export function tokenArt(doc) {
  const token = doc.prototypeToken || doc.token || {};
  const texture = token.texture || {};
  return texture.src || token.img || doc.img || "";
}
export function itemArt(doc) {
  return doc.img || "";
}
// pregenArt — у готового персонажа наоборот: портрет листа важнее арта токена.
export function pregenArt(doc) {
  return (doc && doc.img) || tokenArt(doc);
}

// mapPackDocs — маппинг документов одного раздела. Батчевые мапперы
// (справочник, состояния) получают весь пак разом: архетипу нужно найти
// класс-родителя среди соседей, а состояния схлопываются по slug (см.
// reference-import.js/condition-import.js). У покарточных ошибка одного
// документа не роняет раздел: на его месте null, onError узнаёт причину.
//
// sourceIds — карточка -> _id документа Foundry, из которого она собрана.
// Отдельная карта, а не поле карточки: якорь проставляется ПОСЛЕ сравнения
// "не изменилась ли карточка" (см. importCards на странице), а до тех пор он
// не должен попасть ни в sameCard, ни в глаза ДМ в диалоге конфликта.
export function mapPackDocs(target, docs, onError = () => {}) {
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
          onError(doc, err);
          return null;
        }
      });
  return { mapped, sourceIds };
}

// cardKey — по чему считаем, что «такая карточка уже есть». Имя (без учёта
// регистра и лишних пробелов) — то, что видит ДМ в списке и по чему на
// карточку ссылаются описания (см. web/src/catalog-links.js). У состояний
// ключ машинный — slug: именно им состояние вешается на токен, и два
// «Ослепления» с одним slug'ом — точно одна и та же карточка.
export function cardKey(target, card) {
  if (target.id === "conditions" && card.slug) return "slug:" + String(card.slug).trim().toLowerCase();
  return (card.name || "").trim().toLowerCase();
}

// sameCard — импорт НИЧЕГО не изменит в существующей карточке: каждое поле,
// которое он собирается записать, уже там такое же. Сравниваем только
// importируемые поля — то, что ДМ дописал сам (свои теги, заметки в
// описании соседних полей), карточку «изменившейся» не делает.
export function sameCard(existing, mapped) {
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
