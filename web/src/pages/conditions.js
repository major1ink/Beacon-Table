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
import { icon } from "../icons.js";
import { renderNoteHtml } from "../notes/markdown.js";
import { mapFoundryConditionBatch } from "../condition-import.js";
import { normalizeSlug, DEFAULT_ICONS } from "../foundry-conditions.js";
import { renderStatEditor, loadTargets, describeModifier } from "../stat-editor.js";
import { loadStand, renderStandSelect } from "../stand.js";
import { showAlert, showConfirm } from "../modal.js";
import { initFullscreenButton } from "../fullscreen.js";
import { el as h, labeled, pill, ornament, renderHero, fold, renderBody } from "../card-shell.js";

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

// mergeConditionInPlace — после автосохранения переносим ответ сервера В ТОТ
// ЖЕ объект `condition`, а не подменяем переменную целиком (было раньше:
// `condition = normalizeCondition(await updateCondition(...))`).
//
// Почему это важно: renderStatEditor/riders-редактор получают массив
// (condition.modifiers, condition.riders) ОДИН РАЗ при монтировании секции
// и потом мутируют его на месте (push/splice) — сами по ссылке, а не через
// геттер вроде textInput'а. Если подменить саму переменную `condition`
// (и тем самым — ссылки на её массивы) ответом сервера, уже смонтированная
// форма продолжает держать СТАРЫЙ массив: следующие правки в открытых полях
// «Изменения»/«Зависимые состояния»/«Теги» уходят в осиротевший массив,
// который ни один будущий scheduleSave() уже не увидит. Внешне это
// выглядело как «правка изменения тихо не сохраняется, при перезаходе в
// карточку — пусто»: только жизни хватало ровно до первого успешного
// автосохранения, а любая дальнейшая правка того же списка терялась молча.
function mergeConditionInPlace(target, saved) {
  for (const key of Object.keys(target)) {
    if (!(key in saved)) delete target[key];
  }
  for (const [key, value] of Object.entries(saved)) {
    if (Array.isArray(target[key]) && Array.isArray(value)) {
      mergeArrayInPlace(target[key], value);
    } else {
      target[key] = value;
    }
  }
}

// mergeArrayInPlace — как mergeConditionInPlace, но для одного массива:
// держит по ссылке не только сам массив, но и (для массива объектов, как
// modifiers) каждый элемент по индексу. У «Значения»/«Заметки» в редакторе
// изменений нет перерисовки строки на каждый символ (см. stat-editor.js:
// cellInput) — поле держит объект-модификатор по ссылке напрямую;
// подмена этого объекта на новый с тем же содержимым оторвала бы поле от
// массива точно так же, как раньше отрывала подмена самого массива.
function mergeArrayInPlace(cur, value) {
  for (let i = 0; i < value.length; i++) {
    const v = value[i];
    if (cur[i] && typeof cur[i] === "object" && v && typeof v === "object") {
      Object.assign(cur[i], v);
    } else {
      cur[i] = v;
    }
  }
  cur.length = value.length;
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
      hero.setGlyph(condition.icon, condition.imageUrl);
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
        hero.setGlyph(condition.icon, "");
        artBtn.textContent = "Загрузить свой…";
      } else upload.click();
    },
  });

  const colorInput = h("input", { type: "color", value: condition.color || "#7c6cf0" });
  colorInput.addEventListener("input", () => {
    condition.color = colorInput.value;
    scheduleSave();
    hero.setColor(condition.color);
  });

  const glyphInput = h("input", { type: "text", class: "glyph-input", value: condition.icon || "", placeholder: "❔", maxlength: "8" });
  glyphInput.addEventListener("input", () => {
    condition.icon = glyphInput.value;
    scheduleSave();
    hero.setGlyph(condition.icon, condition.imageUrl);
  });

  const hero = renderHero({
    glyph: condition.icon,
    imageUrl: condition.imageUrl,
    color: condition.color,
    name: condition.name,
    namePlaceholder: "Название состояния",
    levels: condition.levels,
    pills: heroPills(),
    controls: [labeled("Значок", glyphInput), labeled("Цвет", colorInput), h("div", { class: "field" }, [h("span", { text: "Арт" }), artBtn, upload])],
    onName: (v) => {
      condition.name = v;
      document.getElementById("condTitle").textContent = v || "Без имени";
      scheduleSave();
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

  const refreshApply = () => {
    applyFold.setSummary(applySummary());
    hero.setPills(heroPills());
    hero.setLevels(condition.levels);
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
  const compatSummary = () => [condition.slug, condition.source].filter(Boolean).join(" · ") || "Foundry-код, источник, теги";
  const compatFold = fold({
    title: "Совместимость и источник",
    summary: compatSummary(),
    body: [
      h("div", { class: "card-grid2" }, [
        labeled(
          "Slug",
          textInput(
            () => condition.slug,
            (v) => {
              condition.slug = normalizeSlug(v);
              refreshSlugWarning();
              compatFold.setSummary(compatSummary());
            },
            { placeholder: "blinded" }
          ),
          "Код Foundry (blinded/prone/exhaustion) — по нему импорт находит карточку. Пусто — сервер поставит свой ключ."
        ),
        labeled("Источник", textInput(() => condition.source, (v) => { condition.source = v; hero.setPills(heroPills()); compatFold.setSummary(compatSummary()); }, { placeholder: "PHB'24" })),
      ]),
      slugWarnBox,
      tagsField(() => hero.setPills(heroPills())),
    ],
  });

  const glyphFold = fold({ title: "Набор значков", summary: "быстрый выбор глифа", body: [glyphPicker((g) => { glyphInput.value = g; hero.setGlyph(g, condition.imageUrl); })] });

  root.appendChild(renderBody([effects, h("div", { class: "card-folds" }, [rulesFold, applyFold, descFold, compatFold, glyphFold, importSection()])], null));
}

// slugConflictWarning — предупреждение «этот slug уже занят другой
// карточкой». Дубль не ошибка для сервера (он просто берёт первую по
// алфавиту, см. domain.Condition.Slug), но за столом это выглядит как
// «состояние не работает»: метка вешается с чужими изменениями и чужим
// именем. Проверяем по списку мира, загруженному при открытии карточки.
function slugConflictWarning() {
  const slug = (condition.slug || "").trim();
  if (!slug) return null;
  const others = allConditions.filter((c) => c.slug === slug && c.id !== condition.id);
  if (others.length === 0) return null;
  return h("p", {
    class: "card-note",
    style: "color: var(--amber);",
    text:
      "Такой slug уже есть у карточки «" + others[0].name + "». Метка найдёт только одну из них — поменяй slug, иначе состояние будет вешаться с чужими изменениями.",
  });
}

// glyphPicker — быстрый выбор глифа из того же набора, которым пользуется
// каталог «из коробки» и импорт (см. foundry-conditions.js: DEFAULT_ICONS).
// Не ограничивает ввод: поле «Глиф» рядом принимает любой эмодзи, пикер —
// просто чтобы не искать символ по всей раскладке.
function glyphPicker(onPick) {
  const wrap = h("div", { class: "glyph-picker" });
  const seen = new Set();
  for (const glyph of Object.values(DEFAULT_ICONS)) {
    if (seen.has(glyph)) continue;
    seen.add(glyph);
    const btn = h("button", {
      type: "button",
      text: glyph,
      class: condition.icon === glyph ? "active" : "",
      onclick: () => {
        condition.icon = glyph;
        scheduleSave();
        wrap.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
        onPick(glyph);
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
  const pills = [...(condition.source ? [pill(condition.source, "gold")] : []), ...condition.tags.map((t) => pill(t))];
  const subtitleBits = [condition.levels > 1 ? `уровней: ${condition.levels}` : "", durLabel(), condition.overlay ? "во весь токен" : ""].filter(Boolean).join(" · ");

  const hero = renderHero({
    glyph: condition.icon,
    imageUrl: condition.imageUrl,
    color: condition.color,
    name: condition.name,
    levels: condition.levels,
    pills: [...pills, pill(subtitleBits)],
    readOnly: true,
  });
  root.appendChild(hero.el);
  root.appendChild(ornament());

  if (condition.modifiers.length) {
        root.appendChild(
      h("div", { class: "ib-block" }, [
        h("h3", { class: "ib-section-title", text: "Изменения" }),
        ...condition.modifiers.map((m) => h("div", { class: "ib-line", text: describeModifier(m) })),
      ])
    );
  }

  if (condition.mechanics) {
        root.appendChild(
      h("div", { class: "ib-block" }, [
        h("h3", { class: "ib-section-title", text: "Механика" }),
        h("div", { class: "ib-line", text: condition.mechanics }),
      ])
    );
  }

  if (condition.riders.length) {
    const names = condition.riders.map((slug) => {
      const known = allConditions.find((c) => c.slug === slug);
      return known ? known.name : slug;
    });
    root.appendChild(
      h("div", { class: "ib-block" }, [
        h("h3", { class: "ib-section-title", text: "Вешается вместе с" }),
        h("div", { class: "ib-line", text: names.join(", ") }),
      ])
    );
  }

  const desc = condition.description && condition.description.trim();
  if (desc) {
        const body = h("div", { class: "ib-prose" });
    body.innerHTML = renderNoteHtml(condition.description);
    root.appendChild(h("div", { class: "ib-block" }, [h("h3", { class: "ib-section-title", text: "Описание" }), body]));
  }
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
    mergeConditionInPlace(condition, saved);
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
