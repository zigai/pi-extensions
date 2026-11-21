import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ArgumentFormUi = Pick<ExtensionContext["ui"], "custom" | "input" | "notify" | "select">;

export type ArgumentFormContext = {
    readonly mode: ExtensionContext["mode"];
    readonly ui: ArgumentFormUi;
};
