// initDiceRoller — общий блок бросков кубов, подключается и в player.html, и
// в dm.html (ДМ тоже кидает кубы, например за NPC).
//
// Панель — "лоток" (dice tray), а не набор кнопок мгновенного броска: клик
// по d4 не бросает, а КЛАДЁТ кубик в пул (три клика по d4 — 3d4, потом два
// по d6 — 3d4+2d6), ПКМ по кубику убирает один обратно, −/+ крутят
// константу-модификатор, и только "Бросить" отправляет формулу целиком.
// Сервер такие смешанные формулы разбирает (см. internal/service/dice.go:
// diceFormulaRe — последовательность блоков NdM и констант через + и -).
//
// Единственный источник правды пула — текстовое поле формулы: кнопки в него
// ПИШУТ, а правка руками читается обратно (parseFormula) и подсвечивает те
// же счётчики. Так "накликал" и "вписал руками" — не два разных режима с
// собственным состоянием, которые надо синхронизировать.
//
// controlsContainer — пустой div для лотка, send — функция отправки
// WS-сообщения (vtt.send). Лог результатов лоток не рисует: это отдельный
// общий виджет (см. web/src/roll-log.js) — страница сама монтирует
// createRollLog и кормит его событием vtt:rollResult.

const DICE = [4, 6, 8, 10, 12, 20, 100];

// diceTermRe — тот же разбор формулы на члены, что и на сервере
// (internal/service/dice.go: diceTermRe), только для подсветки счётчиков и
// красивого лога. Валидацией занимается сервер — клиент не отказывается
// отправлять то, что не смог разобрать сам.
const diceTermRe = /([+-]?)(?:(\d*)d(\d+)|(\d+))/g;

// parseFormula — "3d4+2d6+1" → { counts: {4:3, 6:2}, mod: 1 }. null, если
// строка не раскладывается нацело (значит, это ручной ввод чего-то своего —
// счётчики тогда просто гаснут, а бросок всё равно уйдёт как есть).
export function parseFormula(str) {
  const normalized = String(str || "").toLowerCase().replace(/\s+/g, "");
  if (!normalized) return { counts: {}, mod: 0 };
  if (!/^[+-]?(?:\d{0,3}d\d{1,4}|\d{1,5})(?:[+-](?:\d{0,3}d\d{1,4}|\d{1,5}))*$/.test(normalized)) return null;
  const counts = {};
  let mod = 0;
  diceTermRe.lastIndex = 0;
  for (let m = diceTermRe.exec(normalized); m; m = diceTermRe.exec(normalized)) {
    const sign = m[1] === "-" ? -1 : 1;
    if (m[3] === undefined) {
      mod += sign * Number(m[4]);
      continue;
    }
    // Отрицательный блок кубиков ("2d6-1d4") сервер бросить умеет, но
    // кнопками-счётчиками такое не собрать — считаем формулу "чужой".
    if (sign < 0) return null;
    const sides = Number(m[3]);
    counts[sides] = (counts[sides] || 0) + (m[2] === "" ? 1 : Number(m[2]));
  }
  return { counts, mod };
}

// serializeFormula — обратная операция, в фиксированном порядке DICE, чтобы
// пул не перетасовывался от того, в каком порядке по кнопкам кликали.
export function serializeFormula(pool) {
  const parts = DICE.filter((n) => pool.counts[n] > 0).map((n) => `${pool.counts[n]}d${n}`);
  // Кубиков нет, а модификатор есть — показываем его один, но бросить такое
  // сервер откажется (в формуле нет ни одного кубика), и это правильно:
  // пустой пул с "+3" — незаконченный ввод, а не бросок.
  let out = parts.join("+");
  if (pool.mod > 0) out += (out ? "+" : "") + pool.mod;
  else if (pool.mod < 0) out += (out ? "" : "0") + pool.mod;
  return out;
}

// rollGroups — "3d4+2d6+1" + [2,4,1,5,3] → [{label:"3d4", sides:4, values:[2,4,1]},
// {label:"2d6", sides:6, values:[5,3]}]. Сервер отдаёт значения ПЛОСКИМ списком
// в порядке блоков формулы (см. domain.RollResult.Rolls), разбить обратно можно
// только тут, по той же формуле. Вернёт null, если раскладка не сошлась с
// длиной списка (чужая/битая формула, старый сервер) — вызывающий код тогда
// показывает плоский список как есть.
export function rollGroups(formula, rolls) {
  const list = rolls || [];
  const normalized = String(formula || "").toLowerCase().replace(/\s+/g, "");
  const groups = [];
  let used = 0;
  diceTermRe.lastIndex = 0;
  for (let m = diceTermRe.exec(normalized); m; m = diceTermRe.exec(normalized)) {
    if (m[3] === undefined) continue;
    const count = m[2] === "" ? 1 : Number(m[2]);
    groups.push({ label: `${count}d${m[3]}`, sides: Number(m[3]), values: list.slice(used, used + count) });
    used += count;
  }
  if (used !== list.length) return null;
  return groups;
}

// formatRolls — то же плоским текстом: "3d4[2, 4, 1] + 2d6[5, 3]" для смешанной
// формулы, "[2, 4, 1]" для одиночной или неразобранной.
export function formatRolls(formula, rolls) {
  const list = rolls || [];
  const groups = rollGroups(formula, rolls);
  if (!groups || groups.length < 2) return `[${list.join(", ")}]`;
  return groups.map((g) => `${g.label}[${g.values.join(", ")}]`).join(" + ");
}

export function initDiceRoller(controlsContainer, send) {
  controlsContainer.classList.add("dice-tray");
  controlsContainer.innerHTML = `
    <div class="dice-buttons">${DICE.map(
      (n) =>
        `<button type="button" data-d="${n}" title="ЛКМ — добавить кубик в бросок, ПКМ — убрать">d${n}<span class="dice-count"></span></button>`,
    ).join("")}</div>
    <div class="dice-pool">
      <button type="button" data-mod="-1" title="Модификатор −1">−</button>
      <span class="dice-mod-value">+0</span>
      <button type="button" data-mod="1" title="Модификатор +1">+</button>
      <button type="button" data-clear title="Очистить бросок">Сброс</button>
    </div>
    <div class="dice-custom">
      <input type="text" placeholder="напр. 2d6+3" aria-label="Формула броска" />
      <button type="button" data-roll-custom>Бросить</button>
    </div>
  `;
  const customInput = controlsContainer.querySelector(".dice-custom input");
  const modValue = controlsContainer.querySelector(".dice-mod-value");
  const dieButtons = [...controlsContainer.querySelectorAll("[data-d]")];

  // pool — то, что показано в кнопках-счётчиках; всегда пересобирается из
  // текущего текста поля (renderFromInput), поэтому расходиться с ним не
  // может. null — в поле лежит формула, которую кнопками не собрать.
  let pool = { counts: {}, mod: 0 };

  function renderFromInput() {
    pool = parseFormula(customInput.value);
    for (const btn of dieButtons) {
      const n = Number(btn.dataset.d);
      const count = pool ? pool.counts[n] || 0 : 0;
      btn.classList.toggle("has", count > 0);
      btn.querySelector(".dice-count").textContent = count > 1 ? count : "";
    }
    const mod = pool ? pool.mod : 0;
    modValue.textContent = mod > 0 ? "+" + mod : String(mod);
    modValue.classList.toggle("has", mod !== 0);
  }

  // mutate — правка пула кнопкой. Если в поле лежит "чужая" формула (pool
  // === null), кнопка начинает пул с чистого листа, а не пытается дописаться
  // к тому, что не разобрала.
  function mutate(fn) {
    if (!pool) pool = { counts: {}, mod: 0 };
    fn(pool);
    customInput.value = serializeFormula(pool);
    renderFromInput();
  }

  function roll(formula) {
    if (formula) send({ type: "roll_dice", formula });
  }

  for (const btn of dieButtons) {
    const n = Number(btn.dataset.d);
    btn.onclick = () => mutate((p) => (p.counts[n] = (p.counts[n] || 0) + 1));
    btn.oncontextmenu = (e) => {
      e.preventDefault();
      mutate((p) => (p.counts[n] = Math.max(0, (p.counts[n] || 0) - 1)));
    };
  }
  for (const btn of controlsContainer.querySelectorAll("[data-mod]")) {
    const step = Number(btn.dataset.mod);
    btn.onclick = () => mutate((p) => (p.mod += step));
  }
  controlsContainer.querySelector("[data-clear]").onclick = () => {
    customInput.value = "";
    renderFromInput();
  };

  // Бросок НЕ чистит пул: за столом один и тот же бросок часто повторяют
  // подряд (ещё раз то же самое) — сбрасывает пул только кнопка "Сброс".
  controlsContainer.querySelector("[data-roll-custom]").onclick = () => roll(customInput.value.trim());
  customInput.addEventListener("input", renderFromInput);
  customInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") roll(customInput.value.trim());
  });
  renderFromInput();
}
