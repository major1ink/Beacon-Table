// Граф связей журнала: узлы — записи, рёбра — [[ссылки]] (пунктир) и связи
// из блока ```связи (цвет по типу). Граф с правами собирает сервер
// (GET /api/journal/graph, domain.BuildJournalGraph) — здесь только раскладка
// и показ. Живёт в окне журнала (pages/journal.js) и в ячейке ширмы
// (gm-screen/cells.js, compact).
import { fetchJournalGraph } from "./api.js";
import { relationColor, relationLabel, RELATION_TYPES } from "./notes/relations.js";
import { icon } from "./icons.js";

const NODE_W = 176;
const NODE_H = 40;
const POS_KEY = "journal-graph-pos";

// Цвет узла — по верхней папке: «NPC», «Места», «Фракции» у всех разные.
const FOLDER_COLORS = [
  ["rgba(124,108,240,.3)", "#cfc8ff"],
  ["rgba(31,107,58,.38)", "#bdf0c9"],
  ["rgba(194,91,91,.32)", "#f0a0a0"],
  ["rgba(58,90,138,.48)", "#bcd3f5"],
  ["rgba(181,137,31,.32)", "#f0d690"],
  ["rgba(40,140,140,.32)", "#a6e6e6"],
  ["rgba(190,90,160,.3)", "#f0b0dc"],
  ["rgba(255,255,255,.1)", "#ddd"],
];

export function topFolder(folder) {
  return (folder || "").split("/")[0];
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// Цвета раздаются по алфавиту папок, а не хэшем: так у пяти папок не
// выпадут два одинаковых.
let folderOrder = [];

function folderColor(folder) {
  if (!folder) return FOLDER_COLORS[FOLDER_COLORS.length - 1];
  let i = folderOrder.indexOf(folder);
  if (i < 0) i = hash(folder);
  return FOLDER_COLORS[i % (FOLDER_COLORS.length - 1)];
}

// mergeMutual — связь без направления («семья», «враг»), объявленная в обеих
// записях, — одна связь, а не две линии и две строки. У типа с обратной
// подписью («подчинённый») направление и есть смысл — его не трогаем.
export function mergeMutual(edges) {
  const seen = new Map();
  const out = [];
  for (const e of edges) {
    const t = e.type && RELATION_TYPES[e.type];
    if (!t || t.reverse) {
      out.push(e);
      continue;
    }
    const key = [e.from, e.to].sort().join("\0") + "\0" + e.type;
    const prev = seen.get(key);
    if (prev) {
      // Игрок видит связь, если читает хоть одну из записей, где она объявлена.
      prev.secret = prev.secret && e.secret;
      continue;
    }
    const copy = { ...e };
    seen.set(key, copy);
    out.push(copy);
  }
  return out;
}

function setFolderOrder(nodes) {
  folderOrder = [...new Set(nodes.map((n) => topFolder(n.folder)).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ru"));
}

// layoutGraph — силовая раскладка: узлы отталкиваются, рёбра тянут. Старт
// детерминированный (от id), поэтому без перетаскиваний граф каждый раз
// встаёт одинаково. fixed — позиции, которые человек расставил руками.
export function layoutGraph(nodes, edges, fixed = new Map()) {
  const pos = new Map();
  const n = nodes.length;
  if (!n) return pos;
  const folders = [...new Set(nodes.map((v) => topFolder(v.folder)))];
  const spread = 120 * Math.sqrt(n);
  for (const v of nodes) {
    const f = fixed.get(v.id);
    if (f) {
      pos.set(v.id, { x: f.x, y: f.y, vx: 0, vy: 0, fixed: true });
      continue;
    }
    // Записи одной папки стартуют рядом — так кластеры читаются сразу.
    const a = (folders.indexOf(topFolder(v.folder)) / folders.length) * Math.PI * 2;
    const h = hash(v.id);
    const r = spread * (0.35 + ((h & 0xff) / 255) * 0.5);
    const jitter = (((h >> 8) & 0xff) / 255 - 0.5) * 1.2;
    pos.set(v.id, { x: Math.cos(a + jitter) * r, y: Math.sin(a + jitter) * r, vx: 0, vy: 0 });
  }
  const list = [...pos.values()];
  const links = edges.map((e) => [pos.get(e.from), pos.get(e.to)]).filter(([a, b]) => a && b);
  const k = 230;
  const iterations = n > 300 ? 120 : 260;
  for (let it = 0; it < iterations; it++) {
    const t = 1 - it / iterations;
    for (let i = 0; i < n; i++) {
      const a = list[i];
      for (let j = i + 1; j < n; j++) {
        const b = list[j];
        let dx = a.x - b.x;
        let dy = (a.y - b.y) * 2.2; // узел широкий и низкий — по вертикали теснее
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) {
          dx = 1;
          dy = 0;
          d2 = 1;
        }
        if (d2 > 9 * k * k) continue;
        const f = (k * k) / d2;
        a.vx += dx * f;
        a.vy += dy * f;
        b.vx -= dx * f;
        b.vy -= dy * f;
      }
    }
    for (const [a, b] of links) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = d / k;
      a.vx += dx * f * 0.6;
      a.vy += dy * f * 0.6;
      b.vx -= dx * f * 0.6;
      b.vy -= dy * f * 0.6;
    }
    const cap = 40 * t + 2;
    for (const p of list) {
      p.vx -= p.x * 0.02; // тяга к центру, чтобы одиночки не улетали
      p.vy -= p.y * 0.02;
      if (!p.fixed) {
        const v = Math.sqrt(p.vx * p.vx + p.vy * p.vy) || 1;
        p.x += (p.vx / v) * Math.min(v, cap);
        p.y += (p.vy / v) * Math.min(v, cap);
      }
      p.vx = 0;
      p.vy = 0;
    }
  }
  separate(list);
  const out = new Map();
  for (const [id, p] of pos) out.set(id, { x: Math.round(p.x), y: Math.round(p.y) });
  return out;
}

// separate — силы держат узлы порознь лишь в среднем; карточки, налезшие
// друг на друга, раздвигаем по оси наименьшего перекрытия. Размер узла — w/h,
// если задан (карточки доски шире), иначе экранный.
function separate(list) {
  for (let pass = 0; pass < 60; pass++) {
    let moved = false;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const gx = ((a.w || NODE_W) + (b.w || NODE_W)) / 2 + 28;
        const gy = ((a.h || NODE_H) + (b.h || NODE_H)) / 2 + 26;
        const ox = gx - Math.abs(a.x - b.x);
        const oy = gy - Math.abs(a.y - b.y);
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        const wa = a.fixed ? 0 : b.fixed ? 1 : 0.5;
        const wb = 1 - wa;
        if (ox < oy * (gx / gy)) {
          const d = (a.x < b.x || (a.x === b.x && i < j) ? -1 : 1) * ox;
          a.x += d * wa;
          b.x -= d * wb;
        } else {
          const d = (a.y < b.y || (a.y === b.y && i < j) ? -1 : 1) * oy;
          a.y += d * wa;
          b.y -= d * wb;
        }
      }
    }
    if (!moved) break;
  }
}

function loadFixed() {
  try {
    return new Map(Object.entries(JSON.parse(localStorage.getItem(POS_KEY) || "{}")));
  } catch {
    return new Map();
  }
}

function saveFixed(map) {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(Object.fromEntries(map)));
  } catch {
    // без localStorage раскладка просто не запомнится
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// mountJournalGraph — граф в root. onOpen(id) — «Открыть запись»;
// onBoard(graph, positions) — «Разложить на доску»; members — для ДМ
// («как видит игрок»). compact — ячейка ширмы: без фильтров и карточки.
export function mountJournalGraph(root, { isDM = false, members = [], onOpen, onBoard, compact = false } = {}) {
  root.classList.add("jg");
  root.classList.toggle("jg-compact", compact);
  root.innerHTML = "";

  const bar = el("div", "jg-bar");
  const chips = el("div", "jg-chips");
  const tagSel = el("select", "jg-tag");
  tagSel.title = "Только записи с меткой";
  const orphansBtn = el("button", "filter-chip", "Без связей");
  orphansBtn.type = "button";
  orphansBtn.title = "Показать записи, у которых нет ни одной связи";
  const asSel = el("select", "jg-as");
  asSel.title = "Как граф видит игрок: только связи между записями, которые он может прочитать";
  bar.append(chips, tagSel, orphansBtn);
  if (isDM) bar.append(asSel);

  const view = el("div", "jg-view");
  const world = el("div", "jg-world");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("jg-edges");
  world.append(svg);
  view.append(world);
  const legend = el("div", "jg-legend");
  for (const [type, { color }] of Object.entries(RELATION_TYPES)) {
    const it = el("span", "", type);
    const sw = el("i");
    sw.style.background = color;
    it.prepend(sw);
    legend.append(it);
  }
  const linkIt = el("span", "", "просто ссылка");
  linkIt.prepend(el("i", "jg-dash"));
  legend.append(linkIt);
  const emptyEl = el("div", "jg-empty");
  const fitBtn = el("button", "jg-fit");
  fitBtn.type = "button";
  fitBtn.title = "Показать весь граф";
  fitBtn.innerHTML = icon("expand", { size: 15 });
  view.append(legend, emptyEl, fitBtn);

  const card = el("aside", "jg-card");
  const body = el("div", "jg-body");
  body.append(view);
  if (!compact) body.append(card);
  root.append(bar, body);

  let graph = { nodes: [], edges: [] };
  let pos = new Map();
  let fixed = loadFixed();
  let folder = "";
  let tag = "";
  let showOrphans = false;
  let as = "";
  let selected = "";
  let cam = { x: 0, y: 0, s: 1 };
  let fitted = false;
  // userCam — камеру двигали руками: подгонять под размер больше не надо.
  let userCam = false;
  const nodeEls = new Map();
  let shown = { nodes: [], edges: [] };

  // ---- данные ----

  async function refresh() {
    try {
      graph = await fetchJournalGraph({ as });
    } catch (err) {
      graph = { nodes: [], edges: [] };
      emptyEl.textContent = "Не удалось загрузить граф: " + err.message;
    }
    graph.edges = mergeMutual(graph.edges || []);
    if (selected && !graph.nodes.some((n) => n.id === selected)) selected = "";
    setFolderOrder(graph.nodes);
    pos = layoutGraph(graph.nodes, graph.edges, fixed);
    renderFilters();
    render();
  }

  function filtered() {
    const degree = new Map();
    for (const e of graph.edges) {
      degree.set(e.from, (degree.get(e.from) || 0) + 1);
      degree.set(e.to, (degree.get(e.to) || 0) + 1);
    }
    const anyEdges = graph.edges.length > 0;
    const nodes = graph.nodes.filter(
      (n) =>
        (!folder || topFolder(n.folder) === folder) &&
        (!tag || (n.tags || []).includes(tag)) &&
        (showOrphans || !anyEdges || degree.has(n.id) || n.id === selected)
    );
    const ids = new Set(nodes.map((n) => n.id));
    return { nodes, edges: graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
  }

  function renderFilters() {
    chips.replaceChildren();
    const folders = [...new Set(graph.nodes.map((n) => topFolder(n.folder)).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ru"));
    if (folder && !folders.includes(folder)) folder = "";
    for (const f of ["", ...folders]) {
      const b = el("button", "filter-chip" + (f === folder ? " active" : ""), f || "Все");
      b.type = "button";
      b.setAttribute("aria-pressed", String(f === folder));
      if (f) {
        const dot = el("i", "jg-dot");
        dot.style.background = folderColor(f)[1];
        b.prepend(dot);
      }
      b.onclick = () => {
        folder = f;
        renderFilters();
        render({ refit: true });
      };
      chips.append(b);
    }
    const tags = [...new Set(graph.nodes.flatMap((n) => n.tags || []))].sort((a, b) => a.localeCompare(b, "ru"));
    if (tag && !tags.includes(tag)) tag = "";
    tagSel.replaceChildren(new Option("Все метки", ""), ...tags.map((t) => new Option("#" + t, t)));
    tagSel.value = tag;
    tagSel.style.display = tags.length ? "" : "none";
    orphansBtn.classList.toggle("active", showOrphans);
    orphansBtn.setAttribute("aria-pressed", String(showOrphans));
    if (isDM && !asSel.options.length) {
      asSel.append(new Option("Ведущий", ""));
      for (const m of members.filter((m) => !m.gm)) asSel.append(new Option("Как видит " + m.username, m.id));
      asSel.style.display = asSel.options.length > 1 ? "" : "none";
    }
  }

  tagSel.onchange = () => {
    tag = tagSel.value;
    render({ refit: true });
  };
  orphansBtn.onclick = () => {
    showOrphans = !showOrphans;
    renderFilters();
    render({ refit: true });
  };
  asSel.onchange = () => {
    as = asSel.value;
    fitted = false;
    refresh();
  };

  // ---- отрисовка ----

  function render({ refit = false } = {}) {
    shown = filtered();
    nodeEls.clear();
    world.querySelectorAll(".jg-node").forEach((n) => n.remove());
    for (const n of shown.nodes) {
      const b = el("button", "jg-node");
      b.type = "button";
      b.dataset.id = n.id;
      const [bg, fg] = folderColor(topFolder(n.folder));
      const dot = el("span", "jg-node-dot", (topFolder(n.folder) || "·").slice(0, 1).toUpperCase());
      dot.style.background = bg;
      dot.style.color = fg;
      b.append(dot, el("span", "jg-node-title", n.title || "Без названия"));
      b.title = (n.folder ? n.folder + " / " : "") + (n.title || "");
      wireNode(b, n.id);
      world.append(b);
      nodeEls.set(n.id, b);
    }
    if (graph.nodes.length === 0) {
      emptyEl.textContent = as ? "Этот игрок не может прочитать ни одной записи." : "В журнале пока нет записей.";
    } else if (!graph.edges.length) {
      emptyEl.textContent = "Связей пока нет: добавь в записи [[ссылки]] или блок связей (кнопка на панели редактора).";
    } else if (!shown.nodes.length) {
      emptyEl.textContent = "Под фильтр ничего не попало.";
    } else {
      emptyEl.textContent = "";
    }
    emptyEl.style.display = emptyEl.textContent ? "" : "none";
    place();
    if (refit || !fitted) fit();
    renderCard();
  }

  function place() {
    for (const [id, b] of nodeEls) {
      const p = pos.get(id);
      b.style.transform = `translate(${p.x - NODE_W / 2}px, ${p.y - NODE_H / 2}px)`;
    }
    drawEdges();
    highlight();
  }

  function drawEdges() {
    svg.replaceChildren();
    for (const e of shown.edges) {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (!a || !b) continue;
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", a.x);
      line.setAttribute("y1", a.y);
      line.setAttribute("x2", b.x);
      line.setAttribute("y2", b.y);
      line.setAttribute("stroke", relationColor(e.type));
      line.setAttribute("stroke-width", e.type ? "2.5" : "1.5");
      if (!e.type) line.setAttribute("stroke-dasharray", "5 6");
      line.dataset.from = e.from;
      line.dataset.to = e.to;
      svg.append(line);
    }
  }

  function highlight() {
    const near = new Set(selected ? [selected] : []);
    if (selected) {
      for (const e of shown.edges) {
        if (e.from === selected) near.add(e.to);
        if (e.to === selected) near.add(e.from);
      }
    }
    for (const [id, b] of nodeEls) {
      b.classList.toggle("sel", id === selected);
      b.setAttribute("aria-pressed", String(id === selected));
      b.classList.toggle("fade", !!selected && !near.has(id));
    }
    for (const line of svg.children) {
      const on = !selected || line.dataset.from === selected || line.dataset.to === selected;
      line.style.opacity = on ? "" : ".18";
    }
  }

  function applyCam() {
    world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.s})`;
  }

  function fit() {
    const w = view.clientWidth;
    const h = view.clientHeight;
    if (!w || !h) return;
    const pts = shown.nodes.map((n) => pos.get(n.id)).filter(Boolean);
    if (!pts.length) {
      cam = { x: w / 2, y: h / 2, s: 1 };
      applyCam();
      return; // узлы ещё не пришли — впишем, когда придут
    } else {
      const minX = Math.min(...pts.map((p) => p.x)) - NODE_W / 2 - 20;
      const maxX = Math.max(...pts.map((p) => p.x)) + NODE_W / 2 + 20;
      const minY = Math.min(...pts.map((p) => p.y)) - NODE_H / 2 - 20;
      const maxY = Math.max(...pts.map((p) => p.y)) + NODE_H / 2 + 60;
      const s = Math.min(1.2, w / (maxX - minX), h / (maxY - minY));
      cam = { s, x: w / 2 - ((minX + maxX) / 2) * s, y: h / 2 - ((minY + maxY) / 2) * s };
    }
    fitted = true;
    applyCam();
  }
  fitBtn.onclick = () => {
    userCam = false;
    fit();
  };

  // ---- карточка выбранной записи ----

  function renderCard() {
    card.replaceChildren();
    const n = graph.nodes.find((x) => x.id === selected);
    if (!n) {
      card.append(el("div", "jg-card-hint", "Выбери запись на графе — здесь появятся её связи."));
      if (as) card.append(el("div", "jg-note", "Игрок видит связь, только если может прочитать обе записи и ту, где связь объявлена."));
      card.append(el("div", "jg-spacer"));
      if (onBoard && shown.nodes.length) card.append(boardButton());
      return;
    }
    const where = [topFolder(n.folder) || "Без папки", n.shared ? "видят все" : "видят не все"].join(" · ");
    card.append(el("div", "jg-card-meta", where), el("div", "jg-card-title", n.title || "Без названия"));
    const byId = new Map(graph.nodes.map((x) => [x.id, x]));
    const rows = graph.edges
      .filter((e) => e.from === n.id || e.to === n.id)
      .sort((a, b) => (a.type ? 0 : 1) - (b.type ? 0 : 1));
    const list = el("div", "jg-rels");
    for (const e of rows) {
      const other = byId.get(e.from === n.id ? e.to : e.from);
      if (!other) continue;
      const row = el("button", "jg-rel");
      row.type = "button";
      const sw = el("i", e.type ? "" : "jg-dash");
      if (e.type) sw.style.background = relationColor(e.type);
      const text = el("span", "", relationLabel(e.type, e.from === n.id) + ": ");
      text.append(el("b", "", other.title || "Без названия"));
      row.append(sw, text);
      if (e.secret) {
        const lock = el("span", "jg-lock", "ведущий");
        lock.title = `Объявлена в «${byId.get(e.from)?.title || ""}» — игроки этой записи не читают, и связи не видят`;
        row.append(lock);
      }
      row.onclick = () => select(other.id, { center: true });
      list.append(row);
    }
    if (!rows.length) list.append(el("div", "jg-card-hint", "Связей нет."));
    card.append(list);
    const secret = rows.find((e) => e.secret && e.type);
    if (secret) {
      const decl = byId.get(secret.from);
      const target = byId.get(secret.to);
      card.append(
        el(
          "div",
          "jg-note jg-note-gm",
          decl && !decl.shared
            ? `Связь «${secret.type}» объявлена в записи «${decl.title}» — она закрыта для игроков, поэтому связи они не видят.`
            : `Запись «${target?.title || ""}» закрыта для игроков, поэтому связь «${secret.type}» им не видна.`
        )
      );
    }
    if (as) card.append(el("div", "jg-note", "Игрок видит связь, только если может прочитать обе записи и ту, где связь объявлена."));
    card.append(el("div", "jg-spacer"));
    if (onOpen) {
      const open = el("button", "jg-btn", "Открыть запись");
      open.type = "button";
      open.onclick = () => onOpen(n.id);
      card.append(open);
    }
    if (onBoard) card.append(boardButton());
  }

  function boardButton() {
    const b = el("button", "jg-btn", "Разложить на доску");
    b.type = "button";
    b.title = "Снимок графа (что видно сейчас) — на новую доску, чтобы рисовать поверх";
    b.onclick = () => onBoard({ nodes: shown.nodes, edges: shown.edges }, pos);
    return b;
  }

  function select(id, { center = false } = {}) {
    selected = id;
    if (id && !nodeEls.has(id)) {
      render();
    } else {
      highlight();
      renderCard();
    }
    if (center && id && pos.get(id)) {
      const p = pos.get(id);
      cam.x = view.clientWidth / 2 - p.x * cam.s;
      cam.y = view.clientHeight / 2 - p.y * cam.s;
      applyCam();
    }
  }

  // ---- мышь: узлы таскаются, фон двигает, колесо масштабирует ----

  function wireNode(b, id) {
    b.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      ev.stopPropagation();
      const start = { x: ev.clientX, y: ev.clientY };
      const p0 = { ...pos.get(id) };
      let moved = false;
      b.setPointerCapture(ev.pointerId);
      const move = (e) => {
        const dx = (e.clientX - start.x) / cam.s;
        const dy = (e.clientY - start.y) / cam.s;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        moved = true;
        pos.set(id, { x: Math.round(p0.x + dx), y: Math.round(p0.y + dy) });
        place();
      };
      const up = () => {
        b.removeEventListener("pointermove", move);
        b.removeEventListener("pointerup", up);
        b.removeEventListener("pointercancel", up);
        if (moved) {
          fixed.set(id, pos.get(id));
          saveFixed(fixed);
        } else if (compact && onOpen) {
          onOpen(id);
        } else {
          select(selected === id ? "" : id);
        }
      };
      b.addEventListener("pointermove", move);
      b.addEventListener("pointerup", up);
      b.addEventListener("pointercancel", up);
    });
    b.addEventListener("dblclick", () => onOpen && onOpen(id));
    b.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && onOpen && selected === id) onOpen(id);
    });
  }

  view.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || ev.target.closest("button, .jg-legend")) return;
    const start = { x: ev.clientX - cam.x, y: ev.clientY - cam.y };
    const origin = { x: ev.clientX, y: ev.clientY };
    view.setPointerCapture(ev.pointerId);
    view.classList.add("panning");
    const move = (e) => {
      cam.x = e.clientX - start.x;
      cam.y = e.clientY - start.y;
      userCam = true;
      applyCam();
    };
    const up = (e) => {
      view.classList.remove("panning");
      view.removeEventListener("pointermove", move);
      view.removeEventListener("pointerup", up);
      if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) < 4 && selected) select("");
    };
    view.addEventListener("pointermove", move);
    view.addEventListener("pointerup", up);
  });

  view.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      const r = view.getBoundingClientRect();
      const mx = ev.clientX - r.left;
      const my = ev.clientY - r.top;
      const s = Math.min(2.5, Math.max(0.15, cam.s * Math.exp(-ev.deltaY * 0.0015)));
      cam.x = mx - ((mx - cam.x) * s) / cam.s;
      cam.y = my - ((my - cam.y) * s) / cam.s;
      cam.s = s;
      userCam = true;
      applyCam();
    },
    { passive: false }
  );

  const ro = new ResizeObserver(() => {
    if (!fitted || !userCam) fit();
  });
  ro.observe(view);

  // Сброс раскладки: забыть, что двигали руками.
  fitBtn.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    fixed = new Map();
    saveFixed(fixed);
    pos = layoutGraph(graph.nodes, graph.edges, fixed);
    place();
    fit();
  });

  return {
    refresh,
    select: (id) => select(id, { center: true }),
    destroy() {
      ro.disconnect();
      root.replaceChildren();
    },
  };
}

// boardScene — граф как сцена Excalidraw: карточки со ссылкой [[Название]]
// (по ней доска открывает запись, см. board/links.js) и стрелки цвета связи.
// Цвета — из палитры самого Excalidraw: тёмную тему доска делает инверсией.
const BOARD_FILLS = ["#d0bfff", "#b2f2bb", "#ffc9c9", "#a5d8ff", "#ffec99", "#99e9f2", "#eebefa", "#e9ecef"];
const BOARD_STROKES = { союзник: "#2f9e44", враг: "#e03131", семья: "#9c36b5", подчинённый: "#1971c2" };

// Карточка доски по длине названия: шире до BOARD_MAX_W, дальше перенос по
// словам. Шрифт — как у текста доски (fontFamily 2, 16 px); в тестах canvas
// нет — тогда оценка по числу букв.
const BOARD_MAX_W = 320;
let measureCtx;
function textWidth(s) {
  if (measureCtx === undefined) {
    measureCtx = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
    if (measureCtx) measureCtx.font = "16px Helvetica, Arial, sans-serif";
  }
  return measureCtx ? measureCtx.measureText(s).width : Array.from(s).length * 9;
}

function nodeBox(title) {
  const lines = [];
  let line = "";
  for (const word of String(title || "").split(/\s+/).filter(Boolean)) {
    const next = line ? line + " " + word : word;
    if (line && textWidth(next) > BOARD_MAX_W - 24) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  lines.push(line);
  const widest = Math.max(...lines.map(textWidth));
  return { lines, w: Math.min(BOARD_MAX_W, Math.max(NODE_W, Math.ceil(widest) + 24)), h: Math.max(NODE_H, lines.length * 20 + 20) };
}

// edgePoint — где луч из центра прямоугольника в сторону (dx, dy) выходит за его край.
function edgePoint(cx, cy, w, h, dx, dy) {
  const t = Math.min(dx ? w / 2 / Math.abs(dx) : Infinity, dy ? h / 2 / Math.abs(dy) : Infinity);
  return [cx + dx * t, cy + dy * t];
}

export function boardScene(graph, positions) {
  const elements = [];
  const now = Date.now();
  let seed = 1;
  const base = () => ({
    angle: 0,
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: seed++,
    version: 1,
    versionNonce: seed * 7919,
    isDeleted: false,
    updated: now,
    locked: false,
    link: null,
    fillStyle: "solid",
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    boundElements: null,
  });
  const text = (id, x, y, w, value, extra = {}) => ({
    ...base(),
    id,
    type: "text",
    x,
    y,
    width: w,
    height: 20,
    text: value,
    originalText: value,
    fontSize: 16,
    fontFamily: 2,
    textAlign: "left",
    verticalAlign: "top",
    containerId: null,
    lineHeight: 1.25,
    autoResize: true,
    ...extra,
  });
  // Карточки на доске шире экранных — раздвигаем их заново под свой размер.
  const boxes = [];
  for (const n of graph.nodes) {
    const p = positions.get(n.id);
    if (p) boxes.push({ node: n, x: p.x, y: p.y, ...nodeBox(n.title) });
  }
  separate(boxes);
  // Доска открывается в начале координат — граф сдвигаем туда.
  const minX = boxes.length ? Math.min(...boxes.map((b) => b.x - b.w / 2)) : 0;
  const minY = boxes.length ? Math.min(...boxes.map((b) => b.y - b.h / 2)) : 0;
  const dx = 40 - minX;
  const dy = 90 - minY;
  const folders = [...new Set(graph.nodes.map((n) => topFolder(n.folder)).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ru"));
  const legend = Object.keys(BOARD_STROKES).join(", ");
  const legendText = `Граф связей: цвет стрелки — тип связи (${legend}), пунктир — просто ссылка`;
  elements.push(text("legend", 40, 30, Math.ceil((textWidth(legendText) * 14) / 16) + 16, legendText, { fontSize: 14 }));

  const rectOf = new Map();
  for (const { node: n, x, y, w, h, lines } of boxes) {
    const id = "n" + hash(n.id).toString(36);
    const textId = id + "t";
    const f = folders.indexOf(topFolder(n.folder));
    const rect = {
      ...base(),
      id,
      type: "rectangle",
      x: x + dx - w / 2,
      y: y + dy - h / 2,
      width: w,
      height: h,
      backgroundColor: BOARD_FILLS[f < 0 ? BOARD_FILLS.length - 1 : f % (BOARD_FILLS.length - 1)],
      roundness: { type: 3 },
      boundElements: [{ type: "text", id: textId }],
      link: "[[" + n.title + "]]",
    };
    rectOf.set(n.id, rect);
    elements.push(
      rect,
      text(textId, rect.x + 8, rect.y + (h - lines.length * 20) / 2, w - 16, lines.join("\n"), {
        originalText: n.title,
        height: lines.length * 20,
        textAlign: "center",
        verticalAlign: "middle",
        containerId: id,
      })
    );
  }
  for (const e of graph.edges) {
    const a = rectOf.get(e.from);
    const b = rectOf.get(e.to);
    if (!a || !b) continue;
    // Стрелка — от края до края с зазором привязки, а не из центра в центр:
    // иначе наконечник ложится на подпись.
    const ax = a.x + a.width / 2;
    const ay = a.y + a.height / 2;
    const bx = b.x + b.width / 2;
    const by = b.y + b.height / 2;
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const gx = ((bx - ax) / len) * 4;
    const gy = ((by - ay) / len) * 4;
    const [sx, sy] = edgePoint(ax, ay, a.width, a.height, bx - ax, by - ay);
    const [ex, ey] = edgePoint(bx, by, b.width, b.height, ax - bx, ay - by);
    const x1 = sx + gx;
    const y1 = sy + gy;
    const x2 = ex - gx;
    const y2 = ey - gy;
    const id = "e" + seed;
    elements.push({
      ...base(),
      id,
      type: "arrow",
      x: x1,
      y: y1,
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
      strokeColor: e.type ? BOARD_STROKES[e.type] || "#f08c00" : "#868e96",
      strokeStyle: e.type ? "solid" : "dashed",
      points: [
        [0, 0],
        [x2 - x1, y2 - y1],
      ],
      startBinding: { elementId: a.id, focus: 0, gap: 4 },
      endBinding: { elementId: b.id, focus: 0, gap: 4 },
      startArrowhead: null,
      endArrowhead: e.type ? "arrow" : null,
      lastCommittedPoint: null,
    });
    a.boundElements.push({ type: "arrow", id });
    b.boundElements.push({ type: "arrow", id });
  }
  return {
    type: "excalidraw",
    version: 2,
    source: "beacon-table",
    elements,
    appState: { viewBackgroundColor: "#ffffff", gridSize: null },
    files: {},
  };
}
