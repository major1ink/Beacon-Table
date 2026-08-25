// hp-bar.js — общий кусок «хиты, которые можно потянуть»: разбор быстрого
// ввода («+5» / «-5» / «17») и жест перетаскивания полоски. Общий для
// трекера инициативы ДМ (combat-panel.js) и бланка персонажа игрока
// (pages/character-sheet.js) — жест и правила ввода там обязаны быть
// одинаковыми: за столом это одно и то же действие «поправить хиты», и
// пальцевая память не должна зависеть от того, чей экран.
//
// Модуль НЕ знает ни про WS, ни про бланк: получает функции чтения
// состояния и применения результата. Разметку полоски тоже строит
// вызывающий — у трекера и бланка она своя (свои классы и размеры), общее
// тут только поведение.

// parseQuickValue — что вбили в поле быстрого ввода:
//   "+5"/"-5" → { delta, value }  — изменение (урон/лечение);
//   "17"      → { delta: null, value } — поставить ровно столько;
//   мусор/пусто → null.
// Отличать дельту от абсолютного значения важно именно из-за временных
// хитов: урон дельтой съедает их первым (правило считает сервер, см.
// domain.ClientMsg: HPDelta), а «поставить ровно» — это правка поля.
export function parseQuickValue(raw, current) {
  // Минус из русской раскладки/типографики ("−", "–", "—") приводим к
  // обычному дефису: на телефоне и при копипасте из чата прилетает и такое.
  const t = String(raw || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[‒–—―−]/g, "-");
  if (!t) return null;
  if (/^[+-]\d+$/.test(t)) {
    const delta = parseInt(t, 10);
    return { delta, value: current + delta };
  }
  if (/^\d+$/.test(t)) return { delta: null, value: parseInt(t, 10) };
  return null;
}

// attachHpDrag — «потянуть полоску, чтобы выставить хиты». Тянем ТЕКУЩИЕ
// хиты (0..max) — временные полоска показывает отдельным хвостом, но жест
// их не трогает: снять их «примерно на глаз» бессмысленно, урон по ним
// вводится дельтой в поле рядом.
//
//   getState() → { current, max } на момент нажатия;
//   onPreview(value) — перерисовать себя под ещё не применённое значение
//                      (null — отменить предпросмотр, ничего не менялось);
//   onCommit(value)  — применить (отпустили кнопку и значение изменилось).
//
// Слушатели движения висят на window, а не на самой полоске, и прямоугольник
// снимается один раз в начале: карточка бойца в трекере перерисовывается
// целиком на каждый "combat_state" с сервера, и элемент под курсором может
// исчезнуть прямо посреди жеста — с window-слушателями это не ломает
// перетаскивание.
export function attachHpDrag(barEl, { getState, onPreview, onCommit }) {
  if (!barEl) return;
  barEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const { current, max } = getState();
    if (!(max > 0)) return; // без максимума полоске нечего показывать
    e.preventDefault();
    const rect = barEl.getBoundingClientRect();
    const valueAt = (clientX) => {
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return Math.round(ratio * max);
    };
    let value = valueAt(e.clientX);
    onPreview(value);
    const move = (ev) => {
      const next = valueAt(ev.clientX);
      if (next === value) return;
      value = next;
      onPreview(value);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (value !== current) onCommit(value);
      else onPreview(null); // просто клик по текущему значению — ничего не произошло
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  });
}

// hpFillRatios — как раскрасить полоску: доля текущих хитов и доля хвоста
// временных за ними (вместе не больше 100%, иначе хвост уехал бы за край).
// Общая функция, чтобы трекер и бланк считали одинаково.
export function hpFillRatios({ current, temp, max }) {
  if (!(max > 0)) return { hp: 0, temp: 0 };
  const hp = Math.max(0, Math.min(1, (current || 0) / max));
  const tempRatio = Math.max(0, Math.min(1 - hp, (temp || 0) / max));
  return { hp, temp: tempRatio };
}

// hpColor — цвет полоски по доле оставшихся хитов: те же три ступени, что
// на бланке персонажа (зелёный → золотой → красный).
export function hpColor(ratio) {
  return ratio > 0.5 ? "var(--green-bright, #5fd08a)" : ratio > 0.25 ? "var(--gold, #e0c95a)" : "#d9534f";
}
