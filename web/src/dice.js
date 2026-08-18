// initDiceRoller — общий блок бросков кубов, подключается и в player.html, и
// в dm.html (ДМ тоже кидает кубы, например за NPC). Перенесено дословно из
// static/js/app.js — DOM/HTTP-логика, canvas-рендера не касается.
// controlsContainer — пустой div для кнопок/поля формулы, send — функция
// отправки WS-сообщения (vtt.send). logContainer — опциональный отдельный
// div под лог результатов (нужен dm.html: там кнопки брока переехали в
// меню громкости справа, а лог остался отдельно сверху канваса, см.
// pages/dm.js); если не передан — лог, как раньше, живёт внутри того же
// controlsContainer (player.html). Лог — чисто клиентский (последние ~30
// бросков на вкладку), сервер ничего не хранит (см. internal/service/room.go:
// relayRoll — бросок эфемерен, как animate_attack).
export function initDiceRoller(controlsContainer, send, logContainer) {
  const DICE = [4, 6, 8, 10, 12, 20, 100];
  const ownLog = !logContainer;
  controlsContainer.innerHTML = `
    <div class="dice-buttons">${DICE.map((n) => `<button type="button" data-d="${n}">d${n}</button>`).join("")}</div>
    <div class="dice-custom">
      <input type="text" placeholder="напр. 2d6+3" />
      <button type="button" data-roll-custom>Бросить</button>
    </div>
    ${ownLog ? '<div class="dice-log"></div>' : ""}
  `;
  const log = ownLog ? controlsContainer.querySelector(".dice-log") : logContainer;
  log.classList.add("dice-log");
  const customInput = controlsContainer.querySelector(".dice-custom input");

  function roll(formula) {
    if (formula) send({ type: "roll_dice", formula });
  }
  controlsContainer.querySelectorAll("[data-d]").forEach((btn) => {
    btn.onclick = () => roll("1d" + btn.dataset.d);
  });
  controlsContainer.querySelector("[data-roll-custom]").onclick = () => roll(customInput.value.trim());
  customInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") roll(customInput.value.trim());
  });

  document.addEventListener("vtt:rollResult", (e) => {
    const { name, label, formula, rolls, modifier, total } = e.detail;
    const row = document.createElement("div");
    row.className = "dice-log-row";
    const mod = modifier ? (modifier > 0 ? "+" + modifier : String(modifier)) : "";
    // label — необязательная подпись броска с листа персонажа ("Атлетика",
    // "Спасбросок Ловкости"...), см. internal/domain/message.go: ClientMsg.Label.
    const who = label ? `${name} — ${label}` : name;
    row.textContent = `${who}: ${formula} → [${(rolls || []).join(", ")}]${mod} = ${total}`;
    log.prepend(row);
    while (log.children.length > 30) log.removeChild(log.lastChild);
  });
}
