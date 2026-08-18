// reference-import.js — перевод JSON-экспорта документов Foundry VTT (dnd5e)
// типов "class"/"subclass"/"feat" в наш domain.Reference (см.
// internal/domain/reference.go). В отличие от item-import.js/spell-import.js
// (одна функция — один документ за раз), тут функция БАТЧЕВАЯ: архетипу
// нужно резолвить system.classIdentifier в ИМЯ класса-родителя
// (domain.Reference.ParentName — снимок имени, не ссылка на ID, тот же
// принцип, что у MonsterSpellRef/InventoryEntry), а это известно только если
// смотреть на весь пак сразу — единственный документ подклассв отдельности
// своего класса "не знает" по имени, только по identifier.
//
// Как и остальные импортёры этого модуля — чистые функции без побочных
// эффектов, сервер ничего не знает про формат Foundry (см. "умный бланк" в
// domain/reference.go).

// buildSource — та же функция, что в item-import.js/spell-import.js:
// system.source менялся между версиями схемы dnd5e — раньше просто строка, в
// v4/2024 объект {book,page,custom,revision,rules}.
function buildSource(source) {
  if (!source) return "";
  if (typeof source === "string") return source;
  const book = source.book || source.custom || "";
  return book && source.page ? `${book}, стр. ${source.page}` : book;
}

// mapOne — один документ Foundry -> domain.Reference (без id/updatedAt —
// как и у остальных импортёров, сервис их сам проставляет при
// Create/Update). null — документ не class/subclass/feat, пропускаем молча
// (см. mapFoundryReferenceBatch: пак вроде classes попутно содержит и
// нерелевантные типы, например случайное оружие — не повод ронять весь батч
// ошибкой, как делают item-import.js/spell-import.js для одиночного файла).
function mapOne(raw, classNameByIdentifier) {
  if (!raw || typeof raw !== "object") return null;
  const name = (raw.name || "").trim();
  if (!name) return null;
  const sys = raw.system || {};
  const source = buildSource(sys.source);
  const imageUrl = raw.img || "";

  if (raw.type === "class") {
    return { name, kind: "класс", parentName: "", source, imageUrl, description: (sys.description && sys.description.value) || "" };
  }
  if (raw.type === "subclass") {
    const parentName = classNameByIdentifier[sys.classIdentifier] || sys.classIdentifier || "";
    return { name, kind: "архетип", parentName, source, imageUrl, description: (sys.description && sys.description.value) || "" };
  }
  if (raw.type === "feat") {
    let description = (sys.description && sys.description.value) || "";
    // requirements — свободный текст вроде "Жрец 7" (класс+уровень, с
    // которого доступна черта) — у Reference нет отдельного поля под это,
    // дописываем строкой перед основным описанием, как ДМ и увидел бы её в
    // Foundry (там это тоже просто подпись рядом с названием черты).
    if (sys.requirements) description = `<p><strong>Требования:</strong> ${sys.requirements}</p>` + description;
    return { name, kind: "черта класса", parentName: "", source, imageUrl, description };
  }
  return null;
}

// mapFoundryReferenceBatch — основной вход модуля. rawArray — массив уже
// распарсенных JSON.parse() документов (обычно целый распакованный пак
// Foundry, см. план фичи) — порядок внутри массива не важен, classIdentifier
// класса резолвится по ВСЕМ документам типа "class" в этом же массиве,
// прежде чем маппить архетипы. Не бросает Error на неподходящих документах —
// просто пропускает (см. mapOne) — в отличие от item-import.js/spell-import.js,
// здесь исходный пак всегда разнородный и большой, ошибка на одном чужом
// документе не должна требовать разбирать импорт на части.
export function mapFoundryReferenceBatch(rawArray) {
  if (!Array.isArray(rawArray)) rawArray = [rawArray];
  const classNameByIdentifier = {};
  for (const raw of rawArray) {
    if (raw && raw.type === "class" && raw.system && raw.system.identifier) {
      classNameByIdentifier[raw.system.identifier] = (raw.name || "").trim();
    }
  }
  return rawArray.map((raw) => mapOne(raw, classNameByIdentifier)).filter(Boolean);
}
