// Карточка состояния (ослепление/испуг/истощение или самодельная метка ДМ —
// см. domain.Condition) и одновременно КОНСТРУКТОР состояний: отдельное
// окно, открывается из компендиума (узел «Состояния», см. catalog.js) — по
// той же схеме, что referencebook.js/itembook.js/spellbook.js: тот же
// h()/textInput/mdBlock-конструктор, тот же debounce-автосейв, тот же
// read/edit-тумблер и «Клонировать» для карточек каталога «из коробки».
//
// Два разных блока, которые легко перепутать: статблок «что меняет» — то,
// что приложение реально применяет числами (см. internal/domain/modifier.go
// и stat-editor.js), «Правила» — то, что в числа не ложится
// (преимущество/помеха, автопровалы) и остаётся текстом для глаз ДМ.
// Правил приложение по-прежнему не знает: список изменений составляет
// человек или импорт (web/src/condition-import.js), а не вывод из описания.
import { fetchMe, fetchCondition, createCondition, updateCondition, deleteCondition, fetchConditions, uploadFile } from "../api.js";
import { mergeInPlace } from "../merge-in-place.js";
import { icon } from "../icons.js";
import { renderNoteHtml } from "../notes/markdown.js";
import { mapFoundryConditionBatch } from "../condition-import.js";
import { CONDITION_RU, conditionName } from "../foundry-conditions.js";
import { GLYPHS, glyphNode, glyphSVG, isGlyph } from "../condition-glyphs.js";
import { renderStatEditor, loadTargets } from "../stat-editor.js";
import { loadStand, renderStandSelect } from "../stand.js";
import { renderStatusPreview } from "../status-preview.js";
import { showAlert, showConfirm } from "../modal.js";
import { initFullscreenButton } from "../fullscreen.js";
import { el as h, labeled, pill, ornament, renderHero, fold, renderBody } from "../card-shell.js";
import { announceOwnHeader } from "../embed.js";

// ==================== state ====================

let conditionId = null;
let condition = null; // объект domain.Condition целиком (camelCase — см. json-теги)
let editMode = false;
// allConditions — весь список мира, нужен только для выбора зависимых
// состояний (Riders): их указывают slug'ами, а тыкать мышью удобнее по
// именам. Тянется один раз при открытии карточки.
let allConditions = [];
// standEntries — существа и персонажи для «примерить на» (см. stand.js).
let standEntries = [];

function normalizeCondition(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  c.tags = Array.isArray(c.tags) ? c.tags : [];
  c.riders = Array.isArray(c.riders) ? c.riders : [];
  c.modifiers = Array.isArray(c.modifiers) ? c.modifiers : [];
  return c;
}

// ==================== DOM helpers ====================

function textInput(get, set, opts) {
  const inp = h("input", Object.assign({ type: "text" }, opts || {}));
  inp.value = get() ?? "";
  inp.addEventListener("input", () => {
    set(inp.value);
    scheduleSave();
  });
  return inp;
}

function numberInput(get, set, opts) {
  const inp = h("input", Object.assign({ type: "number", min: "0" }, opts || {}));
  inp.value = get() ?? 0;
  inp.addEventListener("input", () => {
    const v = parseInt(inp.value, 10);
    set(Number.isNaN(v) ? 0 : v);
    scheduleSave();
  });
  return inp;
}

function checkboxInput(get, set) {
  const inp = h("input", { type: "checkbox" });
  inp.checked = !!get();
  inp.addEventListener("change", () => {
    set(inp.checked);
    scheduleSave();
  });
  return inp;
}

function mdBlock(labelText, get, set, opts) {
  const render = h("div", { class: "md-render" });
  render.innerHTML = renderNoteHtml(get());
  const t = h("textarea", opts || {});
  t.value = get() ?? "";
  t.addEventListener("input", () => {
    set(t.value);
    render.innerHTML = renderNoteHtml(t.value);
    scheduleSave();
  });
  t.setAttribute("aria-label", labelText);
  return h("div", { class: "md-block" }, [t, render]);
}

// durLabel — длительность метки словами; одно место для плашки в шапке,
// выжимки «Наложения» и предпросмотра, чтобы они не расходились.
function durLabel() {
  const n = condition.defaultRounds || 0;
  if (!n) return "бессрочно";
  const m10 = n % 10, m100 = n % 100;
  const word = m10 === 1 && m100 !== 11 ? "раунд" : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? "раунда" : "раундов";
  return n + " " + word;
}

function heroPills() {
  return [
    condition.source ? pill(condition.source, "gold") : null,
    ...condition.tags.map((t) => pill(t)),
    pill(durLabel(), "", icon("clock", { size: 12 })),
    condition.overlay ? pill("во весь токен") : null,
  ];
}

function applySummary() {
  const names = condition.riders.map((slug) => (allConditions.find((c) => c.slug === slug) || {}).name || slug);
  return [condition.levels > 1 ? condition.levels + " уровней" : "без уровней", durLabel(), condition.overlay ? "во весь токен" : null, names.length ? "вместе с: " + names.join(", ") : null]
    .filter(Boolean)
    .join(" · ");
}

// ==================== рендер ====================

function renderApp() {
  const root = document.getElementById("app");
  root.innerHTML = "";
  if (editMode) renderEditView(root);
  else renderReadView(root);
}

function renderEditView(root) {
  const upload = h("input", { type: "file", accept: "image/*", style: "display:none" });
  upload.addEventListener("change", async () => {
    const file = upload.files[0];
    if (!file) return;
    try {
      const { url } = await uploadFile(file, "tokens");
      condition.imageUrl = url;
      scheduleSave();
      hero.setGlyph(glyphNode(condition.icon, ""), condition.imageUrl);
      preview.update();
      artBtn.textContent = "Убрать арт";
    } catch (err) {
      showAlert("Не удалось загрузить значок: " + err.message);
    }
  });
  const artBtn = h("button", {
    type: "button",
    text: condition.imageUrl ? "Убрать арт" : "Загрузить свой…",
    onclick: () => {
      if (condition.imageUrl) {
        condition.imageUrl = "";
        scheduleSave();
        hero.setGlyph(glyphNode(condition.icon, ""), "");
        preview.update();
        artBtn.textContent = "Загрузить свой…";
      } else upload.click();
    },
  });

  const colorInput = h("input", { type: "color", value: condition.color || "#7c6cf0" });
  colorInput.addEventListener("input", () => {
    condition.color = colorInput.value;
    scheduleSave();
    hero.setColor(condition.color);
    preview.update();
  });

  // Кнопка «Значок» показывает текущий глиф и раскрывает набор ниже.
  const glyphBtn = h("button", { type: "button", class: "glyph-btn", "aria-label": "Выбрать значок" }, [glyphNode(condition.icon, ""), h("span", { html: icon("chevron-down", { size: 12 }), style: "display:inline-flex;color:var(--text-dim)" })]);
  glyphBtn.addEventListener("click", () => {
    glyphFold.open = true;
    glyphFold.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  const setIcon = (name) => {
    condition.icon = name;
    scheduleSave();
    hero.setGlyph(glyphNode(name, ""), condition.imageUrl);
    glyphBtn.replaceChild(glyphNode(name, ""), glyphBtn.firstChild);
    preview.update();
  };

  const hero = renderHero({
    glyph: glyphNode(condition.icon, ""),
    imageUrl: condition.imageUrl,
    color: condition.color,
    name: condition.name,
    namePlaceholder: "Название состояния",
    levels: condition.levels,
    pills: heroPills(),
    controls: [h("div", { class: "field" }, [h("span", { text: "Значок" }), glyphBtn]), labeled("Цвет", colorInput), h("div", { class: "field" }, [h("span", { text: "Арт" }), artBtn, upload])],
    onName: (v) => {
      condition.name = v;
      document.getElementById("condTitle").textContent = v || "Без имени";
      scheduleSave();
      preview.update();
    },
  });
  root.appendChild(hero.el);
  root.appendChild(ornament());

  // ---- изменения, которые приложение реально применяет ----
  const effects = h("div", {}, [
    condition.modifiers.length
      ? null
      : h("p", { class: "cond-empty-hint", html: "Впиши, что меняет состояние: <b>−2</b> в КД, <b>0</b> в скорость, <b>−1к6</b> в хиты в ход. Итог считается на выбранном существе." }),
    renderStatEditor(condition.modifiers, scheduleSave, { stand: renderStandSelect(standEntries), periodic: true }),
  ]);

  const mechanics = h("textarea", { placeholder: "Помеха на броски атаки; атаки по существу — с преимуществом", style: "min-height:60px;" });
  mechanics.value = condition.mechanics ?? "";
  mechanics.addEventListener("input", () => {
    condition.mechanics = mechanics.value;
    scheduleSave();
    rulesFold.setSummary(condition.mechanics || "помеха, преимущество, автопровалы — текстом");
  });
  const rulesFold = fold({
    title: "Правила",
    summary: condition.mechanics || "помеха, преимущество, автопровалы — текстом",
    body: [labeled("Что не ложится в цифры — текст для глаз ДМ, виден в палитре при ПКМ по значку", mechanics)],
  });

  const preview = renderStatusPreview(condition, { durLabel, ridersNames: () => condition.riders.map((slug) => (allConditions.find((c) => c.slug === slug) || {}).name || slug) });
  const refreshApply = () => {
    applyFold.setSummary(applySummary());
    hero.setPills(heroPills());
    hero.setLevels(condition.levels);
    preview.update();
  };
  const applyFold = fold({
    title: "Наложение",
    summary: applySummary(),
    body: [
      h("div", { class: "card-grid3" }, [
        labeled("Уровней", numberInput(() => condition.levels, (v) => { condition.levels = v; refreshApply(); }, { max: "20" }), "0 или 1 — обычный тумблер. Больше — многоуровневое, как истощение (6)."),
        labeled("Раундов по умолчанию", numberInput(() => condition.defaultRounds, (v) => { condition.defaultRounds = v; refreshApply(); }, { placeholder: "0 — бессрочно" }), "Счётчик уменьшается в начале хода того, на ком метка; ДМ меняет при наложении."),
        h("div", { class: "field" }, [
          h("span", { text: "Значок" }),
          h("label", { class: "card-toggle" }, [checkboxInput(() => condition.overlay, (v) => { condition.overlay = v; refreshApply(); }), "во весь токен"]),
          h("p", { class: "card-note", text: "Для состояний важнее арта: окаменение, беспамятство." }),
        ]),
      ]),
      ridersField(() => refreshApply()),
    ],
  });

  const descFold = fold({
    title: "Описание",
    summary: condition.description || "что это и как выглядит",
    body: [mdBlock("Описание", () => condition.description, (v) => { condition.description = v; descFold.setSummary(v || "что это и как выглядит"); })],
  });

  const slugWarnBox = h("div", {});
  function refreshSlugWarning() {
    slugWarnBox.innerHTML = "";
    const w = slugConflictWarning();
    if (w) slugWarnBox.appendChild(w);
  }
  refreshSlugWarning();
  const compatSummary = () => [foundryLabel(condition.slug), condition.source].filter(Boolean).join(" · ") || "Foundry-код, источник, теги";
  const compatFold = fold({
    title: "Совместимость и источник",
    summary: compatSummary(),
    body: [
      h("div", { class: "card-grid2" }, [
        labeled(
          "Соответствие Foundry",
          foundrySelect(() => {
            refreshSlugWarning();
            compatFold.setSummary(compatSummary());
          }),
          "Импортированный из Foundry эффект с этим кодом найдёт эту карточку. Без соответствия у карточки свой ключ."
        ),
        labeled("Источник", textInput(() => condition.source, (v) => { condition.source = v; hero.setPills(heroPills()); compatFold.setSummary(compatSummary()); }, { placeholder: "PHB'24" })),
      ]),
      slugWarnBox,
      tagsField(() => hero.setPills(heroPills())),
    ],
  });

  const glyphFold = fold({ title: "Значок", summary: isGlyph(condition.icon) ? "из набора" : "эмодзи " + (condition.icon || "❔"), body: [glyphPicker(setIcon)] });

  root.appendChild(renderBody([effects, h("div", { class: "card-folds" }, [rulesFold, applyFold, descFold, compatFold, glyphFold, importSection()])], [preview]));
}

// foundryLabel — русское имя кода Foundry для выжимки/выпадашки; ключ вида
// c-<id> (см. service.defaultConditionSlug) — не код, для него пусто.
function foundryLabel(slug) {
  return slug && CONDITION_RU[slug] ? `${conditionName(slug)} (${slug})` : "";
}

// foundrySelect — выбор кода Foundry вместо ввода slug руками: код нужен
// только мосту с импортом (см. domain.Condition.Slug), а ключ для меток
// сервер выдаёт сам. «Не сопоставлять» шлёт пустой slug — сервер вернёт
// c-<id>, и mergeInPlace подхватит его.
function foundrySelect(onChange) {
  const select = h("select", {});
  select.appendChild(h("option", { value: "", text: "— не сопоставлять —" }));
  for (const slug of Object.keys(CONDITION_RU)) select.appendChild(h("option", { value: slug, text: `${conditionName(slug)} (${slug})` }));
  select.value = CONDITION_RU[condition.slug] ? condition.slug : "";
  select.addEventListener("change", () => {
    condition.slug = select.value;
    scheduleSave();
    onChange();
  });
  return select;
}

// slugConflictWarning — «этот код уже у другой карточки». Дубль не ошибка
// для сервера (он берёт первую по алфавиту, см. domain.Condition.Slug), но
// за столом это выглядит как «состояние не работает»: метка вешается с
// чужими изменениями и чужим именем.
function slugConflictWarning() {
  const slug = (condition.slug || "").trim();
  if (!slug || !CONDITION_RU[slug]) return null;
  const others = allConditions.filter((c) => c.slug === slug && c.id !== condition.id);
  if (others.length === 0) return null;
  return h("p", {
    class: "card-note",
    style: "color: var(--amber);",
    text: "Этот код уже у карточки «" + others[0].name + "». Импорт и метки найдут только одну из них.",
  });
}

// glyphPicker — набор SVG-глифов (см. condition-glyphs.js). Эмодзи старых
// карточек остаются как есть, пока ДМ не выберет глиф.
function glyphPicker(onPick) {
  const wrap = h("div", { class: "glyph-picker", role: "listbox", "aria-label": "Значок состояния" });
  for (const name of Object.keys(GLYPHS)) {
    const btn = h("button", {
      type: "button",
      html: glyphSVG(name, { size: 20 }),
      class: condition.icon === name ? "active" : "",
      "aria-label": name,
      "aria-selected": String(condition.icon === name),
      onclick: () => {
        wrap.querySelectorAll("button").forEach((b) => {
          b.classList.toggle("active", b === btn);
          b.setAttribute("aria-selected", String(b === btn));
        });
        onPick(name);
      },
    });
    wrap.appendChild(btn);
  }
  return wrap;
}

// ridersField — зависимые состояния (domain.Condition.Riders): «беспамятство»
// тянет за собой «недееспособность» и «положение лёжа». Разворачивает их
// сервер в момент наложения, на один уровень вглубь (см.
// internal/service/room_statuses.go: handleApplyStatus).
function ridersField(onChange) {
  const list = h("div", { class: "card-chips" });
  const select = h("select", { "aria-label": "Добавить зависимое состояние" });

  function renderRiders() {
    list.innerHTML = "";
    condition.riders.forEach((slug, i) => {
      const known = allConditions.find((c) => c.slug === slug);
      list.appendChild(
        h("span", { class: "card-chip" }, [
          (known ? known.name : slug) + (known ? "" : " (нет такой карточки)"),
          h("button", {
            type: "button",
            html: icon("close", { size: 11 }),
            "aria-label": "Убрать",
            onclick: () => {
              condition.riders.splice(i, 1);
              scheduleSave();
              renderRiders();
              onChange();
            },
          }),
        ])
      );
    });
    select.innerHTML = "";
    select.appendChild(h("option", { value: "", text: "+ добавить…" }));
    for (const c of allConditions) {
      if (!c.slug || c.slug === condition.slug || condition.riders.includes(c.slug)) continue;
      select.appendChild(h("option", { value: c.slug, text: c.name }));
    }
    select.style.width = "auto";
    list.appendChild(select);
  }
  select.addEventListener("change", () => {
    const slug = select.value;
    if (!slug || condition.riders.includes(slug)) return;
    condition.riders.push(slug);
    scheduleSave();
    renderRiders();
    onChange();
  });
  renderRiders();

  return h("div", { class: "field" }, [h("span", { text: "Вешается вместе с" }), list, h("p", { class: "card-note", text: "Вешаются автоматически вместе с этим. Снятие этого их не снимает." })]);
}

function tagsField(onChange) {
  const list = h("div", { class: "card-chips" });
  function renderTags() {
    list.innerHTML = "";
    condition.tags.forEach((tag, i) => {
      list.appendChild(
        h("span", { class: "card-chip" }, [
          tag,
          h("button", {
            type: "button",
            html: icon("close", { size: 11 }),
            "aria-label": "Убрать тег",
            onclick: () => {
              condition.tags.splice(i, 1);
              scheduleSave();
              renderTags();
              onChange();
            },
          }),
        ])
      );
    });
  }
  renderTags();
  const input = h("input", { type: "text", placeholder: "тег + Enter" });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const v = input.value.trim();
    if (!v) return;
    condition.tags.push(v);
    input.value = "";
    scheduleSave();
    renderTags();
    onChange();
  });
  return h("div", {}, [labeled("Теги", input), list]);
}

// ==================== read-режим (по умолчанию) ====================

function renderReadView(root) {
  const hero = renderHero({
    glyph: glyphNode(condition.icon, ""),
    imageUrl: condition.imageUrl,
    color: condition.color,
    name: condition.name,
    levels: condition.levels,
    pills: heroPills(),
    readOnly: true,
  });
  root.appendChild(hero.el);
  root.appendChild(ornament());

  const stats = renderStatEditor(condition.modifiers, () => {}, { stand: renderStandSelect(standEntries), periodic: true, readOnly: true });
  const preview = renderStatusPreview(condition, { durLabel, ridersNames: () => condition.riders.map((slug) => (allConditions.find((c) => c.slug === slug) || {}).name || slug) });

  const folds = [];
  if (condition.mechanics) folds.push(fold({ title: "Правила", body: [h("p", { class: "card-text", text: condition.mechanics })], open: true }));
  folds.push(fold({ title: "Наложение", summary: applySummary(), body: [h("p", { class: "card-text", text: applySummary() })] }));
  const desc = condition.description && condition.description.trim();
  if (desc) {
    const body = h("div", { class: "card-prose" });
    body.innerHTML = renderNoteHtml(condition.description);
    folds.push(fold({ title: "Описание", body: [body], open: true }));
  }
  const compat = [foundryLabel(condition.slug), condition.source].filter(Boolean).join(" · ");
  if (compat) folds.push(fold({ title: "Совместимость и источник", summary: compat, body: [h("p", { class: "card-text", text: compat })] }));

  root.appendChild(renderBody([stats, h("div", { class: "card-folds" }, folds)], [preview]));
}

// ==================== импорт ====================

// applyImport — как и в referencebook.js: разбираем JSON, мапим батчево, но
// в эту карточку применяем только ПЕРВЫЙ результат — редактор здесь
// один-на-одну-карточку, массовый импорт живёт в списке состояний
// (catalog.js).
function applyImport(rawText, msgEl) {
  msgEl.classList.remove("error", "ok");
  msgEl.textContent = "";
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    msgEl.textContent = "Не удалось разобрать JSON.";
    msgEl.classList.add("error");
    return;
  }
  const mapped = mapFoundryConditionBatch(parsed);
  if (mapped.length === 0) {
    msgEl.textContent = "Не удалось распознать ни одного эффекта (нужен документ ActiveEffect из Foundry VTT или предмет/существо с массивом effects).";
    msgEl.classList.add("error");
    return;
  }
  Object.assign(condition, mapped[0], { tags: [...condition.tags, ...(mapped[0].tags || [])] });
  condition.riders = Array.isArray(condition.riders) ? condition.riders : [];
  document.getElementById("condTitle").textContent = condition.name || "Без имени";
  msgEl.textContent =
    `Импортировано: «${mapped[0].name}».` +
    (mapped[0].slug ? "" : " Код Foundry распознать не удалось — карточка получит свой ключ.") +
    (mapped.length > 1 ? ` (В файле было ${mapped.length} эффектов — применён первый.)` : "");
  msgEl.classList.add("ok");
  scheduleSave();
  renderApp();
}

function importSection() {
  const msg = h("div", { id: "importMsg" });
  const fileInput = h("input", { type: "file", accept: "application/json,.json" });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) return;
    applyImport(await file.text(), msg);
    fileInput.value = "";
  });
  return fold({
    title: "Импорт из Foundry VTT",
    summary: "JSON-экспорт эффекта",
    body: [
    h(
      "p",
      { class: "card-note" },
      "Нажми в Foundry на эффекте (ActiveEffect) «Export Data» и выбери полученный JSON. Подойдёт и файл предмета/заклинания/существа — из него возьмутся вложенные эффекты. Паки компендиума (.db/LevelDB) браузер прочитать не может, только JSON-экспорт."
    ),
    labeled("Файл экспорта", fileInput),
    msg,
    ],
  });
}

// ==================== autosave ====================

let saveTimer = null;
let dirty = false;
const saveStatusEl = document.getElementById("saveStatus");

function setSaveStatus(kind, detail) {
  saveStatusEl.classList.remove("saving", "error");
  if (kind === "saving") {
    saveStatusEl.textContent = "Сохранение…";
    saveStatusEl.classList.add("saving");
  } else if (kind === "saved") {
    saveStatusEl.textContent = "Сохранено";
  } else if (kind === "error") {
    saveStatusEl.textContent = "Ошибка: " + (detail || "");
    saveStatusEl.classList.add("error");
  } else {
    saveStatusEl.textContent = "";
  }
}

function scheduleSave() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 700);
}

async function doSave() {
  if (!dirty) return;
  dirty = false;
  setSaveStatus("saving");
  try {
    const saved = normalizeCondition(await updateCondition(conditionId, condition));
    mergeInPlace(condition, saved);
    setSaveStatus("saved");
    // Палитра состояний (status-palette.js) кэширует список на страницу —
    // без этого пинга ДМ увидел бы в ней старое имя/иконку до перезагрузки.
    // Тот же приём, что beacon:referenceSaved у справочника.
    if (window.parent !== window) {
      window.parent.postMessage({ type: "beacon:conditionSaved", id: conditionId }, location.origin);
    }
  } catch (err) {
    dirty = true;
    setSaveStatus("error", err.message);
  }
}

window.addEventListener("beforeunload", () => {
  if (dirty) doSave(); // best-effort, как в referencebook.js и соседях
});

// ==================== boot ====================

const editToggleBtn = document.getElementById("editToggleBtn");
function updateEditToggleBtn() {
  editToggleBtn.innerHTML = icon(editMode ? "eye" : "pencil", { size: 14 });
  editToggleBtn.title = editMode ? "Просмотр" : "Редактировать";
  editToggleBtn.classList.toggle("active", editMode);
}
editToggleBtn.onclick = () => {
  editMode = !editMode;
  updateEditToggleBtn();
  renderApp();
};

initFullscreenButton(document.getElementById("fullscreenBtn"));

// Своя шапка с ✕ — рамке на телефоне своя не нужна (см. embed.js).
announceOwnHeader();
document.getElementById("closeBtn").onclick = () => {
  if (window.parent !== window) {
    window.parent.postMessage({ type: "beacon:closeFloatingWindow" }, location.origin);
  } else {
    window.close();
  }
};

const cloneBtn = document.getElementById("cloneBtn");
cloneBtn.onclick = async () => {
  cloneBtn.disabled = true;
  try {
    const created = await createCondition(condition.name || "Без имени");
    const copy = Object.assign({}, condition, { id: created.id, system: false });
    await updateCondition(created.id, copy);
    if (window.parent !== window) {
      window.parent.postMessage({ type: "beacon:conditionSaved", id: created.id }, location.origin);
    }
    location.href = `/conditions.html?id=${created.id}&edit=1`;
  } catch (err) {
    showAlert("Не удалось клонировать: " + err.message);
  } finally {
    cloneBtn.disabled = false;
  }
};

// deleteBtn — тот же приём, что и в itembook.js/spellbook.js/bestiary.js.
const deleteBtn = document.getElementById("deleteBtn");
deleteBtn.onclick = async () => {
  const okDelete = await showConfirm(`Удалить «${condition.name || "Без имени"}» из библиотеки?`, {
    title: "Удалить состояние",
    okLabel: "Удалить",
    danger: true,
    hint: "Уже наложенные метки останутся висеть на токенах, но потеряют описание.",
  });
  if (!okDelete) return;
  deleteBtn.disabled = true;
  try {
    await deleteCondition(conditionId);
    if (window.parent !== window) {
      window.parent.postMessage({ type: "beacon:conditionSaved", id: conditionId }, location.origin);
      window.parent.postMessage({ type: "beacon:closeFloatingWindow" }, location.origin);
    } else {
      window.close();
    }
  } catch (err) {
    showAlert("Не удалось удалить: " + err.message);
    deleteBtn.disabled = false;
  }
};

function currentId() {
  return new URLSearchParams(location.search).get("id");
}

(async function boot() {
  const me = await fetchMe();
  if (!me) {
    location.href = "/";
    return;
  }
  conditionId = currentId();
  if (!conditionId) {
    document.getElementById("loadingHint").textContent = "Не указан id состояния (?id=...).";
    return;
  }
  try {
    condition = normalizeCondition(await fetchCondition(conditionId));
  } catch (err) {
    document.getElementById("loadingHint").textContent = "Не удалось загрузить состояние: " + err.message;
    return;
  }
  await loadTargets(); // подписи целей для статблока
  standEntries = await loadStand();
  // Список нужен только для выпадашки зависимых состояний — если он не
  // загрузился, карточка всё равно должна открыться.
  try {
    allConditions = await fetchConditions();
  } catch {
    allConditions = [];
  }

  document.getElementById("condTitle").textContent = condition.name || "Без имени";
  if (condition.system) {
    editMode = false;
    editToggleBtn.style.display = "none";
    deleteBtn.style.display = "none";
    cloneBtn.classList.add("visible");
    const pill = document.createElement("span");
    pill.className = "sys-pill";
    pill.title = "Карточка каталога «из коробки» — только для чтения";
    pill.innerHTML = icon("lock", { size: 11 }) + " каталог";
    document.getElementById("condTitle").after(pill);
  } else {
    editMode = new URLSearchParams(location.search).get("edit") === "1";
  }
  updateEditToggleBtn();
  renderApp();

  document.getElementById("loadingHint").style.display = "none";
  document.getElementById("app").classList.add("ready");
})();
