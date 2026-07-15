import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Minimal UI capabilities consumed by dense and sequential argument forms. */
export type ArgumentFormUi = Pick<
    ExtensionContext["ui"],
    "custom" | "input" | "notify" | "select"
>;

/** Library-owned form seam adapted from a Pi context at the caller boundary. */
export type ArgumentFormContext = {
    readonly mode: ExtensionContext["mode"];
    readonly ui: ArgumentFormUi;
};
