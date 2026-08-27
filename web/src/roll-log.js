// roll-log.js — единственный лог бросков кубов на весь проект. Заменяет шесть
// почти одинаковых копий: слушатель vtt:rollResult в web/src/dice.js (стол) и
// showRollResult в bestiary/spellbook/itembook/character-sheet (панели книг и
// листа).
//
// Данные — payload roll_result из комнаты (internal/service/room.go: relayRoll):
// { name, formula, rolls[], modifier, total, label? }. Лог чисто клиентский,
// сервер историю не хранит (бросок эфемерен, как animate_attack).
//
// Вид карточки — в стиле Foundry: строка «кто», тусклая строка-формула
// («рецепт» — что кидали), ниже раскладка блоками (значение каждой кости +
// модификатор-чип + итог). Поведение — в стиле Roll20: новые карточки снизу,
// тело всегда проскроллено вниз, лог сам не скрывается (прячется только пока
// не было ни одного броска).

import { rollGroups } from "./dice.js";

// createRollLog(container, opts) → { push, clear, el }
//   container — элемент-хост; модуль строит внутри .roll-log-body и вешает
//     классы .roll-log / .roll-log--<layout>.
//   opts.layout — "plate" (плавающая плашка в углу канваса, стол; в какой угол —
//     решает страница своим CSS) | "strip" (нижняя приклеенная лента в панели).
//   opts.max — сколько карточек держать (по умолчанию 30).
export function createRollLog(container, { layout = "strip", max = 30 } = {}) {
  container.classList.add("roll-log", `roll-log--${layout}`);
  // Пока броска не было — лога не видно (плашка не мешает канвасу, лента не
  // ест высоту панели). Первый push его показывает.
  container.classList.add("hidden");

  const body = document.createElement("div");
  body.className = "roll-log-body";
  container.appendChild(body);

  function push(data) {
    container.classList.remove("hidden");
    body.appendChild(renderCard(data));
    while (body.children.length > max) body.removeChild(body.firstChild);
    // Roll20-поведение: свежий бросок всегда виден, старые уезжают вверх.
    body.scrollTop = body.scrollHeight;
  }

  function clear() {
    body.replaceChildren();
    container.classList.add("hidden");
  }

  return { push, clear, el: container };
}

function renderCard({ name, label, formula, rolls, modifier, total }) {
  const card = document.createElement("div");
  card.className = "roll-card";

  const who = document.createElement("div");
  who.className = "roll-card-who";
  // label — необязательная подпись броска ("Атлетика", "Спасбросок Ловкости",
  // "Гоблин — Укус"), см. internal/domain/message.go: ClientMsg.Label.
  who.textContent = label ? `${name} — ${label}` : name;
  card.appendChild(who);

  const recipe = document.createElement("div");
  recipe.className = "roll-card-formula";
  recipe.textContent = formula;
  card.appendChild(recipe);

  const brk = document.createElement("div");
  brk.className = "roll-card-break";

  const list = rolls || [];
  if (list.length) {
    // rollGroups раскладывает плоский список значений обратно по членам формулы
    // (см. dice.js). null — формулу не разобрать: показываем значения как есть,
    // без подсветки крит/провал (не знаем граней кости).
    const groups = rollGroups(formula, list);
    const dice = groups
      ? groups.flatMap((g) => g.values.map((v) => ({ v, sides: g.sides })))
      : list.map((v) => ({ v, sides: 0 }));
    for (const d of dice) {
      const die = document.createElement("span");
      die.className = "roll-die";
      // Крит/провал подсвечиваем только на натуральной d20 — как в Foundry.
      if (d.sides === 20 && d.v === 20) die.classList.add("is-crit");
      else if (d.sides === 20 && d.v === 1) die.classList.add("is-fumble");
      die.textContent = d.v;
      brk.appendChild(die);
    }
    if (modifier) {
      const op = document.createElement("span");
      op.className = "roll-op";
      op.textContent = (modifier > 0 ? "+ " : "− ") + Math.abs(modifier);
      brk.appendChild(op);
    }
  }
  // Периодический модификатор без кости («−1» от кровотечения, см.
  // service.Room.applyPeriodicModifiers) шлёт пустой rolls — кидать нечего,
  // число уже готово: показываем только итог.

  const eq = document.createElement("span");
  eq.className = "roll-eq";
  eq.append("= ");
  const strong = document.createElement("b");
  strong.textContent = total;
  eq.appendChild(strong);
  brk.appendChild(eq);

  card.appendChild(brk);
  return card;
}
