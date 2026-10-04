// modules-view.js — чистая часть витрины модулей (pages/modules.js): слияние
// каталога с установленным, фильтры и подписи.

export const TYPE_LABEL = { system: "Система", content: "Контент" };

export const SECTION_LABEL = {
  bestiary: "Существа",
  spells: "Заклинания",
  items: "Предметы",
  references: "Справочник",
  conditions: "Состояния",
};

export const SOURCE_LABEL = { builtin: "Встроенный", dev: "В разработке", installed: "Установлен" };

// mergeModules — записи каталога (GET /api/module-catalog) и модули сервера
// (GET /api/modules) одним списком: у записи каталога отметки установки
// уже есть, модули не из каталога (из файла, встроенные) добавляются как есть.
export function mergeModules(entries, installed) {
  const items = entries.map((e) => ({
    id: e.id,
    title: e.title,
    type: e.type,
    version: e.version,
    installedVersion: e.installed || "",
    updatable: !!e.updatable,
    compatible: e.compatible !== false,
    size: e.size || 0,
    description: e.description || "",
    author: e.author || "",
    license: e.license || "",
    systems: e.systems || [],
    requires: e.requires || [],
    minAppVersion: e.minAppVersion || "",
    inCatalog: true,
    source: "",
    counts: null,
  }));
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const m of installed) {
    const known = byId.get(m.id);
    if (known) {
      known.source = m.source;
      known.counts = m.counts || null;
      continue;
    }
    items.push({
      id: m.id,
      title: m.title,
      type: m.type,
      version: m.version,
      installedVersion: m.version,
      updatable: false,
      compatible: true,
      size: 0,
      description: m.description || "",
      author: m.author || "",
      license: m.license || "",
      systems: m.systems || [],
      requires: m.requires || [],
      minAppVersion: m.minAppVersion || "",
      inCatalog: false,
      source: m.source,
      counts: m.counts || null,
    });
  }
  return items;
}

// filterModules — tab: "available" | "installed"; kind: "all" | "system" |
// "content"; query — подстрока в названии, id и описании.
export function filterModules(items, { tab, kind, query }) {
  const q = (query || "").trim().toLowerCase();
  return items.filter((i) => {
    if (tab === "installed" ? !i.installedVersion : !i.inCatalog) return false;
    if (kind !== "all" && i.type !== kind) return false;
    if (!q) return true;
    return [i.title, i.id, i.description].some((s) => (s || "").toLowerCase().includes(q));
  });
}

// formatSize — размер архива человеческими словами.
export function formatSize(n) {
  if (!n) return "";
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} КБ`;
  return `${(n / (1024 * 1024)).toFixed(1).replace(".", ",")} МБ`;
}

// marks — отметки в списке: «Установлен», «Есть обновление», «Нужна новая программа».
export function marks(i) {
  const out = [];
  if (i.installedVersion) out.push({ text: i.updatable ? "Есть обновление" : "Установлен", kind: i.updatable ? "update" : "on" });
  if (!i.compatible) out.push({ text: "Нужно обновить программу", kind: "warn" });
  return out;
}

// canInstall — кнопка «Установить»/«Обновить» только для записей каталога,
// которых ещё нет или есть обновление, и подходящих этой программе.
export function canInstall(i) {
  return i.inCatalog && i.compatible && (!i.installedVersion || i.updatable);
}

// canRemove — удалять можно только то, что поставлено на сервер, а не
// встроенное и не папки разработки.
export const canRemove = (i) => i.source === "installed";
