// Счётчик ширмы: руками или сам по событиям стола. Значение ведёт сервер
// (room_screen.go), окно только шлёт шаги и получает screen_counters.
import { icon } from "../icons.js";
import { openModal } from "../modal.js";
import { ctx, el } from "./shared.js";

const AUTO = [
  ["", "Вручную"],
  ["round", "Раунды боя"],
  ["turn", "Ходы в бою"],
  ["killed", "Выбывшие в бою"],
  ["roll", "Броски"],
  ["scene", "Смена сцены"],
  ["combat", "Начало боя"],
];
const FIGHTERS = [
  ["", "Все"],
  ["players", "Персонажи игроков"],
  ["monsters", "Противники"],
];
const WHO = {
  turn: FIGHTERS,
  killed: FIGHTERS,
  roll: [
    ["", "Все"],
    ["players", "Игроки"],
    ["monsters", "Ведущий"],
  ],
};
const ROLL = [
  ["nat20", "Натуральная 20 на d20"],
  ["nat1", "Натуральная 1 на d20"],
  ["min", "Итог не меньше…"],
];
const label = (list, v) => (list.find(([k]) => k === (v || "")) || list[0])[1];

// summary — что считает, одной строкой под числом.
export function counterSummary(cell) {
  if (!cell.auto) return "";
  let text = label(AUTO, cell.auto);
  if (cell.auto === "roll") text += cell.roll === "min" ? ` · итог ≥ ${cell.rollMin || 0}` : cell.roll === "nat1" ? " · нат. 1" : " · нат. 20";
  if (cell.who && WHO[cell.auto]) text += " · " + label(WHO[cell.auto], cell.who).toLowerCase();
  return text;
}

const views = new Set();

// onCounters — сервер сдвинул счётчики: число на месте, без перерисовки ширмы.
export function onCounters(list) {
  for (const c of list || []) {
    for (const t of ctx.screen.tabs) {
      for (const cell of t.cells || []) {
        if (cell.id === c.id && cell.kind === "counter") {
          cell.value = c.value;
          cell.done = !!c.done;
        }
      }
    }
  }
  for (const v of views) {
    if (!v.value.isConnected) views.delete(v);
    else v.draw();
  }
}

function send(cell, msg) {
  if (ctx.socket) ctx.socket.send({ type: "screen_counter", id: cell.id, ...msg });
}

export function counterWidget(cell) {
  const value = el("div", { class: "counter-value serif" });
  const note = el("div", { class: "counter-note" });
  const draw = () => {
    value.textContent = String(cell.value || 0);
    if (cell.target && (ctx.gm || cell.showTarget)) value.append(el("small", { text: "/ " + cell.target }));
    value.classList.toggle("reached", !!cell.target && (cell.done || (cell.value || 0) >= cell.target));
    note.textContent = cell.done ? "Порог взят — счёт стоит" : counterSummary(cell);
    note.title = note.textContent; // в узкой ячейке подпись обрезается многоточием
    note.hidden = !note.textContent;
  };
  views.add({ value, draw });
  draw();
  const main = el("div", { class: "counter-main" }, [value, note]);
  if (!ctx.gm) return el("div", { class: "counter" }, [main]);

  const step = (d) => () => {
    cell.value = (cell.value || 0) + d;
    draw();
    send(cell, { counterDelta: d });
  };
  const reset = el("button", { class: "icon-btn", type: "button", title: "Сбросить в ноль", html: icon("repeat", { size: 15 }) });
  reset.onclick = () => {
    cell.value = 0;
    cell.done = false;
    draw();
    send(cell, { counterReset: true });
  };
  const shown = el("button", { class: "icon-btn", type: "button" });
  const drawShown = () => {
    shown.innerHTML = icon(cell.public ? "eye" : "eye-off", { size: 15 });
    shown.title = cell.public ? "Видят игроки и трансляция — скрыть" : "Показать игрокам и на трансляции";
    shown.classList.toggle("on", !!cell.public);
  };
  drawShown();
  shown.onclick = () => {
    cell.public = !cell.public;
    drawShown();
    ctx.saveQuiet();
  };
  const gear = el("button", { class: "icon-btn", type: "button", title: "Что считать и когда сообщить", html: icon("gear", { size: 15 }) });
  gear.onclick = () => counterSettings(cell);
  return el("div", { class: "counter counter-gm" }, [
    el("button", { class: "counter-btn counter-minus", type: "button", text: "−", "aria-label": "Меньше", onclick: step(-1) }),
    main,
    el("button", { class: "counter-btn counter-plus", type: "button", text: "+", "aria-label": "Больше", onclick: step(1) }),
    el("div", { class: "timer-controls" }, [reset, shown, gear]),
  ]);
}

const select = (list, v, aria) => {
  const s = el("select", { "aria-label": aria });
  for (const [k, text] of list) s.append(new Option(text, k));
  s.value = v || "";
  return s;
};
const check = (text, on) => {
  const box = el("input", { type: "checkbox" });
  box.checked = !!on;
  return { box, row: el("label", { class: "counter-check" }, [box, el("span", { text })]) };
};
const row = (text, ...kids) => el("label", { class: "counter-row" }, [el("span", { class: "label", text }), ...kids]);

function counterSettings(cell) {
  let read = () => null;
  openModal({
    title: cell.title || "Счётчик",
    okLabel: "Сохранить",
    cancelLabel: "Отмена",
    buildBody: (body) => {
      const auto = select(AUTO, cell.auto, "Что считать");
      const who = select([], "", "Чьё событие");
      const roll = select(ROLL, cell.roll || "nat20", "Какой бросок");
      const rollMin = el("input", { type: "number", value: String(cell.rollMin || 15), "aria-label": "Итог не меньше", style: "width:90px" });
      const target = el("input", { type: "number", min: "0", placeholder: "нет", value: cell.target ? String(cell.target) : "", "aria-label": "Порог" });
      const notice = el("input", { maxlength: "500", placeholder: "Достигнуто…", value: cell.notice || "", "aria-label": "Сообщение" });
      const noticeTo = select(
        [
          ["dm", "Только ведущему"],
          ["all", "Всем в чат стола"],
        ],
        cell.noticeTo || "dm",
        "Кому"
      );
      const then = select(
        [
          ["", "Остановиться"],
          ["repeat", "Начать заново с нуля"],
        ],
        cell.repeat ? "repeat" : "",
        "После порога"
      );
      const pub = check("Показывать игрокам и на трансляции", cell.public);
      const titled = check("С подписью", !cell.noTitle);
      const withTarget = check("С порогом", cell.showTarget);

      const whoRow = row("Чьё", who);
      const rollRow = row("Бросок", el("div", { class: "counter-inline" }, [roll, rollMin]));
      const afterRows = [row("Сообщение", notice), row("Кому", noticeTo), row("Потом", then)];
      const shownRows = el("div", { class: "counter-sub" }, [titled.row, withTarget.row]);
      const sync = () => {
        const list = WHO[auto.value];
        whoRow.hidden = !list;
        if (list && !who.options.length) {
          for (const [k, text] of list) who.append(new Option(text, k));
          who.value = auto.value === cell.auto ? cell.who || "" : "";
        }
        rollRow.hidden = auto.value !== "roll";
        rollMin.hidden = roll.value !== "min";
        const hasTarget = Number(target.value) > 0;
        for (const r of afterRows) r.hidden = !hasTarget;
        shownRows.hidden = !pub.box.checked;
        withTarget.row.hidden = !hasTarget;
      };
      auto.onchange = () => {
        who.textContent = "";
        sync();
      };
      roll.onchange = target.oninput = pub.box.onchange = sync;
      sync();
      body.append(
        row("Считать", auto),
        whoRow,
        rollRow,
        row("Порог", target),
        ...afterRows,
        el("p", { class: "bt-modal-text dim", text: "При пороге сообщение уходит в чат, даже если ширма закрыта." }),
        pub.row,
        shownRows
      );
      read = () => ({
        auto: auto.value,
        who: whoRow.hidden ? "" : who.value,
        roll: auto.value === "roll" ? roll.value : "",
        rollMin: auto.value === "roll" && roll.value === "min" ? Math.round(Number(rollMin.value) || 0) : 0,
        target: Math.max(0, Math.round(Number(target.value) || 0)),
        notice: notice.value.trim(),
        noticeTo: noticeTo.value,
        repeat: then.value === "repeat",
        public: pub.box.checked,
        noTitle: !titled.box.checked,
        showTarget: withTarget.box.checked,
      });
      return auto;
    },
    onOk: () => read(),
    onCancel: () => null,
  }).then((next) => {
    if (!next) return;
    Object.assign(cell, next);
    ctx.persist();
  });
}
