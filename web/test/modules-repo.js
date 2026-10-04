// Модули D&D живут в отдельном репозитории (BEACON_MODULES_REPO или соседняя
// папка beacon-table-modules); без него тесты на настоящем каталоге
// пропускаются.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = process.env.BEACON_MODULES_REPO || fileURLToPath(new URL("../../../beacon-table-modules", import.meta.url));
const modulesDir = join(repo, "modules");

export const hasModules = existsSync(modulesDir);
export const skipNoModules = hasModules ? {} : { skip: "репозиторий модулей не найден (BEACON_MODULES_REPO)" };

export const schemaJSON = (system, kind) => JSON.parse(readFileSync(join(modulesDir, system, "schemas", `${kind}.json`), "utf8"));

// cards — карточки вида kind (bestiary, spells, items, references) из всех модулей.
export function cards(kind) {
  const out = [];
  for (const mod of readdirSync(modulesDir)) {
    const dir = join(modulesDir, mod, kind);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (file.endsWith(".json")) out.push(JSON.parse(readFileSync(join(dir, file), "utf8")));
    }
  }
  return out;
}
