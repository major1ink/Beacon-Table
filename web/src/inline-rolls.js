// inline-rolls.js — постобработка уже вставленного в DOM HTML: превращает
// формулы кубиков и голые модификаторы, которые встречаются в прозе
// (описания способностей монстра, текст заклинания — куда угодно, куда их
// вписал ДМ вручную или занёс импорт с TTG Club), в кликабельные ссылки —
// клик кидает кубик, как инлайн-роллы в чате Foundry VTT.
//
// Никакой игровой логики тут нет и не появляется: это просто удобный клик
// поверх текста, который уже лежит в карточке (domain.Monster/domain.Spell
// как были "умным бланком", так и остаются — сервер по-прежнему не знает,
// что такое бросок). Форматы, которые распознаём:
//   - "1d6+2" / "1к6 + 2" — формула кубика (в разных полях домена встречаются
//     и латинская "d" (см. Monster.HitDice — "8d8+16"), и кириллическая "к"
//     (см. плейсхолдер WeaponRow.Damage — "1к8 рубящий"), поддерживаем обе;
//   - "+4" / "-1" — голый модификатор без кубика (спасброски/навыки в тексте
//     статблока, "к попаданию" и т.п.) — трактуется как проверка/атака 1d20+N.

// diceOrModRe — группа 1: символ перед совпадением (или начало строки), не
// часть замены, нужен только чтобы не проверять вручную границу слова без
// lookbehind (совместимость шире, чем с ним). Группа 2 — то, что оборачиваем.
// Формула кубика проверяется первой альтернативой — раз найдя "1d6+2" целиком,
// движок не попытается ещё отдельно разобрать хвостовой "+2" как голый
// модификатор (поиск продолжается уже после конца этого совпадения).
const diceOrModRe = /(^|[^\w])(\d{1,3}[dк]\d{1,4}(?:\s*[+-]\s*\d{1,3})?|[+-]\d{1,3})(?!\w)/g;

// normalizeFormula — под серверный парсер (internal/service/dice.go:
// diceFormulaRe): латинская "d", без пробелов. Больше одного блока кубиков
// в одной формуле сервер теперь принимает, но из прозы мы их и не собираем —
// diceOrModRe выше распознаёт по одному блоку за раз. Голый
// модификатор ("+4") трактуется как бросок 1d20+модификатор (проверка/атака).
function normalizeFormula(raw) {
  const compact = raw.replace(/к/g, "d").replace(/\s+/g, "");
  return /^[+-]/.test(compact) ? "1d20" + compact : compact;
}

// enhanceRolls — обходит текстовые узлы containerEl (уже вставленного в DOM
// HTML), оборачивает найденные формулы/модификаторы в
// <a class="inline-roll">. sendRoll(formula, label) — тот же коллбек, что
// уже вызывают кнопки 🎲 (см. bestiary.js/spellbook.js: sendRoll).
export function enhanceRolls(containerEl, sendRoll) {
  if (!containerEl) return;
  const walker = document.createTreeWalker(containerEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const tag = node.parentElement && node.parentElement.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "A") return NodeFilter.FILTER_REJECT;
      diceOrModRe.lastIndex = 0; // regex глобальный (см. exec-цикл ниже) — .test() иначе помнит lastIndex между вызовами
      return diceOrModRe.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  // Собираем узлы заранее — мутировать DOM во время обхода TreeWalker нельзя,
  // он потеряет место.
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);

  for (const node of nodes) {
    const text = node.nodeValue;
    diceOrModRe.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let m;
    while ((m = diceOrModRe.exec(text))) {
      const start = m.index + m[1].length; // после ведущего пограничного символа (он остаётся текстом)
      const matched = m[2];
      if (start > last) frag.appendChild(document.createTextNode(text.slice(last, start)));
      const a = document.createElement("a");
      a.className = "inline-roll";
      a.href = "#";
      a.title = "Бросить " + matched;
      a.textContent = matched;
      const formula = normalizeFormula(matched);
      a.addEventListener("click", (e) => {
        e.preventDefault();
        sendRoll(formula, matched);
      });
      frag.appendChild(a);
      last = start + matched.length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}
