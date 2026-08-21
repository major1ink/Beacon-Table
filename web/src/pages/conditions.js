// Карточка состояния (ослепление/испуг/истощение или самодельная метка ДМ —
// см. domain.Condition) и одновременно КОНСТРУКТОР состояний: отдельное
// окно, открывается из компендиума (узел «Состояния», см. catalog.js) — по
// той же схеме, что referencebook.js/itembook.js/spellbook.js: тот же
// h()/textInput/mdBlock-конструктор, тот же debounce-автосейв, тот же
// read/edit-тумблер и «Клонировать» для карточек каталога «из коробки».
//
// Два разных блока, которые легко перепутать: «Изменения» — то, что
// приложение реально применяет числами (см. internal/domain/modifier.go и
// modifier-editor.js), «Механика» — то, что в числа не ложится
// (преимущество/помеха, автопровалы) и остаётся текстом для глаз ДМ.
// Правил приложение по-прежнему не знает: список изменений составляет
// человек или импорт (web/src/condition-import.js), а не вывод из описания.
import { fetchMe, fetchCondition, createCondition, updateCondition, fetchConditions, uploadFile } from "../api.js";
import { icon } from "../icons.js";
import { renderNoteHtml } from "../notes/markdown.js";
import { mapFoundryConditionBatch } from "../condition-import.js";
import { normalizeSlug, DEFAULT_ICONS } from "../foundry-conditions.js";
import { renderModifierEditor, loadModifierTargets, ensureModifierEditorCSS, describeModifier } from "../modifier-editor.js";

// ==================== state ====================

let conditionId = null;
let condition = null; // объект domain.Condition целиком (camelCase — см. json-теги)
let editMode = false;
// allConditions — весь список мира, нужен только для выбора зависимых
// состояний (Riders): их указывают slug'ами, а тыкать мышью удобнее по
// именам. Тянется один раз при открытии карточки.
let allConditions = [];

function normalizeCondition(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  c.tags = Array.isArray(c.tags) ? c.tags : [];
  c.riders = Array.isArray(c.riders) ? c.riders : [];
  c.modifiers = Array.isArray(c.modifiers) ? c.modifiers : [];
  return c;
}

// ==================== DOM helpers (та же схема, что referencebook.js) ====================

function h(tag, attrs, children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(children || [])) {
    if (c === undefined || c === null || c === false) continue;
    e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
}

function field(labelText, inputEl, title) {
  return h("label", { class: "field", title }, [h("span", { text: labelText }), inputEl]);
}

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
    renderApp();
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
  return h("div", { class: "section" }, [h("h3", { text: labelText }), h("div", { class: "md-block" }, [t, render])]);
}

// preview — предпросмотр значка ровно в том виде, в каком его увидят на
// токене и в палитре: свой арт, если он задан, иначе глиф; кайма — цветом
// карточки (см. web/src/vtt/layers/tokens.js: drawStatuses и
// status-palette.js: statusVisual — три места, один контракт).
function preview() {
  const box = h("div", { class: "cond-preview" });
  if (condition.color) box.style.setProperty("--cond-color", condition.color);
  if (condition.imageUrl) box.appendChild(h("img", { src: condition.imageUrl, alt: condition.name || "" }));
  else box.appendChild(h("span", { text: condition.icon || "❔" }));
  return box;
}

// ==================== рендер ====================

function renderApp() {
  const root = document.getElementById("app");
  root.innerHTML = "";
  if (editMode) renderEditView(root);
  else renderReadView(root);
}

function renderEditView(root) {
  const upload = h("input", { type: "file", accept: "image/*" });
  upload.addEventListener("change", async () => {
    const file = upload.files[0];
    if (!file) return;
    try {
      const { url } = await uploadFile(file, "tokens");
      condition.imageUrl = url;
      scheduleSave();
      renderApp();
    } catch (err) {
      alert("Не удалось загрузить значок: " + err.message);
    }
  });

  const colorInput = h("input", { type: "color", value: condition.color || "#7c6cf0" });
  colorInput.addEventListener("input", () => {
    condition.color = colorInput.value;
    scheduleSave();
    renderApp();
  });

  root.appendChild(
    h("div", { class: "section" }, [
      h("div", { class: "portrait-wrap" }, [
        preview(),
        h("div", { class: "col", style: "flex:1 1 auto;gap:6px;min-width:0;" }, [
          field(
            "Имя",
            textInput(
              () => condition.name,
              (v) => {
                condition.name = v;
                document.getElementById("condTitle").textContent = v || "Без имени";
              }
            )
          ),
          h("div", { class: "row" }, [
            field(
              "Глиф",
              textInput(() => condition.icon, (v) => (condition.icon = v), { placeholder: "🙈", maxlength: "8" }),
              "Один символ-эмодзи. Именно он рисуется значком на токене и в палитре — SVG-иконки тут не используются, потому что тот же значок нужен и в WebGL-сцене."
            ),
            field("Свой арт", upload, "Необязательно: PNG/SVG вместо глифа — рисуется и на токене, и в палитре."),
            field("Цвет", colorInput, "Кайма значка на токене и рамка чипа в трекере."),
          ]),
          condition.imageUrl
            ? h("button", {
                type: "button",
                text: "Убрать свой арт",
                style: "align-self:flex-start;padding:3px 10px;font-size:11px;",
                onclick: () => {
                  condition.imageUrl = "";
                  scheduleSave();
                  renderApp();
                },
              })
            : null,
        ]),
      ]),
      glyphPicker(),
      slugConflictWarning(),
      h("div", { class: "row" }, [
        field(
          "Slug",
          textInput(
            () => condition.slug,
            (v) => {
              condition.slug = normalizeSlug(v);
              // Перерисовка нужна ради предупреждения о дубле (см.
              // slugConflictWarning) — поле при этом не теряет фокус, потому
              // что renderApp пересобирает секцию целиком уже после ввода.
              queueMicrotask(renderApp);
            },
            { placeholder: "blinded" }
          ),
          "Машинный ключ состояния: по нему метка ссылается на карточку, по нему же сопоставляется импорт из Foundry (там это код вида blinded/prone/exhaustion). Латиница, цифры и дефис."
        ),
        field("Источник", textInput(() => condition.source, (v) => (condition.source = v), { placeholder: "PHB'24" })),
        field(
          "Уровней",
          numberInput(() => condition.levels, (v) => (condition.levels = v), { max: "20" }),
          "0 или 1 — обычный тумблер. Больше — многоуровневое состояние вроде истощения (6): у метки появляется номер уровня."
        ),
        field(
          "Раундов по умолчанию",
          numberInput(() => condition.defaultRounds, (v) => (condition.defaultRounds = v)),
          "Сколько раундов метка висит, если ДМ не указал иное. 0 — бессрочно, пока не снимут. Счётчик уменьшается в начале хода того, на ком метка."
        ),
      ]),
      h("div", { class: "cond-flags" }, [
        h("label", {}, [
          checkboxInput(() => condition.overlay, (v) => (condition.overlay = v)),
          h("span", { text: "значок во весь токен (overlay)" }),
        ]),
      ]),
      h("p", { class: "cond-note", text: "Overlay — для состояний, которые важнее самого арта: окаменение, беспамятство. Аналог flags.core.overlay в Foundry." }),
      ridersField(),
      tagsField(),
    ])
  );

  // ---- изменения, которые приложение реально применяет ----
  root.appendChild(
    h("div", { class: "section" }, [
      h("h3", { text: "Изменения" }),
      renderModifierEditor(condition.modifiers, scheduleSave, {
        hint:
          "Применяется, пока метка висит: постоянные — к КД/скорости/характеристикам в трекере и на листе персонажа, «в начале/конце хода» — разовым броском по текущим хитам (виден в общем логе). Преимущество, помеха и автопровалы сюда не ложатся — им место в «Механике» ниже.",
      }),
    ])
  );

  root.appendChild(
    h("div", { class: "section" }, [
      h("h3", { text: "Механика" }),
      (() => {
        const t = h("textarea", { placeholder: "Помеха на броски атаки; атаки по существу — с преимуществом", style: "min-height:60px;" });
        t.value = condition.mechanics ?? "";
        t.addEventListener("input", () => {
          condition.mechanics = t.value;
          scheduleSave();
        });
        return t;
      })(),
      h("p", {
        class: "cond-note",
        text:
          "Короткая выжимка «что меняется по цифрам» — её видно в палитре при ПКМ по значку. Beacon Table эти цифры НЕ применяет: броски и модификаторы за столом считает человек, как и с атаками монстра.",
      }),
    ])
  );

  root.appendChild(mdBlock("Описание", () => condition.description, (v) => (condition.description = v)));
  root.appendChild(importSection());
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
    class: "cond-note",
    style: "color: var(--amber);",
    text:
      "Такой slug уже есть у карточки «" + others[0].name + "». Метка найдёт только одну из них — поменяй slug, иначе состояние будет вешаться с чужими изменениями.",
  });
}

// glyphPicker — быстрый выбор глифа из того же набора, которым пользуется
// каталог «из коробки» и импорт (см. foundry-conditions.js: DEFAULT_ICONS).
// Не ограничивает ввод: поле «Глиф» рядом принимает любой эмодзи, пикер —
// просто чтобы не искать символ по всей раскладке.
function glyphPicker() {
  const wrap = h("div", { class: "glyph-picker" });
  const seen = new Set();
  for (const glyph of Object.values(DEFAULT_ICONS)) {
    if (seen.has(glyph)) continue;
    seen.add(glyph);
    wrap.appendChild(
      h("button", {
        type: "button",
        text: glyph,
        class: condition.icon === glyph ? "active" : "",
        onclick: () => {
          condition.icon = glyph;
          scheduleSave();
          renderApp();
        },
      })
    );
  }
  return wrap;
}

// ridersField — зависимые состояния (domain.Condition.Riders): «беспамятство»
// тянет за собой «недееспособность» и «положение лёжа». Разворачивает их
// сервер в момент наложения, на один уровень вглубь (см.
// internal/service/room_statuses.go: handleApplyStatus).
function ridersField() {
  const wrap = h("div", { style: "margin-top:8px;" });
  const list = h("div", { class: "rider-list" });

  function renderRiders() {
    list.innerHTML = "";
    condition.riders.forEach((slug, i) => {
      const known = allConditions.find((c) => c.slug === slug);
      list.appendChild(
        h("span", { class: "tag-pill" }, [
          (known ? known.name : slug) + (known ? "" : " (нет такой карточки)"),
          h("button", {
            type: "button",
            html: icon("close", { size: 11 }),
            onclick: () => {
              condition.riders.splice(i, 1);
              scheduleSave();
              renderRiders();
            },
          }),
        ])
      );
    });
  }
  renderRiders();

  const select = h("select", {});
  select.appendChild(h("option", { value: "", text: "+ добавить зависимое…" }));
  for (const c of allConditions) {
    if (!c.slug || c.slug === condition.slug) continue;
    select.appendChild(h("option", { value: c.slug, text: `${c.name} (${c.slug})` }));
  }
  select.addEventListener("change", () => {
    const slug = select.value;
    select.value = "";
    if (!slug || condition.riders.includes(slug)) return;
    condition.riders.push(slug);
    scheduleSave();
    renderRiders();
  });

  wrap.append(
    field("Зависимые состояния", select, "Вешаются автоматически вместе с этим. Снятие этого их НЕ снимает — как и в Foundry."),
    list
  );
  return wrap;
}

function tagsField() {
  const wrap = h("div", { style: "margin-top:8px;" });
  const list = h("div", { class: "tag-list" });
  function renderTags() {
    list.innerHTML = "";
    condition.tags.forEach((tag, i) => {
      list.appendChild(
        h("span", { class: "tag-pill" }, [
          tag,
          h("button", {
            type: "button",
            html: icon("close", { size: 11 }),
            onclick: () => {
              condition.tags.splice(i, 1);
              scheduleSave();
              renderTags();
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
  });
  wrap.append(field("Теги", input), list);
  return wrap;
}

// ==================== read-режим (по умолчанию) ====================

function renderReadView(root) {
  const pills = [...(condition.source ? [condition.source] : []), ...condition.tags].map((t) =>
    h("span", { class: "ib-tag-pill", text: t })
  );
  const subtitleBits = [
    condition.slug ? `slug: ${condition.slug}` : "slug не задан — состояние не на что вешать",
    condition.levels > 1 ? `уровней: ${condition.levels}` : "",
    condition.defaultRounds ? `по умолчанию ${condition.defaultRounds} р.` : "бессрочно",
    condition.overlay ? "во весь токен" : "",
  ]
    .filter(Boolean)
    .join(" · ");

  root.appendChild(
    h("div", { class: "ib-header" }, [
      preview(),
      h("div", { class: "ib-header-text" }, [
        h("h2", { class: "ib-name", text: condition.name || "Без имени" }),
        h("div", { class: "ib-subtitle", text: subtitleBits }),
        pills.length ? h("div", { class: "ib-tags" }, pills) : null,
      ]),
    ])
  );

  if (condition.modifiers.length) {
    root.appendChild(h("div", { class: "ib-hr" }));
    root.appendChild(
      h("div", { class: "ib-block" }, [
        h("h3", { class: "ib-section-title", text: "Изменения" }),
        ...condition.modifiers.map((m) => h("div", { class: "ib-line", text: describeModifier(m) })),
      ])
    );
  }

  if (condition.mechanics) {
    root.appendChild(h("div", { class: "ib-hr" }));
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
    root.appendChild(h("div", { class: "ib-hr" }));
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
    (mapped[0].slug ? "" : " Slug распознать не удалось — впиши его вручную, иначе состояние не на что вешать.") +
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
  return h("div", { class: "section", id: "importSection" }, [
    h("h3", { text: "Импорт из Foundry VTT" }),
    h(
      "p",
      { class: "hint" },
      "Нажми в Foundry на эффекте (ActiveEffect) «Export Data» и выбери полученный JSON. Подойдёт и файл предмета/заклинания/существа — из него возьмутся вложенные эффекты. Паки компендиума (.db/LevelDB) браузер прочитать не может, только JSON-экспорт."
    ),
    h(
      "p",
      { class: "hint" },
      "Строка changes[] из Foundry не применяется как механика — она расшифровывается словами в поле «Механика» (Beacon Table не считает КД и модификаторы за ДМ)."
    ),
    field("Файл экспорта", fileInput),
    msg,
  ]);
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
    condition = normalizeCondition(await updateCondition(conditionId, condition));
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
    alert("Не удалось клонировать: " + err.message);
  } finally {
    cloneBtn.disabled = false;
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
  ensureModifierEditorCSS();
  await loadModifierTargets(); // справочник целей для таблицы «Изменения»
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
