import { createRequire } from "node:module";

type TypeBoxSchemaModule = typeof import("typebox/schema");
type TypeBoxSchemaRuntime = TypeBoxSchemaModule["default"];

// Pi's extension loader (1.6.0) aliases `typebox` to its own entry file, and jiti applies that alias
// as a prefix: a static `typebox/schema` import fails with "Cannot find module
// .../typebox/build/index.mjs/schema". Node's require resolves the package export instead.
const requireFromTypeBoxSchemaFacade = createRequire(import.meta.url);
const loadedTypeBoxSchemaModule: unknown = requireFromTypeBoxSchemaFacade("typebox/schema");

// SAFETY: Node resolved typebox's declared "./schema" export, which TypeBoxSchemaModule describes.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: Node resolved the declared package export, whose runtime namespace matches its published declaration.
const typeBoxSchemaModule = loadedTypeBoxSchemaModule as TypeBoxSchemaModule;
const TypeBoxSchema: TypeBoxSchemaRuntime = typeBoxSchemaModule.default;
export default TypeBoxSchema;
