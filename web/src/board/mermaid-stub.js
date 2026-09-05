// Заглушка вместо @excalidraw/mermaid-to-excalidraw (см. resolve.alias в
// vite.config.js). Настоящий модуль тянет за собой mermaid целиком —
// cytoscape, katex, dagre и по чанку на вид диаграммы, 3,5 МБ в собранную
// статику, которая коммитится.
export function parseMermaidToExcalidraw() {
  throw new Error("Диаграммы mermaid на доске не поддерживаются.");
}
