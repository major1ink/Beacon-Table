// reference-import.js — перевод JSON-экспорта документов Foundry VTT (dnd5e)
// типов "class"/"subclass"/"feat"/"race"/"species"/"background"/"facility" в
// наш domain.Reference (см. internal/domain/reference.go). В отличие от
// item-import.js/spell-import.js (одна функция — один документ за раз), тут
// функция БАТЧЕВАЯ: архетипу нужно резолвить system.classIdentifier в ИМЯ
// класса-родителя (domain.Reference.ParentName — снимок имени, не ссылка на
// ID, тот же принцип, что у MonsterSpellRef/InventoryEntry), а это известно
// только если смотреть на весь пак сразу — единственный документ подклассв
// отдельности своего класса "не знает" по имени, только по identifier.
//
// Как и остальные импортёры этого модуля — чистые функции без побочных
// эффектов, сервер ничего не знает про формат Foundry (см. "умный бланк" в
// domain/reference.go).
//
// cleanFoundryText — на пакетном импорте текст уже переписан сервером (см.
// internal/foundry/rolls.go/links.go), второй прогон тут безвредный no-op
// (совпадений уже нет). Нужен ради одиночных документов и на случай, если
// сервер что-то не резолвил (ссылка на чужой модуль, которого нет в архиве).
import { cleanFoundryText } from "./foundry-text.js";

function ru(dict, code) {
  if (!code) return "";
  return Object.prototype.hasOwnProperty.call(dict, code) ? dict[code] : code;
}

// FACILITY_TYPE_RU/FACILITY_SIZE_RU — см. mapOne ниже (case "facility").
// Коды сверены с открытым исходником системы dnd5e (module/config.mjs,
// DND5E.facilities), а не угаданы — это код игровой системы, а не платный
// контент конкретного модуля.
const FACILITY_TYPE_RU = { basic: "базовое", special: "особое" };
const FACILITY_SIZE_RU = { cramped: "тесное", roomy: "просторное", vast: "огромное" };

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
    return { name, kind: "класс", parentName: "", source, imageUrl, description: cleanFoundryText(sys.description && sys.description.value) };
  }
  if (raw.type === "subclass") {
    const parentName = classNameByIdentifier[sys.classIdentifier] || sys.classIdentifier || "";
    return { name, kind: "архетип", parentName, source, imageUrl, description: cleanFoundryText(sys.description && sys.description.value) };
  }
  // Вид и предыстория — те же узлы дерева компендиума, что «Виды» и
  // «Предыстории» (см. compendium-taxonomy.js: REFERENCE_GROUPS), и такие же
  // текстовые карточки, как класс: у dnd5e это документы Item подтипов
  // race/species (имя поменялось в редакции 2024) и background. Приезжают
  // при импорте пака целиком (см. web/src/pages/foundry-import.js) — в
  // одиночном экспорте с ttg.club их не бывает, поэтому появились позже
  // остальных.
  if (raw.type === "race" || raw.type === "species") {
    return { name, kind: "вид", parentName: "", source, imageUrl, description: cleanFoundryText(sys.description && sys.description.value) };
  }
  if (raw.type === "background") {
    return { name, kind: "происхождение", parentName: "", source, imageUrl, description: cleanFoundryText(sys.description && sys.description.value) };
  }
  if (raw.type === "feat") {
    let description = cleanFoundryText(sys.description && sys.description.value);
    // requirements — свободный текст вроде "Жрец 7" (класс+уровень, с
    // которого доступна черта) — у Reference нет отдельного поля под это,
    // дописываем строкой перед основным описанием, как ДМ и увидел бы её в
    // Foundry (там это тоже просто подпись рядом с названием черты).
    if (sys.requirements) description = `<p><strong>Требования:</strong> ${sys.requirements}</p>` + description;
    return { name, kind: "черта класса", parentName: "", source, imageUrl, description };
  }
  // facility — помещение бастиона (правила 2024): документ Item подтипа
  // facility, но без веса/цены/редкости снаряжения — статья правил, как
  // класс/черта (см. internal/foundry/classify.go). sys.type/size/level —
  // статичные свойства помещения из компендиума, дописываем их строкой перед
  // описанием, как и требования черты выше. sys.order/progress/hirelings/
  // trade сюда нарочно не идут — это игровое СОСТОЯНИЕ (кто там сейчас
  // работает, что строится) конкретного мира-источника, а не текст правил, и
  // в определении компендиума у него нет смысла.
  if (raw.type === "facility") {
    const facType = sys.type || {};
    const meta = [];
    if (facType.value) meta.push(`Тип: ${ru(FACILITY_TYPE_RU, facType.value)}`);
    if (sys.size) meta.push(`Размер: ${ru(FACILITY_SIZE_RU, sys.size)}`);
    if (sys.level) meta.push(`Требуемый уровень: ${sys.level}`);
    let description = cleanFoundryText(sys.description && sys.description.value);
    if (meta.length) description = `<p><em>${meta.join(" · ")}</em></p>` + description;
    return { name, kind: "помещение бастиона", parentName: "", source, imageUrl, description };
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
