// spell-import.js — перевод одного JSON-файла экспорта заклинания с
// https://5e14.ttg.club (кнопка карточки заклинания "Экспортировать в FvTT")
// в наш domain.Spell (см. internal/domain/spell.go). Формат экспорта — это
// один предмет типа "spell" в схеме Foundry VTT dnd5e (то же самое, чем
// пользуется сайт для экспорта существ) — пример такого файла прислал
// пользователь при постановке задачи (Analyze Device.json).
//
// Чистая функция без побочных эффектов: сервер ничего не знает про формат
// Foundry, весь разбор — здесь, на клиенте (см. domain/spell.go: комментарий
// про "умный бланк"). Значения, которых нет в словаре ниже, не теряются —
// подставляется исходный код Foundry как есть, чтобы ничего не пропадало
// молча при встрече с незнакомым/будущим значением.

const SCHOOL_RU = {
  abj: "Ограждение",
  con: "Вызов",
  div: "Прорицание",
  enc: "Очарование",
  evo: "Воплощение",
  ill: "Иллюзия",
  nec: "Некромантия",
  trs: "Преобразование",
};

const ACTIVATION_TYPE_RU = {
  action: "действие",
  bonus: "бонусное действие",
  reaction: "реакция",
  minute: "мин.",
  hour: "ч.",
  day: "дн.",
  legendary: "легендарное действие",
  mythic: "мифическое действие",
  lair: "действие логова",
  crew: "экипаж",
  special: "особое",
  none: "",
};

const RANGE_UNITS_RU = {
  ft: "фт.",
  mi: "миль",
  touch: "Касание",
  self: "На себя",
  spec: "Особая",
  any: "Неограниченная",
  none: "",
};

const TARGET_TYPE_RU = {
  cone: "конус",
  cube: "куб",
  cylinder: "цилиндр",
  line: "линия",
  radius: "радиус",
  sphere: "сфера",
  square: "квадрат",
  wall: "стена",
  creature: "существ(о/а)",
  ally: "союзник(и)",
  enemy: "враг(и)",
  object: "предмет(ы)",
  space: "клетка(и)",
};

const DURATION_UNITS_RU = {
  inst: "Мгновенная",
  turn: "ход",
  round: "раунд(ов)",
  minute: "минута/минут",
  hour: "час(ов)",
  day: "день/дней",
  month: "месяц(ев)",
  year: "год(лет)",
  perm: "Пока не рассеяно",
  disp: "Пока не рассеяно",
  spec: "Особая",
};

const ABILITY_RU = { str: "Сил", dex: "Лов", con: "Тел", int: "Инт", wis: "Мдр", cha: "Хар" };

// DAMAGE_TYPE_RU — та же таблица, что в item-import.js (см. комментарий там
// про "умный бланк"/самодостаточность каждого импортёра) — коды урона общие
// для всей dnd5e-схемы, не только оружия.
const DAMAGE_TYPE_RU = {
  acid: "кислота", bludgeoning: "дробящий", cold: "холод", fire: "огонь", force: "силовое поле",
  lightning: "электричество", necrotic: "некротический", piercing: "колющий", poison: "яд",
  psychic: "психическая энергия", radiant: "излучение", slashing: "рубящий", thunder: "звук",
};

function ru(dict, code) {
  if (!code) return "";
  return Object.prototype.hasOwnProperty.call(dict, code) ? dict[code] : code;
}

// buildSource — system.source менялся так же, как у предметов (см.
// item-import.js): раньше просто строка, в v4/2024 — объект
// {book,page,custom,revision,rules}.
function buildSource(source) {
  if (!source) return "";
  if (typeof source === "string") return source;
  const book = source.book || source.custom || "";
  return book && source.page ? `${book}, стр. ${source.page}` : book;
}

// buildCastTime — activation.cost (dnd5e v2/v3) переименован в
// activation.value в v4/2024 ("Activities", см. item-import.js:
// buildActivation — тот же приём) — принимаем оба имени поля. У заклинаний,
// в отличие от предметов, system.activation остался на самом заклинании (не
// переехал в system.activities целиком), так что искать по активностям не
// нужно.
function buildCastTime(activation) {
  const a = activation || {};
  if (!a.type) return "";
  const unit = ru(ACTIVATION_TYPE_RU, a.type);
  const cost = a.cost !== undefined ? a.cost : a.value;
  const n = cost && cost !== 1 ? String(cost) + " " : a.type === "action" || a.type === "bonus" || a.type === "reaction" || a.type === "legendary" ? "1 " : cost ? String(cost) + " " : "";
  let text = (n + unit).trim();
  if (a.condition) text += ` (${a.condition})`;
  return text;
}

// buildRange — зона действия (форма/размер шаблона) в v4/2024 переехала с
// плоского target.{type,value,units} в target.template.{type,size,units}
// (форма — сфера/конус/куб/...) и target.affects.{type,count} (просто
// "N существ" без формы, например "1 существо" у Очарования личности).
// Старая плоская форма (v2/v3) читается тем же кодом — tmpl/affects
// оказываются равны самому target, если вложенных объектов нет.
function buildRange(range, target) {
  const r = range || {};
  let text = "";
  if (r.units === "ft" || r.units === "mi") {
    text = r.value ? `${r.value} ${ru(RANGE_UNITS_RU, r.units)}` : ru(RANGE_UNITS_RU, r.units);
    if (r.long) text += ` (дальняя ${r.long} ${ru(RANGE_UNITS_RU, r.units)})`;
  } else {
    text = ru(RANGE_UNITS_RU, r.units);
  }
  const t = target || {};
  const tmpl = t.template && typeof t.template === "object" ? t.template : t;
  const size = tmpl.size ?? tmpl.value;
  if (tmpl.type && TARGET_TYPE_RU[tmpl.type] && size) {
    const units = ru(RANGE_UNITS_RU, tmpl.units) || "фт.";
    text += text ? ` (${size} ${units} ${ru(TARGET_TYPE_RU, tmpl.type)})` : `${size} ${units} (${ru(TARGET_TYPE_RU, tmpl.type)})`;
    return text.trim();
  }
  const affects = t.affects && typeof t.affects === "object" ? t.affects : t;
  if (affects.count && affects.type) {
    text += ` (${affects.count} ${ru(TARGET_TYPE_RU, affects.type) || affects.type})`;
  } else if (affects.type && !affects.count) {
    text += ` (${ru(TARGET_TYPE_RU, affects.type) || affects.type})`;
  }
  return text.trim();
}

function buildDuration(duration) {
  const d = duration || {};
  if (!d.units) return "";
  if (d.units === "inst" || d.units === "perm" || d.units === "disp" || d.units === "spec") {
    return ru(DURATION_UNITS_RU, d.units);
  }
  const n = d.value || "";
  return `${n} ${ru(DURATION_UNITS_RU, d.units)}`.trim();
}

// damagePartText — один "кубик" урона в форме v4/2024 ({number,denomination,
// types,bonus,custom:{enabled,formula}}) → "2к6+3 (огонь)". custom.formula
// используется вместо number/denomination, когда автор карточки задал
// произвольную формулу руками (custom.enabled) — так у части заклинаний
// вместо "1d6" может стоять что-то нестандартное.
function damagePartText(part) {
  if (!part) return "";
  let formula = "";
  if (part.custom && part.custom.enabled && part.custom.formula) {
    formula = part.custom.formula;
  } else if (part.number && part.denomination) {
    formula = `${part.number}к${part.denomination}`;
    const bonus = (part.bonus ?? "").toString().trim();
    if (bonus) formula += bonus.startsWith("-") ? bonus : `+${bonus}`;
  } else {
    return "";
  }
  const types = part.types;
  const typeCodes = Array.isArray(types) ? types : types && typeof types === "object" ? Object.keys(types).filter((k) => types[k]) : [];
  const typeText = typeCodes.map((t) => ru(DAMAGE_TYPE_RU, t) || t).join("/");
  return typeText ? `${formula} (${typeText})` : formula;
}

// buildDamage — dnd5e v2/v3 хранил урон прямо на заклинании
// (system.damage.parts = [[formula,type],...]); v4/2024 убрал
// system.damage с самого заклинания — урон теперь внутри ПЕРВОЙ активности
// (см. system.activities — их может быть несколько: сотвори эффект/урони/
// вылечи и т.п.), у которой damage.parts непустой, независимо от типа
// активности (damage/save/attack — Магическая стрела, например, наносит
// урон activity-типом "damage", без атаки и спасброска).
function buildDamage(sys) {
  if (sys.damage && Array.isArray(sys.damage.parts)) {
    return sys.damage.parts
      .map((p) => {
        const formula = Array.isArray(p) ? p[0] : "";
        const type = Array.isArray(p) ? p[1] : "";
        return type ? `${formula} (${ru(DAMAGE_TYPE_RU, type) || type})` : formula;
      })
      .filter(Boolean)
      .join("; ");
  }
  const activities = sys.activities && typeof sys.activities === "object" ? Object.values(sys.activities) : [];
  const act = activities.find((a) => a && a.damage && Array.isArray(a.damage.parts) && a.damage.parts.length);
  if (!act) return "";
  return act.damage.parts.map(damagePartText).filter(Boolean).join("; ");
}

// buildSavingThrow — dnd5e v2/v3: system.save.ability — строка. v4/2024:
// save целиком переехал в activities (см. buildDamage выше про ту же
// миграцию), ability там уже МАССИВ (спасбросок может требовать любую ИЗ
// нескольких характеристик, редко, но бывает) — берём первую активность с
// непустым save.ability, выводим все характеристики через "/".
function buildSavingThrow(sys) {
  if (sys.save && sys.save.ability) {
    const abilities = Array.isArray(sys.save.ability) ? sys.save.ability : [sys.save.ability];
    return abilities.map((a) => ru(ABILITY_RU, a) || a).join("/");
  }
  const activities = sys.activities && typeof sys.activities === "object" ? Object.values(sys.activities) : [];
  const act = activities.find((a) => a && a.save && a.save.ability && (Array.isArray(a.save.ability) ? a.save.ability.length : true));
  if (!act) return "";
  const abilities = Array.isArray(act.save.ability) ? act.save.ability : [act.save.ability];
  return abilities.map((a) => ru(ABILITY_RU, a) || a).join("/");
}

// buildComponents — dnd5e v2/v3: system.components = {vocal,somatic,
// material,ritual,concentration} — отдельные булевы поля. v4/2024: все они
// (плюс свойства оружия у предметов) объединили в один общий набор кодов
// system.properties (Set → массив/объект {code:true} после сериализации,
// тот же приём, что buildWeaponProperties в item-import.js).
function buildComponents(sys) {
  if (sys.components && typeof sys.components === "object") {
    const c = sys.components;
    return { ritual: !!c.ritual, vocal: !!c.vocal, somatic: !!c.somatic, material: !!c.material, concentration: !!c.concentration };
  }
  const raw = sys.properties;
  const codes = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.keys(raw).filter((k) => raw[k]) : [];
  const has = (code) => codes.includes(code);
  return {
    ritual: has("ritual"),
    vocal: has("vocal"),
    somatic: has("somatic"),
    material: has("material"),
    concentration: has("concentration"),
  };
}

// mapFoundrySpellJson — основной вход модуля. raw — уже распарсенный
// JSON.parse() объект файла экспорта. Бросает Error с понятным сообщением,
// если это не похоже на заклинание Foundry (чтобы UI показал вменяемую
// ошибку вместо тихого создания пустой карточки).
export function mapFoundrySpellJson(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Файл не похож на JSON заклинания.");
  if (raw.type && raw.type !== "spell") throw new Error(`Это не заклинание (type: "${raw.type}") — экспортируй карточку заклинания с TTG Club.`);
  const name = (raw.name || "").trim();
  if (!name) throw new Error("В файле нет имени заклинания.");
  const sys = raw.system || {};
  const components = buildComponents(sys);

  return {
    name,
    source: buildSource(sys.source),
    level: Number.isFinite(sys.level) ? sys.level : 0,
    school: ru(SCHOOL_RU, sys.school),
    castTime: buildCastTime(sys.activation),
    ritual: components.ritual,
    range: buildRange(sys.range, sys.target),
    verbal: components.vocal,
    somatic: components.somatic,
    material: components.material,
    materialNote: (sys.materials && sys.materials.value) || "",
    duration: buildDuration(sys.duration),
    concentration: components.concentration,
    savingThrow: buildSavingThrow(sys),
    damage: buildDamage(sys),
    description: (sys.description && sys.description.value) || "",
  };
}
