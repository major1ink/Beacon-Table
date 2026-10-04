// importer-offer.js — что видит человек, когда импорт не для системы мира:
// блок вместо формы импорта и диалог по нажатию. Карточки при этом не пишутся.
import { fetchMe, fetchSystems } from "./api.js";
import { fold, el } from "./card-shell.js";
import { importerInfo } from "./importers.js";
import { showAlert, showConfirm } from "./modal.js";
import { isOwner } from "./roles.js";
import { changeWorldSystem } from "./world-system.js";

const lead = (id) => `Этот импорт — для ${importerInfo(id).title}, а мир сейчас играет по другой системе.`;

// offerImport — ДМ-владелец: переключить мир на систему импортёра, если её
// модуль установлен, иначе предложение открыть витрину; остальным — просьба
// к ДМ.
export async function offerImport(id) {
  const info = importerInfo(id);
  const me = await fetchMe();
  if (!me || !isOwner(me.role)) {
    await showAlert(`${lead(id)} Попроси ДМ подключить ${info.title}.`, { title: "Импорт" });
    return;
  }
  let systems;
  try {
    systems = await fetchSystems();
  } catch (err) {
    await showAlert("Не удалось получить список систем: " + err.message);
    return;
  }
  const target = [info.offer, ...info.systems].find((sys) => systems.some((x) => x.id === sys));
  if (target) {
    await changeWorldSystem(target, lead(id));
    return;
  }
  const open = await showConfirm(`${lead(id)} Модуль ${info.title} не установлен — его можно поставить в витрине модулей, а потом выбрать системой мира.`, { title: "Импорт", okLabel: "Открыть витрину" });
  if (open) window.open(`/modules.html?module=${encodeURIComponent(info.offer)}`, "_blank", "noopener");
}

export const offerButtonLabel = (id) => `Подключить ${importerInfo(id).title}`;

// offerBody — текст и кнопка предложения.
export const offerBody = (id) => [
  el("p", { class: "card-note", text: lead(id) }),
  el("button", { type: "button", text: offerButtonLabel(id), onclick: () => offerImport(id) }),
];

// offerFold — замена свёрнутого блока импорта на карточке.
export const offerFold = (id, title) => fold({ title, summary: "для " + importerInfo(id).title, body: offerBody(id) });
