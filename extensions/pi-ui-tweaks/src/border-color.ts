import { Theme } from "@earendil-works/pi-coding-agent";
import {
    installLinkedMethodPatch,
    type LinkedMethodPatchHandle,
} from "@zigai/pi-extension-internals";

const THEME_FG_PATCH = Symbol.for("zigai.pi-ui-tweaks.neutral-border-color-patch");

export type NeutralBorderColorConfig = { readonly neutralBorderColor: boolean };

export type NeutralBorderColorHandle = {
    update(config: NeutralBorderColorConfig): void;
    dispose(): void;
};

type ThemeInstance = { fg(color: string, text: string): string };

type ThemePrototype = {
    fg(this: ThemeInstance, color: string, text: string): string;
    [THEME_FG_PATCH]?: NeutralBorderPatchRecord;
};

type NeutralBorderPatchRecord = {
    readonly original: ThemePrototype["fg"];
    readonly patch: LinkedMethodPatchHandle<ThemeInstance, [string, string], string>;
    readonly handle: NeutralBorderColorHandle;
};

function isThemePrototype(value: unknown): value is ThemePrototype {
    return (
        typeof value === "object" &&
        value !== null &&
        "fg" in value &&
        typeof value.fg === "function"
    );
}

/** Installs or updates the neutral border-color patch. */
export async function installNeutralBorderColorPatch(
    config: NeutralBorderColorConfig,
): Promise<NeutralBorderColorHandle> {
    const prototype: unknown = Theme.prototype;
    if (!isThemePrototype(prototype)) {
        console.warn(
            "[pi-ui-tweaks] neutral border color patch unavailable; Pi internals may have changed",
        );

        return { update(): void {}, dispose(): void {} };
    }

    const installed = prototype[THEME_FG_PATCH];
    if (installed !== undefined) {
        installed.handle.update(config);
        return installed.handle;
    }

    let current = config;
    const patch = installLinkedMethodPatch(
        prototype,
        "fg",
        (predecessor) =>
            function neutralBorderFg(this: ThemeInstance, color: string, text: string): string {
                if (current.neutralBorderColor && (color === "border" || color === "borderMuted")) {
                    return predecessor.call(this, "text", text);
                }

                return predecessor.call(this, color, text);
            },
    );
    let disposed = false;
    const handle: NeutralBorderColorHandle = {
        update(next): void {
            if (!disposed) current = next;
        },
        dispose(): void {
            if (disposed) return;

            disposed = true;
            patch.dispose();

            if (prototype[THEME_FG_PATCH]?.handle === handle) delete prototype[THEME_FG_PATCH];
        },
    };

    prototype[THEME_FG_PATCH] = { original: patch.predecessor, patch, handle };
    return handle;
}
