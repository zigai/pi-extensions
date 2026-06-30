import { createRequire } from "node:module";

type TypeBoxSchemaModule = typeof import("typebox/schema");
type TypeBoxSchemaRuntime = TypeBoxSchemaModule["default"];

const requireFromTypeBoxSchemaFacade = createRequire(import.meta.url);
const loadedTypeBoxSchemaModule: unknown = requireFromTypeBoxSchemaFacade("typebox/schema");

// SAFETY: typebox declares the "./schema" package export, and Node's createRequire
// resolves that export correctly in pi's extension loader even when jiti mis-resolves
// a static `typebox/schema` import as `typebox/build/index.mjs/schema`.
const typeBoxSchemaModule = loadedTypeBoxSchemaModule as TypeBoxSchemaModule;

/** TypeBox Schema runtime loaded through Node's package export resolver for pi extension compatibility. */
const TypeBoxSchema: TypeBoxSchemaRuntime = typeBoxSchemaModule.default;

export default TypeBoxSchema;
