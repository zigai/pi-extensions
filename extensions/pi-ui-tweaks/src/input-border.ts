import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { styleText } from "@earendil-works/pi-tui";
import {
    installKeyedLinkedMethodPatch,
    warnPiInternalPatchUnavailable,
} from "@zigai/pi-extension-internals";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { UiTweaksConfig } from "./settings-input.ts";

type InputBorderConfig = Pick<UiTweaksConfig, "dimInputBorder">;

const editorBordersSchema = Type.Object({
    renderTopBorder: Type.Function([Type.Number(), Type.Number()], Type.String()),
    renderBottomBorder: Type.Function([Type.Number(), Type.Number()], Type.String()),
});

type EditorBorders = Static<typeof editorBordersSchema>;

export function installInputBorderPatch(config: InputBorderConfig) {
    const target: unknown = CustomEditor.prototype;
    if (!Value.Check(editorBordersSchema, target)) {
        warnPiInternalPatchUnavailable("pi-ui-tweaks", "input editor border rendering");

        return { update(): void {}, dispose(): void {} };
    }

    const patches = (["renderTopBorder", "renderBottomBorder"] as const).map((key) =>
        installKeyedLinkedMethodPatch(
            target,
            key,
            Symbol.for(`zigai.pi-ui-tweaks.input-border.${key}`),
            config,
            (predecessor, policy) =>
                function (this: EditorBorders, width, hiddenLineCount) {
                    const line = predecessor.call(this, width, hiddenLineCount);
                    if (!policy().dimInputBorder) return line;

                    return line.replace(/─+/gu, (rule) =>
                        styleText(rule, { dim: true }, "truecolor"),
                    );
                },
        ),
    );

    return {
        update(next: InputBorderConfig): void {
            for (const patch of patches) patch.update(next);
        },
        dispose(): void {
            for (const patch of patches) patch.dispose();
        },
    };
}
