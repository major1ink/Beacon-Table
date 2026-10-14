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
//     статблока, "к попаданию" и т.п.) — трактуется как проверка/атака кубом
//     проверки системы + N (у D&D — 1d20+N, см. rollFormula).
//
// Подпись броска в общем логе (см. sendRoll у бестиария/пика действий) берётся
// из текста вокруг формулы: "+4 к попаданию" уходит в лог как "попадание",
// блок урона из "Попадание: 5 (1к6 + 2)" — как "урон" (см. rollContextLabel).
// Если по тексту не понять — подписью, как и раньше, остаётся сама формула.
// Формула сразу за названием характеристики («Лов +5») подписывается полным
// названием из схемы системы (short у поля, см. statNames).

import { diceRoll, parse } from "./schema-formula.js";
import { SCHEMA_KINDS, loadSchemas, schemaFor } from "./schemas.js";
import { checkDie, loadSystemProfile } from "./system-profile.js";

// diceOrModRe — группа 1: символ перед совпадением (или начало строки), не
// часть замены, нужен только чтобы не проверять вручную границу слова без
// lookbehind (совместимость шире, чем с ним). Группа 2 — то, что оборачиваем.
// Формула кубика проверяется первой альтернативой — раз найдя "1d6+2" целиком,
// движок не попытается ещё отдельно разобрать хвостовой "+2" как голый
// модификатор (поиск продолжается уже после конца этого совпадения).
// Количество кубиков перед "d/к" необязательно ("d100" — то же, что
// "1d100", обычное сокращение и в самом Foundry, и у сервера — см.
// internal/service/dice.go: diceFormulaRe тоже принимает \d{0,3}); без этого
// формулы вида "[[/r d100]]" (см. web/src/foundry-text.js), доехавшие как
// голое "d100", оставались бы текстом без клика.
//
// Закрывающая скобка перед совпадением исключена: "…)d8" и "…)+1)" — хвост
// большого выражения, а не бросок (прогрессия заговора, ссылки "(@flags.…)").
// Открывающая остаётся: "5 (1к6 + 2)" кликается целиком.
const diceOrModRe = /(^|[^\w)])(\d{0,3}[dк]\d{1,4}(?:\s*[+-]\s*\d{1,3})?|[+-]\d{1,3})(?!\w)/g;

// rollFormula — под серверный парсер (internal/service/dice.go:
// diceFormulaRe): латинская "d", без пробелов. Больше одного блока кубиков
// в одной формуле сервер теперь принимает, но из прозы мы их и не собираем —
// diceOrModRe выше распознаёт по одному блоку за раз. Голый модификатор
// ("+4") бросается кубом проверки системы (check, GET /api/system: rolls.check
// — у D&D и «Своей системы» «1d20»): «1d20+4», «2d6+4». Пустой check — голый
// модификатор не бросается (null).
export function rollFormula(raw, check) {
  const compact = String(raw).replace(/к/g, "d").replace(/\s+/g, "");
  if (!/^[+-]/.test(compact)) return compact;
  if (!check) return null;
  try {
    return diceRoll(parse(`${check} ${compact}`, true), () => 0).formula;
  } catch {
    return null;
  }
}

// statNames — словарь «короткое или полное название поля (строчными) →
// полное название» из схем системы мира: у полей с short («Лов» →
// «Ловкость»). По нему «Лов +5» в тексте уходит в лог подписью «Ловкость»,
// а не «+5».
export function statNames(schemas) {
  const out = new Map();
  const add = (f) => {
    if (!f || !f.short || !f.label) return;
    out.set(String(f.short).trim().toLowerCase(), f.label);
    out.set(String(f.label).trim().toLowerCase(), f.label);
  };
  for (const schema of schemas) {
    for (const f of Object.values((schema && schema.fields) || {})) {
      add(f);
      for (const c of (f && f.columns) || []) add(c);
    }
  }
  return out;
}

// namedLabel — полное название характеристики, если формула идёт сразу за
// её названием («Спасброски: Лов +5» → «Ловкость»); "" — нет. Название
// бывает из нескольких слов («Ловкость рук»), точка сокращения («Лов.»)
// не мешает.
export function namedLabel(before, names) {
  if (!names || !names.size) return "";
  const words = String(before).replace(/[.:]?\s*$/, "").split(/[\s,;:(]+/);
  for (let n = Math.min(3, words.length); n >= 1; n--) {
    const key = words.slice(-n).join(" ").replace(/\.$/, "").toLowerCase();
    if (key && names.has(key)) return names.get(key);
  }
  return "";
}

// rollContextLabel — по тексту вокруг формулы понимает, ЧТО это за бросок,
// чтобы в общем логе не было двух безымянных строк «+4» и «1к6 + 2», по
// которым не разобрать, где попадание, а где урон (см. sendRoll в
// combat-actions-peek.js/bestiary.js — подпись уходит в лог как есть).
// before/after — текст того же узла до и после совпадения. Возвращает
// короткую подпись или "" (тогда подписью остаётся сама формула, как раньше).
export function rollContextLabel(before, after) {
  // Текущее предложение до/после формулы (по «.», «!», «?» — но НЕ по «;»:
  // блоки урона одного удара разделены «; », это всё ещё одна фраза).
  const phrase = String(before).split(/(?<=[.!?])\s+/).pop() || "";
  const rest = String(after);
  const leadSentence = rest.split(/[.!?]/)[0] || "";
  // «+4 к попаданию» / «+4 на попадание» — бросок атаки. Проверяем первым:
  // в ручном тексте ДМ за «к попаданию» дальше в той же фразе бывает и
  // «... колющего урона», и это всё равно бросок на попадание, а не на урон.
  if (/^[\s,]*(?:к|на)\s+попадани/i.test(rest)) return "попадание";
  // «Попадание: 5 (1к6 + 2), рубящий; 7 (2к6), яд» — блок(и) урона удара.
  if (/попадани[ея]?\s*:/i.test(phrase)) return "урон";
  // Проза вроде «получает 8к6 урона огнём» / «2к6 некротического урона».
  if (/урон/i.test(phrase) || /урон/i.test(leadSentence)) return "урон";
  return "";
}

// enhanceRolls — обходит текстовые узлы containerEl (уже вставленного в DOM
// HTML), оборачивает найденные формулы/модификаторы в
// <a class="inline-roll">. sendRoll(formula, label) — тот же коллбек, что
// уже вызывают кнопки 🎲 (см. bestiary.js/spellbook.js: sendRoll).
export function enhanceRolls(containerEl, sendRoll) {
  if (!containerEl) return;
  loadSystemProfile();
  loadSchemas();
  const bareMods = checkDie() !== "";
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
      // Система без куба проверки: голый модификатор остаётся текстом.
      if (!bareMods && /^[+-]/.test(matched)) continue;
      if (start > last) frag.appendChild(document.createTextNode(text.slice(last, start)));
      const a = document.createElement("a");
      a.className = "inline-roll";
      a.href = "#";
      a.title = "Бросить " + matched;
      a.textContent = matched;
      const before = text.slice(0, start);
      const after = text.slice(start + matched.length);
      // Куб проверки и названия полей — из профиля и схем системы мира:
      // загружаются один раз на страницу, к клику они уже есть.
      a.addEventListener("click", async (e) => {
        e.preventDefault();
        await Promise.all([loadSystemProfile(), loadSchemas()]);
        const formula = rollFormula(matched, checkDie());
        if (!formula) return;
        const names = statNames(SCHEMA_KINDS.map(schemaFor));
        sendRoll(formula, namedLabel(before, names) || rollContextLabel(before, after) || matched);
      });
      frag.appendChild(a);
      last = start + matched.length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}
