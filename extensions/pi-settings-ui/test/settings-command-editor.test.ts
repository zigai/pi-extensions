import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorComponent, Focusable } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { SettingsCommandEditor } from "../src/settings-command-editor.ts";

class RecordingEditor implements EditorComponent, Focusable {
    private text = "";
    readonly inputs: string[] = [];
    focused = false;
    onSubmit?: (text: string) => void;
    onChange?: (text: string) => void;

    render(): string[] {
        return [this.text];
    }

    invalidate(): void {}

    handleInput(data: string): void {
        this.inputs.push(data);
    }

    getText(): string {
        return this.text;
    }

    setText(text: string): void {
        this.text = text;
        this.onChange?.(text);
    }
}

const submitKeys: Pick<KeybindingsManager, "matches"> = {
    matches(data, binding) {
        return binding === "tui.input.submit" && data === "\r";
    },
};

describe("reserved settings command editor", () => {
    it("opens extension settings before Pi handles its built-in /settings command", async () => {
        const base = new RecordingEditor();
        let opened = 0;
        const editor = new SettingsCommandEditor(
            base,
            submitKeys,
            async () => {
                opened += 1;
            },
            () => {},
        );
        editor.setText("/settings");
        editor.handleInput("\r");
        await Promise.resolve();

        expect(opened).toBe(1);
        expect(editor.getText()).toBe("");
        expect(base.inputs).toEqual([]);
    });

    it("delegates ordinary editor input unchanged", () => {
        const base = new RecordingEditor();
        const editor = new SettingsCommandEditor(
            base,
            submitKeys,
            async () => {},
            () => {},
        );
        editor.setText("/settings later");
        editor.handleInput("\r");

        expect(base.inputs).toEqual(["\r"]);
        expect(editor.getText()).toBe("/settings later");
    });
});
