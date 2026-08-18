// loot-take-modal.js — общее модальное окно "забрать предметы": список
// InventoryEntry-строк (картинка/имя/вес/доступное количество/степпер) +
// выбор персонажа-получателя (если их больше одного) + кнопка "Забрать".
// Используется и для хаба ДМ (WS "hub_take_item"), и для лута трупа
// (WS "loot_take_item") — общий рендер списка/степпера не дублируется между
// pages/dm.js и pages/player.js (см. план фичи).
import { icon } from "./icons.js";

// showLootTakeModal(opts) — создаёт оверлей поверх всей страницы, возвращает
// {close, update(entries)} для вызывающей стороны (например, обновить список
// в уже открытом окне по свежему WS-состоянию).
//   title — заголовок окна ("Хаб лута" / "Труп: Гоблин")
//   entries — [{id, name, imageUrl, weightLb, quantity}]
//   characters — [{id, name}] — кому можно начислить; пусто — окно покажет
//     подсказку "нет персонажей" вместо списка (взять нечем/некому)
//   onTake(entryId, quantity, characterId) — Promise-возвращающий колбэк
//     фактического запроса (WS-команда) — модалка сама не знает протокол
export function showLootTakeModal({ title, entries, characters, onTake }) {
  let list = (entries || []).map((e) => ({ ...e }));
  let characterId = characters && characters.length ? characters[0].id : "";

  const overlay = document.createElement("div");
  overlay.className = "loot-modal-overlay";
  const modal = document.createElement("div");
  modal.className = "loot-modal";
  overlay.appendChild(modal);

  const header = document.createElement("h2");
  const titleSpan = document.createElement("span");
  titleSpan.textContent = title || "Забрать предметы";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.innerHTML = icon("close", { size: 15 });
  closeBtn.onclick = () => close();
  header.append(titleSpan, closeBtn);
  modal.appendChild(header);

  let charSelect = null;
  if (characters && characters.length > 1) {
    const charRow = document.createElement("label");
    charRow.className = "loot-modal-char-row";
    charRow.textContent = "Кому: ";
    charSelect = document.createElement("select");
    for (const c of characters) {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.name;
      charSelect.appendChild(opt);
    }
    charSelect.value = characterId;
    charSelect.onchange = () => {
      characterId = charSelect.value;
    };
    charRow.appendChild(charSelect);
    modal.appendChild(charRow);
  }

  const body = document.createElement("div");
  body.className = "loot-modal-body";
  modal.appendChild(body);

  function render() {
    body.innerHTML = "";
    if (!characters || characters.length === 0) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = "Нет персонажа, которому можно начислить предметы.";
      body.appendChild(p);
      return;
    }
    if (list.length === 0) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = "Здесь пусто.";
      body.appendChild(p);
      return;
    }
    for (const e of list) {
      const row = document.createElement("div");
      row.className = "loot-modal-row";

      const avatar = document.createElement("div");
      avatar.className = "loot-modal-avatar";
      if (e.imageUrl) avatar.style.backgroundImage = `url("${e.imageUrl}")`;
      else avatar.innerHTML = icon("backpack", { size: 16 });

      const info = document.createElement("div");
      info.className = "loot-modal-info";
      const name = document.createElement("div");
      name.className = "loot-modal-name";
      name.textContent = e.name;
      const meta = document.createElement("div");
      meta.className = "loot-modal-meta";
      const weightPart = e.weightLb ? `${e.weightLb} фнт · ` : "";
      meta.textContent = `${weightPart}доступно: ${e.quantity}`;
      info.append(name, meta);

      const qty = document.createElement("input");
      qty.type = "number";
      qty.min = "1";
      qty.max = String(e.quantity);
      qty.value = String(e.quantity);
      qty.className = "loot-modal-qty";

      const takeBtn = document.createElement("button");
      takeBtn.type = "button";
      takeBtn.className = "loot-modal-take";
      takeBtn.textContent = "Забрать";
      takeBtn.onclick = () => {
        const q = Math.min(parseInt(qty.value, 10) || 1, e.quantity);
        if (q <= 0) return;
        takeBtn.disabled = true;
        Promise.resolve(onTake(e.id, q, characterId))
          .then(() => {
            e.quantity -= q;
            list = list.filter((x) => x.quantity > 0);
            render();
          })
          .catch((err) => {
            takeBtn.disabled = false;
            alert("Не удалось забрать: " + err.message);
          });
      };

      row.append(avatar, info, qty, takeBtn);
      body.appendChild(row);
    }
  }
  render();

  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  function close() {
    overlay.remove();
  }

  return {
    close,
    // update — перерисовать список по свежим данным с сервера (например,
    // хаб поменялся, пока окно было открыто) — доступное количество каждой
    // записи подхватывается заново, взятое кем-то другим уже не предложит
    // забрать больше, чем осталось.
    update(newEntries) {
      list = (newEntries || []).map((e) => ({ ...e }));
      render();
    },
  };
}
