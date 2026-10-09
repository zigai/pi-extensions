import assert from "node:assert/strict";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";

import { installModelStatusPatch } from "../src/model-status.ts";
import { captureConsoleWarnings } from "./capture-console-warnings.ts";

function statusMode() {
    const renderRequests = new Array<boolean | undefined>();
    const statuses = new Array<string>();

    return {
        renderRequests,
        statuses,
        showStatus: (message: string): void => {
            statuses.push(message);
        },
        ui: {
            requestRender(force?: boolean): void {
                renderRequests.push(force);
            },
        },
    };
}

test("explicit null does not patch Pi's default model status", async () => {
    const warnings = await captureConsoleWarnings(() => {
        const original = Object.getOwnPropertyDescriptor(InteractiveMode.prototype, "showStatus");
        const handle = installModelStatusPatch({ hideModelChangeStatus: true }, null);

        assert.deepEqual(
            Object.getOwnPropertyDescriptor(InteractiveMode.prototype, "showStatus"),
            original,
        );

        handle.dispose();
    });

    assert.deepEqual(warnings, [
        "[pi-ui-tweaks] model status patch unavailable; Pi internals may have changed: missing showStatus",
    ]);
});

test("model-change status suppression updates without stacking", () => {
    const target = statusMode();
    const handle = installModelStatusPatch({ hideModelChangeStatus: true }, target);
    const patched = target.showStatus;
    installModelStatusPatch({ hideModelChangeStatus: false }, target);
    assert.equal(target.showStatus, patched);
    target.showStatus("Model: deepseek-v4-flash");
    assert.deepEqual(target.statuses, ["Model: deepseek-v4-flash"]);
    handle.update({ hideModelChangeStatus: true });
    target.showStatus("Model: gpt-5");
    assert.deepEqual(target.statuses, ["Model: deepseek-v4-flash"]);
    assert.deepEqual(target.renderRequests, [undefined]);
    handle.dispose();
});
