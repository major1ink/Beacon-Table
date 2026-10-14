// importers.js — какие игровые системы понимает каждый импортёр. Импортёры
// — код программы и видны в любом мире; в мире другой системы вместо
// импорта предлагается подключить систему импортёра (importer-offer.js).
import { systemId } from "./system-profile.js";

const DND5E = { title: "D&D 5e", systems: ["dnd5e-2014", "dnd5e-2024"], offer: "dnd5e-2024" };

const IMPORTERS = {
  "foundry-dnd5e": DND5E,
  lss: DND5E,
};

export const importerInfo = (id) => IMPORTERS[id];

export const importerFits = (id, system = systemId()) => !!IMPORTERS[id] && IMPORTERS[id].systems.includes(system);
