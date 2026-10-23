import { TuiMainScreen } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
    installKeyedLinkedMethodPatch,
    installLinkedMethodPatch,
    warnPiInternalPatchUnavailable,
} from "@zigai/pi-extension-internals";

const MAIN_SCREEN_SYNCHRONIZED_OUTPUT_PATCH = Symbol.for(
    "zigai.pi-ui-tweaks.main-screen-synchronized-output-patched",
);
const BEGIN_SYNCHRONIZED_OUTPUT = "\u001b[?2026h";
const END_SYNCHRONIZED_OUTPUT = "\u001b[?2026l";

type PatchableTerminal = {
    write(data: string): void;
    hideCursor?(): void;
    showCursor?(): void;
};

type PatchableMainScreen = {
    terminal?: PatchableTerminal;
};

type MainScreenPrototype = {
    doRender(this: PatchableMainScreen): void;
};

export type MainScreenSynchronizedOutputConfig = {
    readonly mainScreenSynchronizedOutput: boolean;
};

export type MainScreenSynchronizedOutputHandle = {
    update(config: MainScreenSynchronizedOutputConfig): void;
    dispose(): void;
};

const mainScreenSchema = Type.Object({ doRender: Type.Function([], Type.Void()) });
const mainScreenRuntime = {
    parse(value: unknown): MainScreenPrototype | undefined {
        if (!Value.Check(mainScreenSchema, value)) return undefined;

        return value;
    },
};

function withoutSynchronizedOutputControls(data: string): string {
    return data.replaceAll(BEGIN_SYNCHRONIZED_OUTPUT, "").replaceAll(END_SYNCHRONIZED_OUTPUT, "");
}

/** Includes final hardware-cursor updates in the regular-mode frame transaction. */
export function installMainScreenSynchronizedOutputPatch(
    config: MainScreenSynchronizedOutputConfig,
    target: MainScreenPrototype | null = mainScreenRuntime.parse(TuiMainScreen.prototype) ?? null,
): MainScreenSynchronizedOutputHandle {
    if (target === null) {
        warnPiInternalPatchUnavailable("pi-ui-tweaks", "main-screen synchronized output");

        return { update(): void {}, dispose(): void {} };
    }

    return installKeyedLinkedMethodPatch(
        target,
        "doRender",
        MAIN_SCREEN_SYNCHRONIZED_OUTPUT_PATCH,
        config,
        (predecessor, current) =>
            function synchronizedMainScreenRender(this: PatchableMainScreen): void {
                const terminal = this.terminal;
                if (!current().mainScreenSynchronizedOutput || terminal === undefined) {
                    predecessor.call(this);
                    return;
                }

                const originalWrite = terminal.write.bind(terminal);
                const frame = { started: false };
                let pendingControl = "";

                const startFrame = (): void => {
                    if (frame.started) return;

                    originalWrite(BEGIN_SYNCHRONIZED_OUTPUT);
                    frame.started = true;
                };

                const emit = (data: string): void => {
                    if (data.length === 0) return;

                    startFrame();
                    originalWrite(data);
                };

                const patches: Array<{ dispose(): void }> = [];

                try {
                    patches.push(
                        installLinkedMethodPatch(terminal, "write", () => (data) => {
                            const content = withoutSynchronizedOutputControls(
                                pendingControl + data,
                            );

                            pendingControl = "";
                            for (
                                let length = Math.min(
                                    BEGIN_SYNCHRONIZED_OUTPUT.length - 1,
                                    content.length,
                                );
                                length > 0;
                                length -= 1
                            ) {
                                const suffix = content.slice(-length);
                                if (BEGIN_SYNCHRONIZED_OUTPUT.startsWith(suffix)) {
                                    pendingControl = suffix;
                                    break;
                                }
                            }

                            emit(content.slice(0, content.length - pendingControl.length));
                        }),
                    );

                    for (const method of ["showCursor", "hideCursor"] as const) {
                        if (terminal[method] === undefined) continue;
                        patches.push(
                            installLinkedMethodPatch(
                                terminal,
                                method,
                                (previous) =>
                                    function () {
                                        emit(pendingControl);
                                        pendingControl = "";
                                        startFrame();
                                        previous.call(this);
                                    },
                            ),
                        );
                    }

                    predecessor.call(this);
                } finally {
                    try {
                        emit(pendingControl);
                    } finally {
                        for (const patch of patches.reverse()) patch.dispose();

                        if (frame.started) originalWrite(END_SYNCHRONIZED_OUTPUT);
                    }
                }
            },
    );
}
