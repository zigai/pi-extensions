import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerGoalRuntimeController } from "./goal-runtime-controller.ts";

export { __testHooks } from "./runtime-config.ts";

export default function (pi: ExtensionAPI): void {
  registerGoalRuntimeController(pi);
}
