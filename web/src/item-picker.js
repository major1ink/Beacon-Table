// item-picker.js — переиспользуемый блок "поиск по каталогу предметов +
// количество + добавить", по образцу поискового блока трекера инициативы
// (см. combat-panel.js: els.search/searchResults) — используется в трёх
// местах: инвентарь персонажа (character-sheet.js), инвентарь монстра
// (bestiary.js), хаб ДМ (pages/dm.js). Сам ничего не отправляет на сервер —
// только рендерит UI и зовёт onPick(item, quantity), вызывающий код решает,
// что делать с выбором (POST в инвентарь, WS "hub_add_item" и т.п.).
import { fetchItems } from "./api.js";
import { icon } from "./icons.js";

// initItemPicker(container, opts) — очищает container и рендерит в него
// поле поиска + степпер количества + список результатов. opts.onPick(item,
// quantity) — колбэк выбора. opts.excludeBuiltin — функция-геттер: пока она
// возвращает true, из результатов выпадают карточки вшитого каталога
// (item.system, см. dm.js: тумблер "Показывать встроенные карточки").
// Список каталога подгружается один раз при инициализации (тем же принципом,
// что searchList в combat-panel.js) — если каталог мог измениться, вызывающая
// сторона просто заново зовёт initItemPicker при следующем открытии панели/модалки.
export function initItemPicker(container, { onPick, placeholder = "Поиск предмета в каталоге…", excludeBuiltin } = {}) {
  container.innerHTML = "";
  container.classList.add("item-picker");

  const row = document.createElement("div");
  row.className = "item-picker-row";
  const search = document.createElement("input");
  search.type = "text";
  search.placeholder = placeholder;
  search.className = "item-picker-search";
  const qty = document.createElement("input");
  qty.type = "number";
  qty.min = "1";
  qty.value = "1";
  qty.title = "Количество";
  qty.className = "item-picker-qty";
  row.append(search, qty);

  const results = document.createElement("div");
  results.className = "item-picker-results";

  container.append(row, results);

  let items = [];
  fetchItems()
    .then((list) => {
      items = list || [];
    })
    .catch(() => {});

  function render() {
    const filter = search.value.trim().toLowerCase();
    results.innerHTML = "";
    if (!filter) return;
    const hideBuiltin = typeof excludeBuiltin === "function" && excludeBuiltin();
    const filtered = items
      .filter((it) => (!hideBuiltin || !it.system) && it.name.toLowerCase().includes(filter))
      .slice(0, 20);
    if (filtered.length === 0) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = "Ничего не найдено.";
      results.appendChild(empty);
      return;
    }
    for (const it of filtered) {
      const r = document.createElement("div");
      r.className = "item-picker-result";
      const avatar = document.createElement("div");
      avatar.className = "item-picker-avatar";
      if (it.imageUrl) avatar.style.backgroundImage = `url("${it.imageUrl}")`;
      const name = document.createElement("div");
      name.className = "item-picker-name";
      name.textContent = it.name;
      name.title = it.name;
      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "item-picker-add";
      addBtn.innerHTML = icon("plus", { size: 13 });
      addBtn.title = "Добавить";
      addBtn.onclick = () => {
        const q = parseInt(qty.value, 10);
        onPick && onPick(it, Number.isFinite(q) && q > 0 ? q : 1);
      };
      r.append(avatar, name, addBtn);
      results.appendChild(r);
    }
  }
  search.oninput = render;
}
