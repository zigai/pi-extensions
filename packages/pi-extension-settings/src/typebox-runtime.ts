import * as typebox from "typebox";
import { Value as typeboxValue } from "typebox/value";

// Pi-facing runtime bundles retain these as externals in generated .ts entries, so Pi's loader
// supplies the host-owned TypeBox modules. Authoring/CLI code resolves the package peer normally.
export const Typebox: typeof import("typebox") = typebox;
export const IsSchema: typeof import("typebox").IsSchema = typebox.IsSchema;
export const Type: typeof import("typebox").Type = typebox.Type;
export const Value: typeof import("typebox/value").Value = typeboxValue;
