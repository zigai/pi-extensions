export const pierreDiffsRuntimeSource = [
  "cleanLastNewline",
  "getFiletypeFromFileName",
  "parseDiffFromFile",
  "parsePatchFiles",
  "renderDiffWithHighlighter",
  "setLanguageOverride",
]
  .map((name) => `export { ${name} } from "./utils/${name}.js";`)
  .join("\n");
