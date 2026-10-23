import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { expect, it } from "vitest";
import { getEditorDraftAdapter } from "../src/editor-draft.ts";
import { showStoredHistory } from "../src/history-browser.ts";
import { createHost } from "./support/host.ts";

it("closing stored history retains collapsed pastes and the complete native draft", async () => {
    const fixture = await createHost();
    try {
        fixture.session.appendMessage({ role: "user", content: "Stored sample", timestamp: 1 });
        const editor = fixture.host.editor;
        editor.setText("Draft α\nsecond line");
        editor.handleInput(
            `\u001b[200~${Array.from({ length: 14 }, (_, i) => `paste ${i}`).join("\n")}\u001b[201~`,
        );
        editor.handleInput("\u001b[A");
        fixture.renderer.renderNow(true);
        const adapter = getEditorDraftAdapter(editor);
        const before = adapter.capture();
        expect(before.document.pastes).toHaveLength(1);
        const browsing = showStoredHistory(fixture.ctx);
        await expect
            .poll(() => {
                fixture.renderer.renderNow(true);
                return fixture.renderer.getScreenLines().map(stripTerminalSequences).join("\n");
            })
            .toContain("Stored history");
        fixture.terminal.input?.("\u001b");
        await browsing;
        expect(adapter.capture()).toEqual(before);
    } finally {
        await fixture.dispose();
    }
});

it("history paging exposes every stored content line in the allocated full-screen viewport", async () => {
    const fixture = await createHost();
    try {
        const lines = Array.from({ length: 60 }, (_, i) => `row-${String(i + 1).padStart(2, "0")}`);
        const id = fixture.session.appendCustomEntry("sample-lines", { lines });
        const browsing = showStoredHistory(fixture.ctx, "", id);
        await expect
            .poll(() => {
                fixture.renderer.renderNow(true);
                return fixture.renderer.getScreenLines().map(stripTerminalSequences).join("\n");
            })
            .toContain("Stored history");
        const seen = new Set<string>();
        for (let page = 0; page < 8; page += 1) {
            fixture.renderer.renderNow(true);
            const screen = fixture.renderer.getScreenLines().map(stripTerminalSequences).join("\n");
            for (const match of screen.matchAll(/row-\d{2}/g)) seen.add(match[0]);
            fixture.terminal.input?.("\u001b[6~");
        }

        fixture.terminal.input?.("\u001b");
        await browsing;
        expect([...seen].sort()).toEqual(lines);
    } finally {
        await fixture.dispose();
    }
});
