// modules.js — витрина модулей (modules.html): каталог из интернета и уже
// установленное. Пока человек смотрит, на сервер ничего не скачивается, кроме
// индекса и сводок; архив качается только по кнопке «Установить».
import {
  fetchMe,
  fetchModules,
  fetchModuleCatalog,
  fetchModuleSummary,
  fetchModuleSources,
  setModuleSources,
  installCatalogModule,
  installModuleFile,
  installModuleURL,
  deleteModule,
} from "../api.js";
import { el as h } from "../card-shell.js";
import { openModal, showConfirm } from "../modal.js";
import { SECTION_LABEL, SOURCE_LABEL, TYPE_LABEL, canInstall, canRemove, filterModules, formatSize, marks, mergeModules } from "../modules-view.js";

const params = new URLSearchParams(location.search);
const state = { tab: "available", kind: params.get("type") === "system" ? "system" : "all", query: "", selected: params.get("module") || "" };
let items = [];
let catalogSources = [];
let appVersion = "";
let busy = false;
const summaries = new Map();

const listEl = document.getElementById("list");
const detailEl = document.getElementById("detail");
const statusEl = document.getElementById("status");
const fileInput = document.getElementById("fileInput");

function setStatus(text, kind) {
  statusEl.textContent = text || "";
  statusEl.className = "msg" + (kind ? " " + kind : "");
}

function setBusy(on) {
  busy = on;
  for (const b of document.querySelectorAll("#toolActions button, .act")) b.disabled = on;
}

async function load(refresh, keepStatus) {
  const [cat, mods] = await Promise.all([fetchModuleCatalog(refresh).catch((err) => ({ entries: [], sources: [], error: err.message })), fetchModules()]);
  items = mergeModules(cat.entries || [], mods.modules || []);
  catalogSources = cat.sources || [];
  appVersion = cat.appVersion || "";
  const failed = catalogSources.filter((s) => s.error);
  if (cat.error) setStatus("Каталог недоступен: " + cat.error + " — «Из файла» работает без интернета.", "error");
  else if (failed.length) setStatus(`Каталог недоступен: ${failed.map((s) => s.error).join("; ")}`, "error");
  else if (!keepStatus) setStatus("");
  render();
}

function render() {
  for (const b of document.querySelectorAll("#tabs button")) b.classList.toggle("on", b.dataset.tab === state.tab);
  for (const b of document.querySelectorAll("#kinds button")) b.classList.toggle("on", b.dataset.kind === state.kind);
  const shown = filterModules(items, state);
  listEl.replaceChildren();
  if (!shown.length) {
    const none = state.tab === "installed" ? "Установленных модулей нет." : "В каталоге ничего не нашлось.";
    listEl.appendChild(h("div", { id: "empty", text: none }));
  }
  for (const i of shown) listEl.appendChild(row(i));
  const sel = items.find((i) => i.id === state.selected);
  renderDetail(sel);
}

function row(i) {
  const meta = [h("span", { class: "pill", text: TYPE_LABEL[i.type] || i.type }), h("span", { text: "v" + i.version })];
  if (i.size) meta.push(h("span", { text: formatSize(i.size) }));
  for (const m of marks(i)) meta.push(h("span", { class: "pill " + m.kind, text: m.text }));
  return h(
    "button",
    {
      type: "button",
      class: "mod-row" + (i.id === state.selected ? " sel" : ""),
      onclick: () => {
        state.selected = i.id;
        render();
        if (window.matchMedia("(max-width: 860px)").matches) detailEl.scrollIntoView({ behavior: "smooth", block: "start" });
      },
    },
    [h("span", { class: "mod-name", text: i.title }), h("span", { class: "mod-meta" }, meta)],
  );
}

function renderDetail(i) {
  detailEl.replaceChildren();
  if (!i) {
    detailEl.appendChild(h("p", { class: "hint", text: "Выберите модуль в списке." }));
    return;
  }
  const meta = [h("span", { class: "pill", text: TYPE_LABEL[i.type] || i.type }), h("span", { class: "pill", text: "v" + i.version })];
  if (i.size) meta.push(h("span", { class: "pill", text: formatSize(i.size) }));
  if (i.source && SOURCE_LABEL[i.source] && i.source !== "installed") meta.push(h("span", { class: "pill", text: SOURCE_LABEL[i.source] }));
  for (const m of marks(i)) meta.push(h("span", { class: "pill " + m.kind, text: m.text }));
  detailEl.append(h("h2", { text: i.title }), h("div", { class: "detail-meta" }, meta));
  if (i.description) detailEl.appendChild(h("p", { class: "detail-desc", text: i.description }));
  const facts = [i.author && "Автор: " + i.author, i.license && "Лицензия: " + i.license, i.installedVersion && "Установлена версия " + i.installedVersion].filter(Boolean);
  if (facts.length) detailEl.appendChild(h("p", { class: "hint", text: facts.join(" · ") }));
  if (!i.compatible) detailEl.appendChild(h("p", { class: "hint", text: `Нужна программа не ниже ${i.minAppVersion}, сейчас ${appVersion || "старше"} — обновите Beacon Table.` }));

  if (i.systems.length && i.type === "content") {
    detailEl.append(h("h3", { text: "Для систем" }), h("p", { class: "detail-desc", text: i.systems.map(systemTitle).join(", ") }));
  }
  if (i.requires.length) {
    detailEl.append(h("h3", { text: "Зависимости" }), h("ul", { class: "list-plain" }, i.requires.map((d) => h("li", { text: systemTitle(d.id) + (d.minVersion ? ` (не ниже ${d.minVersion})` : "") }))));
  }

  const inside = h("div", {});
  detailEl.append(h("h3", { text: "Что внутри" }), inside);
  renderInside(i, inside);

  const actions = h("div", { class: "detail-actions" });
  if (canInstall(i)) actions.appendChild(h("button", { type: "button", class: "act", text: i.installedVersion ? "Обновить до " + i.version : "Установить", onclick: () => install(i), disabled: busy || null }));
  if (canRemove(i)) actions.appendChild(h("button", { type: "button", class: "act alt", text: "Удалить", onclick: () => remove(i), disabled: busy || null }));
  detailEl.appendChild(actions);
  if (i.installedVersion && i.type === "system") {
    detailEl.appendChild(h("p", { class: "hint", text: "Систему выбирают при создании мира или в настройках мира: «Настройки → Модули»." }));
  }
}

function systemTitle(id) {
  const m = items.find((x) => x.id === id);
  return m ? m.title : id;
}

function renderInside(i, box) {
  if (!i.inCatalog) {
    box.appendChild(sections(i.counts, null));
    return;
  }
  const key = `${i.id}@${i.version}`;
  const cached = summaries.get(key);
  if (cached) {
    box.appendChild(sections(cached.counts, cached.names));
    if (cached.theme) box.append(h("h3", { text: "Оформление" }), swatches(cached.theme));
    if (i.updatable && cached.changelog) box.append(h("h3", { text: "Что нового" }), h("p", { class: "detail-desc", text: cached.changelog }));
    return;
  }
  box.appendChild(h("p", { class: "hint", text: "Загружаю состав…" }));
  fetchModuleSummary(i.id)
    .then((s) => {
      summaries.set(key, s);
      if (state.selected === i.id) renderDetail(items.find((x) => x.id === i.id));
    })
    .catch((err) => {
      if (state.selected !== i.id) return;
      box.replaceChildren(h("p", { class: "hint", text: "Состав не загрузился: " + err.message }));
    });
}

const SWATCH_LABEL = { bg: "фон", surface: "панель", accent: "акцент", gold: "золото", text: "текст" };

// swatches — цвета оформления системы (summary.theme).
function swatches(colors) {
  return h(
    "div",
    { class: "swatches" },
    Object.keys(SWATCH_LABEL)
      .filter((k) => colors[k])
      .map((k) => h("span", { class: "sw", title: `${SWATCH_LABEL[k]} ${colors[k]}` }, [h("i", { style: `background:${colors[k]}` }), SWATCH_LABEL[k]])),
  );
}

// sections — разделы со счётчиками; список имён строится при раскрытии.
function sections(counts, names) {
  const keys = Object.keys(counts || {}).filter((k) => counts[k] > 0);
  if (!keys.length) return h("p", { class: "hint", text: "Карточек в модуле нет — он даёт систему: лист, правила и оформление." });
  return h(
    "div",
    {},
    keys.map((k) => {
      const d = h("details", { class: "sec" }, [h("summary", {}, [SECTION_LABEL[k] || k, h("span", { text: String(counts[k]) })])]);
      if (names && names[k]) {
        d.addEventListener("toggle", () => {
          if (d.open && !d.querySelector("ul")) d.appendChild(h("ul", { class: "names" }, names[k].map((n) => h("li", { text: n }))));
        });
      }
      return d;
    }),
  );
}

async function run(label, fn) {
  setBusy(true);
  setStatus(label);
  try {
    const done = await fn();
    if (done) setStatus(done, "ok");
    else setStatus("");
  } catch (err) {
    setStatus(err.message, "error");
  } finally {
    setBusy(false);
    await load(false, true).catch((err) => setStatus(err.message, "error"));
  }
}

async function install(i) {
  await run(`Устанавливаю «${i.title}»…`, async () => {
    let res = await installCatalogModule(i.id, false);
    if (res.requires) {
      const names = res.requires.map((r) => `«${r.title}» (${formatSize(r.size)})`).join(", ");
      const ok = await showConfirm(`Для «${i.title}» нужны ещё модули: ${names}. Установить вместе с ними?`, { title: "Зависимости", okLabel: "Установить всё" });
      if (!ok) return "";
      res = await installCatalogModule(i.id, true);
    }
    return "Установлено: " + res.installed.map((m) => m.title).join(", ");
  });
}

async function remove(i) {
  const ok = await showConfirm(`Удалить «${i.title}» с сервера? Миры, где он включён, покажут его как ненайденный; вернуть можно, поставив модуль снова. Карточки, уже склонированные в мир, останутся.`, { title: "Удалить модуль", okLabel: "Удалить", danger: true });
  if (!ok) return;
  await run("Удаляю…", async () => {
    await deleteModule(i.id);
    return `«${i.title}» удалён`;
  });
}

document.getElementById("fileBtn").onclick = () => fileInput.click();
fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  fileInput.value = "";
  if (!file) return;
  await run("Устанавливаю из файла…", async () => {
    const m = await installModuleFile(file);
    state.selected = m.id;
    return `Установлено: ${m.title}`;
  });
});

document.getElementById("urlBtn").onclick = async () => {
  const input = await askURL();
  if (!input) return;
  await run("Скачиваю и устанавливаю…", async () => {
    const m = await installModuleURL(input.url, input.sha256);
    state.selected = m.id;
    return `Установлено: ${m.title}`;
  });
};

function askURL() {
  let url, sha;
  return openModal({
    title: "Модуль по ссылке",
    okLabel: "Установить",
    cancelLabel: "Отмена",
    buildBody: (body) => {
      url = h("input", { type: "url", class: "modal-input", placeholder: "https://…/модуль.btmod", "aria-label": "Ссылка на модуль" });
      sha = h("input", { type: "text", class: "modal-input", placeholder: "необязательно", "aria-label": "Контрольная сумма sha256", spellcheck: "false" });
      body.append(
        h("p", { class: "bt-modal-text dim", text: "Модуль не из каталога: он будет работать у всех игроков стола. Ставьте только то, чему доверяете. Если автор указал контрольную сумму sha256 — вставьте её, архив сверится." }),
        url,
        h("span", { class: "field-label", text: "Контрольная сумма sha256" }),
        sha,
      );
      return url;
    },
    onOk: () => (url.value.trim() ? { url: url.value.trim(), sha256: sha.value.trim() } : null),
    onCancel: () => null,
  });
}

document.getElementById("sourcesBtn").onclick = async () => {
  let data;
  try {
    data = await fetchModuleSources();
  } catch (err) {
    setStatus(err.message, "error");
    return;
  }
  const lines = await askSources(data);
  if (!lines) return;
  await run("Сохраняю каталоги…", async () => {
    await setModuleSources(lines);
    return "Каталоги сохранены";
  });
};

function askSources(data) {
  let area;
  return openModal({
    title: "Каталоги модулей",
    okLabel: "Сохранить",
    cancelLabel: "Отмена",
    buildBody: (body) => {
      for (const s of data.sources) {
        body.appendChild(h("p", { class: "src-row" }, [s.default ? "Основной: " : "", s.url, s.error ? h("span", { class: "err", text: s.error }) : h("span", { class: "hint", text: ` — модулей: ${s.count}` })]));
      }
      area = h("textarea", { class: "bt-modal-textarea", placeholder: "Свой каталог — по адресу на строку (https://…/index.json)", rows: 4, "aria-label": "Свои каталоги" });
      area.value = (data.custom || []).join("\n");
      body.append(h("p", { class: "bt-modal-text dim", text: "Каталог — файл index.json со списком модулей. Добавляйте только каталоги, которым доверяете." }), area);
      return area;
    },
    onOk: () => area.value.split("\n").map((s) => s.trim()).filter(Boolean),
    onCancel: () => null,
  });
}

document.getElementById("refreshBtn").onclick = () => run("Обновляю каталог…", async () => {
  await load(true);
  return "";
});

for (const b of document.querySelectorAll("#tabs button")) {
  b.onclick = () => {
    state.tab = b.dataset.tab;
    render();
  };
}
for (const b of document.querySelectorAll("#kinds button")) {
  b.onclick = () => {
    state.kind = b.dataset.kind;
    render();
  };
}
document.getElementById("search").addEventListener("input", (e) => {
  state.query = e.target.value;
  render();
});

fetchMe().then(async (me) => {
  if (!me || me.role !== "admin") {
    location.href = "/";
    return;
  }
  try {
    await load(false);
  } catch (err) {
    setStatus(err.message, "error");
  }
});
