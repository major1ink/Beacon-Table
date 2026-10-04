// world-system.js — смена системы мира с подтверждением; общее для настроек
// ДМ и предложения импорта (importer-offer.js).
import { fetchModules, fetchSystems, setWorldSystem } from "./api.js";
import { showAlert, showConfirm } from "./modal.js";

export const fitsSystem = (m, system) => !m.systems || !m.systems.length || m.systems.includes(system);

// changeWorldSystem — true, если мир перешёл на систему next (страницы
// перезагрузятся сами по world_reload).
export async function changeWorldSystem(next, intro = "") {
  let data, systems;
  try {
    [data, systems] = await Promise.all([fetchModules(), fetchSystems()]);
  } catch (err) {
    await showAlert("Не удалось сменить систему: " + err.message);
    return false;
  }
  const { world, modules } = data;
  const name = (systems.find((x) => x.id === next) || {}).title || next;
  const off = modules.filter((m) => m.type === "content" && world.enabled.includes(m.id) && !fitsSystem(m, next));
  let text = (intro ? intro + "\n\n" : "") + `Сменить систему мира на «${name}»? Поля прежней системы останутся в данных и не будут показываться, пока её не вернёшь. Мир перезапустится, у всех за столом обновится страница.`;
  if (off.length) text += `\n\nВыключатся модули для другой системы: ${off.map((m) => `«${m.title}»`).join(", ")}.`;
  if (!(await showConfirm(text, { title: "Система мира", okLabel: "Сменить" }))) return false;
  try {
    await setWorldSystem(world.id, next);
    return true;
  } catch (err) {
    await showAlert("Не удалось сменить систему: " + err.message);
    return false;
  }
}
