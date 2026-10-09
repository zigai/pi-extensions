import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installGlowup } from "./pi/lifecycle.ts";

export default function glowupExtension(pi: Pick<ExtensionAPI, "on">): void {
    installGlowup(pi);
}
