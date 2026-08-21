// condition-import.js — перевод документа ActiveEffect из Foundry VTT в наш
// domain.Condition (см. internal/domain/condition.go). Чистая функция без
// побочных эффектов, как и остальные импортёры (monster-import.js,
// spell-import.js, item-import.js, reference-import.js): сервер про формат
// Foundry не знает ничего, весь разбор — здесь.
//
// ЧТО ИМЕННО МОЖНО ИМПОРТИРОВАТЬ. Компендиумы Foundry — это база LevelDB
// (v11+) или NeDB (v10-), в браузере она не читается никак; поддерживается
// только JSON, который отдаёт сама Foundry по «Export Data» на документе, и
// «выгруженные» дампы. Принимаем три формы:
//
//   1. один документ ActiveEffect ({name, img, statuses, changes, duration});
//   2. массив таких документов (выгрузка папки/пака);
//   3. документ Item/Actor со вложенным effects[] — тогда карточки состояний
//      делаются из его эффектов (это же попутно даёт список того, что
//      накладывает заклинание, — см. spell-import.js: mapFoundrySpellStatuses).
//
// ЧТО ПРОИСХОДИТ С changes[]. Массив изменений листа актёра
// (mode ADD/OVERRIDE/UPGRADE/…) разбирается на ДВЕ части:
//
//   * то, что ложится на наши цели (см. internal/domain/modifier.go:
//     ModifierTargetLabels) — КД, скорость, максимум хитов, характеристики —
//     становится настоящими Modifier'ами, и приложение их применяет;
//   * всё остальное (бонусы к конкретным видам атак, владения, флаги
//     системы dnd5e) РАСШИФРОВЫВАЕТСЯ В ТЕКСТ поля Mechanics — там оно
//     видно ДМ человеческими словами, но применяет его за столом человек.
//
// Так ничего не пропадает молча и при этом в домен не заезжает модель
// правил dnd5e: ключей у Foundry сотни, наших целей — дюжина.
import { foundryStatusToSlug, conditionName, defaultIcon, normalizeSlug } from "./foundry-conditions.js";
import { MODE_ADD, MODE_SET, MODE_MIN, MODE_MAX, PERIOD_NONE } from "./modifiers.js";

// CHANGE_MODE_RU — режимы ActiveEffect.changes[].mode из Foundry
// (CONST.ACTIVE_EFFECT_MODES): 0 CUSTOM, 1 MULTIPLY, 2 ADD, 3 DOWNGRADE,
// 4 UPGRADE, 5 OVERRIDE.
const CHANGE_MODE_RU = {
  0: "особый",
  1: "умножить на",
  2: "прибавить",
  3: "понизить до",
  4: "повысить до",
  5: "заменить на",
};

// CHANGE_KEY_RU — самые частые ключи dnd5e, чтобы расшифровка читалась
// по-русски, а не «system.attributes.ac.bonus». Незнакомый ключ остаётся
// как есть — тот же принцип, что и у остальных словарей импорта.
const CHANGE_KEY_RU = {
  "system.attributes.ac.bonus": "КД",
  "system.attributes.ac.value": "КД",
  "system.attributes.movement.walk": "скорость",
  "system.attributes.movement.fly": "скорость полёта",
  "system.attributes.hp.max": "максимум хитов",
  "system.attributes.hp.tempmax": "временный максимум хитов",
  "system.bonuses.All-Attacks.attack": "все броски атаки",
  "system.bonuses.abilities.save": "спасброски",
  "system.bonuses.abilities.check": "проверки характеристик",
  "system.bonuses.msak.attack": "рукопашные атаки заклинанием",
  "system.bonuses.mwak.attack": "рукопашные атаки оружием",
  "system.bonuses.rsak.attack": "дальнобойные атаки заклинанием",
  "system.bonuses.rwak.attack": "дальнобойные атаки оружием",
  "system.traits.di.value": "иммунитет к урону",
  "system.traits.dr.value": "сопротивление урону",
  "system.traits.dv.value": "уязвимость к урону",
  "system.traits.ci.value": "иммунитет к состояниям",
};

function ruKey(key) {
  const k = String(key || "").trim();
  return Object.prototype.hasOwnProperty.call(CHANGE_KEY_RU, k) ? CHANGE_KEY_RU[k] : k;
}

// CHANGE_KEY_TARGET — ключи dnd5e, которые ложатся на НАШИ цели (см.
// internal/domain/modifier.go). Только они превращаются в применяемые
// Modifier'ы; остальные ключи уходят текстом в Mechanics (см. шапку файла).
const CHANGE_KEY_TARGET = {
  "system.attributes.ac.bonus": "ac",
  "system.attributes.ac.value": "ac",
  "system.attributes.ac.flat": "ac",
  "system.attributes.movement.walk": "speed",
  "system.attributes.hp.max": "hp.max",
  "system.attributes.init.bonus": "initiative",
  "system.abilities.str.value": "abilities.str",
  "system.abilities.dex.value": "abilities.dex",
  "system.abilities.con.value": "abilities.con",
  "system.abilities.int.value": "abilities.int",
  "system.abilities.wis.value": "abilities.wis",
  "system.abilities.cha.value": "abilities.cha",
};

// CHANGE_MODE_TARGET — режимы Foundry (CONST.ACTIVE_EFFECT_MODES) в наши.
// MULTIPLY (1) и CUSTOM (0) сознательно не поддерживаем: умножение — это
// уже вычисление от базы, которое зависит от порядка и от того, что считать
// базой, а CUSTOM у Foundry вообще означает «спроси систему правил». Такие
// изменения остаются текстом в Mechanics.
const CHANGE_MODE_TARGET = { 2: MODE_ADD, 5: MODE_SET, 4: MODE_MIN, 3: MODE_MAX };

// changeToModifier — одно изменение Foundry в наш Modifier, либо null, если
// оно на нашу модель не ложится (незнакомый ключ, неподдерживаемый режим,
// значение-формула вроде "@abilities.dex.mod" — у нас нет её контекста).
function changeToModifier(ch) {
  const target = CHANGE_KEY_TARGET[String(ch.key || "").trim()];
  const mode = CHANGE_MODE_TARGET[ch.mode];
  if (!target || !mode) return null;
  const value = String(ch.value ?? "").trim();
  if (!/^[+-]?\d+$/.test(value)) return null;
  return { target, mode, value, period: PERIOD_NONE, note: "" };
}

// mapFoundryChanges — разбор changes[] на применяемые модификаторы и остаток
// текстом. Возвращает { modifiers, leftover } — вызывающий кладёт первое в
// Condition.Modifiers, второе в Mechanics.
export function mapFoundryChanges(changes) {
  const modifiers = [];
  const leftover = [];
  for (const ch of Array.isArray(changes) ? changes : []) {
    const mod = changeToModifier(ch);
    if (mod) modifiers.push(mod);
    else leftover.push(ch);
  }
  return { modifiers, leftover };
}

// describeChanges — changes[] одной строкой на изменение. Пустой массив даёт
// пустую строку (а не «—»), чтобы поле Mechanics осталось пустым и его можно
// было заполнить руками.
export function describeChanges(changes) {
  if (!Array.isArray(changes) || changes.length === 0) return "";
  return changes
    .map((ch) => {
      const mode = Object.prototype.hasOwnProperty.call(CHANGE_MODE_RU, ch.mode) ? CHANGE_MODE_RU[ch.mode] : "изменить";
      const value = ch.value === undefined || ch.value === null || ch.value === "" ? "" : ` ${ch.value}`;
      return `${ruKey(ch.key)}: ${mode}${value}`;
    })
    .join("; ");
}

// effectRounds — длительность эффекта в РАУНДАХ. Foundry хранит её тремя
// разными способами сразу (rounds/turns/seconds), причём заклинания на
// «1 минуту» обычно приезжают как seconds: 60 — переводим по правилу 6
// секунд в раунде, как и сама Foundry.
export function effectRounds(duration) {
  const d = duration || {};
  if (d.rounds) return Math.max(0, Math.round(d.rounds));
  if (d.seconds) return Math.max(0, Math.round(d.seconds / 6));
  if (d.turns) return Math.max(0, Math.round(d.turns));
  return 0;
}

// stripHtml — description у ActiveEffect приходит куском HTML. В отличие от
// заклинаний/предметов (там HTML прокидывается в карточку как есть и его
// рендерит marked), у состояния описание короткое и почти всегда одним
// абзацем — оставляем HTML как есть, но подчищаем пустые обёртки, чтобы
// карточка не начиналась с пустой строки.
function cleanDescription(html) {
  return String(html || "")
    .replace(/<p>\s*(&nbsp;|\s)*<\/p>/gi, "")
    .trim();
}

// effectSlug — какой у эффекта наш slug. Foundry кладёт коды состояний в
// statuses[] (может быть несколько — берём первый, он и есть «сам эффект»),
// а если их нет вовсе — выводим slug из имени/ключа документа, чтобы
// карточка всё равно получилась рабочей.
function effectSlug(effect) {
  const statuses = Array.isArray(effect.statuses) ? effect.statuses : [];
  for (const s of statuses) {
    const slug = foundryStatusToSlug(s);
    if (slug) return slug;
  }
  const flagged = effect.flags && effect.flags.core && effect.flags.core.statusId;
  if (flagged) return foundryStatusToSlug(flagged);
  // Имя русское/произвольное — латинского slug'а из него не получится (см.
  // service.NormalizeConditionSlug вырезает кириллицу). Тогда возвращаем
  // пустую строку: карточка создастся, а slug ДМ впишет руками — конструктор
  // об этом прямо предупреждает.
  return normalizeSlug(effect.name || effect.label || "");
}

// mapFoundryEffect — один ActiveEffect → поля domain.Condition. Возвращает
// объект БЕЗ id/updatedAt/system — их проставляет сервер.
export function mapFoundryEffect(effect) {
  const slug = effectSlug(effect);
  const name = String(effect.name || effect.label || "").trim() || conditionName(slug) || "Без имени";
  const rounds = effectRounds(effect.duration);
  const img = String(effect.img || effect.icon || "").trim();
  // changes[] — на две части: применяемое и остаток текстом (см. шапку).
  const { modifiers, leftover } = mapFoundryChanges(effect.changes);
  return {
    name,
    slug,
    // Иконка Foundry — путь внутрь её же установки ("icons/svg/blind.svg"),
    // у нас его взять неоткуда. Поэтому картинку НЕ подставляем, а берём
    // глиф по slug'у из общего словаря (см. foundry-conditions.js:
    // defaultIcon) — карточка сразу выглядит как встроенная. Исходный путь
    // сохраняем в теге, чтобы след не потерялся совсем.
    icon: defaultIcon(slug),
    color: String((effect.tint && String(effect.tint)) || "").trim(),
    overlay: !!(effect.flags && effect.flags.core && effect.flags.core.overlay),
    levels: 0,
    defaultRounds: rounds,
    description: cleanDescription(effect.description),
    modifiers,
    mechanics: describeChanges(leftover),
    source: "Foundry VTT",
    tags: img ? ["импорт", "foundry:" + img.split("/").pop()] : ["импорт"],
  };
}

// collectEffects — вытащить все ActiveEffect-документы из чего угодно, что
// пользователь мог выгрузить: сам эффект, массив эффектов, Item/Actor с
// вложенным effects[], объект-словарь вида {ключ: документ} (так выглядит
// дамп пака). Плоский список, порядок исходный.
export function collectEffects(raw) {
  const out = [];
  const visit = (node, depth) => {
    if (!node || typeof node !== "object" || depth > 3) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    // Похоже на сам ActiveEffect: есть имя и хотя бы один из его признаков.
    const looksLikeEffect =
      (node.name || node.label) &&
      (Array.isArray(node.statuses) || Array.isArray(node.changes) || node.duration || node.type === "base");
    if (looksLikeEffect && !Array.isArray(node.effects)) out.push(node);
    if (Array.isArray(node.effects)) {
      // Item/Actor: сами по себе они состоянием не являются, берём вложенные.
      for (const eff of node.effects) visit(eff, depth + 1);
    }
    if (!looksLikeEffect && !Array.isArray(node.effects)) {
      // Возможно, это словарь документов — пробуем значения.
      for (const value of Object.values(node)) {
        if (value && typeof value === "object") visit(value, depth + 1);
      }
    }
  };
  visit(raw, 0);
  return out;
}

// mapFoundryConditionBatch — главная точка входа: JSON любого из
// поддерживаемых видов → массив карточек состояний. Пустой массив означает
// «не распознали ничего» (вызывающий показывает это сообщением, не
// исключением) — тот же контракт, что у mapFoundryReferenceBatch.
export function mapFoundryConditionBatch(raw) {
  const seen = new Set();
  const out = [];
  for (const effect of collectEffects(raw)) {
    const card = mapFoundryEffect(effect);
    // Дубли по slug'у схлопываем: в выгрузке пака одно и то же состояние
    // часто лежит и отдельным документом, и вложенным в предмет.
    const key = card.slug || card.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(card);
  }
  return out;
}
