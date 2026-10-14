// schemas.js — схемы листа и карточек системы мира (см. GET /api/schemas,
// internal/schema): по виду ("sheet", "monster", "spell", "item",
// "reference") — схема или null, если лист и карточки этой системы пока
// рисуются старым кодом (бланк D&D).
//
// Загрузка одна на страницу, как system-profile.js; рисует по схемам
// рендерер (блоки 3–4 задачи «Схемы листа и карточек»).
import { fetchSchemas } from "./api.js";

export const SCHEMA_KINDS = ["sheet", "monster", "spell", "item", "reference"];

let schemas = {};
let loading = null;

export function loadSchemas() {
  if (!loading) {
    loading = fetchSchemas()
      .then((s) => {
        schemas = s && typeof s === "object" ? s : {};
        return schemas;
      })
      .catch(() => schemas);
  }
  return loading;
}

// schemaFor — схема вида kind; null — рисовать старым кодом (или схемы ещё
// не загружены).
export function schemaFor(kind) {
  return schemas[kind] || null;
}
