// merge-in-place.js — перенести ответ автосохранения В ТОТ ЖЕ объект
// карточки, а не подменять переменную (`item = await updateItem(...)`).
//
// Почему: статблок (stat-editor.js), плитки характеристик (monster-block.js),
// чипы состояний и предпросмотры получают объект или его массив ОДИН РАЗ при
// монтировании и дальше мутируют по ссылке. Подмена объекта после первого
// сохранения оставила бы их с осиротевшей копией: следующая правка ушла бы
// в объект, который больше никто не сохраняет, — внешне «правка тихо не
// сохраняется, при перезаходе пусто». Массивы объектов (modifiers) тоже
// сливаются поэлементно: поле держит сам объект-модификатор по ссылке.
export function mergeInPlace(target, saved) {
  for (const key of Object.keys(target)) {
    if (!(key in saved)) delete target[key];
  }
  for (const [key, value] of Object.entries(saved)) {
    if (Array.isArray(target[key]) && Array.isArray(value)) mergeArrayInPlace(target[key], value);
    else if (target[key] && typeof target[key] === "object" && !Array.isArray(target[key]) && value && typeof value === "object" && !Array.isArray(value)) mergeInPlace(target[key], value);
    else target[key] = value;
  }
  return target;
}

function mergeArrayInPlace(cur, value) {
  for (let i = 0; i < value.length; i++) {
    const v = value[i];
    if (cur[i] && typeof cur[i] === "object" && v && typeof v === "object") Object.assign(cur[i], v);
    else cur[i] = v;
  }
  cur.length = value.length;
}
