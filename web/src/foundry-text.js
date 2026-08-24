// foundry-text.js — очистка Foundry-специфичного макро-синтаксиса в тексте
// ОДИНОЧНОГО импортируемого документа (JSON, вставленный/загруженный вручную
// в карточку — см. item-import.js/spell-import.js/reference-import.js/
// condition-import.js/monster-import.js, кнопки «Импортировать вставленный
// JSON»).
//
// Это ДРУГОЙ путь, чем импорт целого пакета Foundry по ссылке на манифест
// (см. web/src/pages/foundry-import.js): тот получает от сервера текст, уже
// полностью переписанный (см. internal/foundry/links.go — @UUID/@Compendium
// в кликабельные ссылки на карточки, internal/foundry/rolls.go — броски и
// спасброски/проверки в человеческую фразу). Здесь сервера нет и не будет —
// одиночный файл разбирает чистая функция на клиенте, — поэтому берём только
// самое частое: ссылку на компендиум (остаётся видимый текст подписи) и
// бросок формулой ("[[/r 2d6]]{Урон}" → "Урон (2d6)", кликабельным его делает
// web/src/inline-rolls.js). Прочие команды (/save, /check, /skill и
// т.п.) в одиночном экспорте карточки — редкость: от них остаётся подпись,
// если она есть, иначе макрос просто убирается — не так информативно, как
// полный разбор на сервере, но не оставляет в тексте битых квадратных скобок.
const compendiumRefRe = /@(?:Compendium|UUID)\[[^\]]*\]\{([^}]*)\}/g;
const inlineRollRe = /\[\[([^\]]+)\]\](?:\{([^}]*)\})?/g;

// ROLL_COMMANDS — команды, у которых после "/" идёт формула броска как есть
// (в отличие от /save,/check,/skill — там аргументы это код характеристики
// и СЛ, не формула, см. комментарий выше).
const ROLL_COMMANDS = new Set(["r", "roll", "gmr", "gmroll", "br", "blindroll", "sr", "selfroll", "pr", "publicroll", "attack"]);

function withLabel(formula, label) {
  if (!formula) return label;
  if (!label) return formula;
  return `${label} (${formula})`;
}

function cleanRoll(inner, rawLabel) {
  inner = (inner || "").trim();
  const label = (rawLabel || "").trim();
  if (!inner) return label;
  if (!inner.startsWith("/")) {
    // "[[2d6]]" — отложенный бросок без команды, содержимое и есть формула.
    return withLabel(inner, label);
  }
  const spaceIdx = inner.search(/\s/);
  const command = (spaceIdx === -1 ? inner.slice(1) : inner.slice(1, spaceIdx)).toLowerCase();
  const rest = (spaceIdx === -1 ? "" : inner.slice(spaceIdx + 1)).trim();
  if (ROLL_COMMANDS.has(command)) {
    // Атаку (обычно "1d20+N") без своей подписи чаще всего не подписывают в
    // тексте — рядом и так жирным идёт готовый модификатор попадания,
    // дублировать незачем (та же эвристика, что и раньше для существ).
    if (!label && /^1?d20\b/i.test(rest)) return "";
    return withLabel(rest, label);
  }
  // /save, /check, /skill, /damage и прочая механика — сервер разбирает это
  // в фразу вида «спасбросок: Тел (СЛ 15)» при импорте целого модуля (см.
  // internal/foundry/rolls.go: savePhrase/checkPhrase/damagePhrase). Для
  // одиночного файла это редкость и не стоит дублировать словари переводов
  // характеристик/навыков ради него — оставляем подпись, если она есть.
  return label;
}

// cleanFoundryText — см. шапку модуля. Безопасна на пустом/чужом тексте: без
// совпадений возвращает вход как есть (с обрезкой пробелов по краям).
export function cleanFoundryText(text) {
  return String(text || "")
    .replace(compendiumRefRe, "$1")
    .replace(inlineRollRe, (_, inner, label) => cleanRoll(inner, label))
    // Атака без подписи (см. cleanRoll) выше становится пустой строкой — на
    // её месте остаются два соседних пробела ("...+5,  на атаку."), которые
    // не бросаются в глаза только потому, что HTML их и так схлопнёт при
    // отрисовке; сворачиваем явно, чтобы и сырой текст (например, в
    // предпросмотре редактирования) не выглядел неряшливо.
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
