import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorComponent, Focusable } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { createSettingsCommandEditor } from "../src/settings-command-editor.ts";

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
        const editor = createSettingsCommandEditor(
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

    it("preserves an independently registered editor capability", () => {
        const base = new RecordingEditor();
        const capability = Symbol.for("test.editor.document");
        let captured = "";
        Object.defineProperty(base, capability, {
            value: () => {
                captured = base.getText();
            },
        });
        const editor = createSettingsCommandEditor(
            base,
            submitKeys,
            async () => {},
            () => {},
        );
        editor.setText("sample draft");
        const external: unknown = Object.getOwnPropertyDescriptor(editor, capability)?.value;
        Value.Parse(Type.Function([], Type.Void()), external)();
        expect(captured).toBe("sample draft");
    });

    it("delegates ordinary editor input unchanged", () => {
        const base = new RecordingEditor();
        const editor = createSettingsCommandEditor(
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
