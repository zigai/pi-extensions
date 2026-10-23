import { Container, Text, stripTerminalSequences } from "@earendil-works/pi-tui";
import { TRANSCRIPT_PRESENTATION } from "@zigai/pi-extension-internals";
import { expect, it } from "vitest";
import {
    selectTranscriptBackend,
    transcriptBackends,
    type TranscriptSource,
} from "../src/transcript.ts";

it("renders ledger history without an optional presentation provider", () => {
    const native = new Container();
    native.addChild(new Text("Generic history", 0, 0));
    const source: TranscriptSource = {
        native,
        metadata: () => ({}),
        openEntry() {},
        metadataFields: { timestamp: false, duration: false, timeout: false },
    };
    selectTranscriptBackend("ledger");
    const ledger = transcriptBackends.current.create(source);
    try {
        expect(ledger.component.render(60).map(stripTerminalSequences).join("\n")).toContain(
            "Generic history",
        );
    } finally {
        ledger.dispose();
        selectTranscriptBackend("native");
    }
});

it("prepares ledger rendering and row heights without rendering or replacing retained source rows", () => {
    const native = new Container();
    const tool = new Text("first result\nmiddle result\nlast result", 0, 0);
    const reply = new Text("reply", 0, 0);
    native.addChild(tool);
    native.addChild(reply);
    native.render = () => {
        throw new Error("Hidden source rendering is forbidden");
    };
    const source: TranscriptSource = {
        native,
        metadata: () => ({}),
        openEntry() {},
        metadataFields: { timestamp: false, duration: false, timeout: false },
    };
    selectTranscriptBackend("ledger");
    let ledger = transcriptBackends.current.create(source);
    const toolLines = tool.render(60);
    try {
        Reflect.set(native, TRANSCRIPT_PRESENTATION, function (this: Container): void {
            if (this.children.at(-2) === tool && this.children.at(-1) === reply)
                reply.setText("separator\nreply");
        });

        expect(ledger.rows(60).at(-1)?.height).toBe(2);
        const cold = ledger.component.render(60);
        const text = cold.map(stripTerminalSequences).join("\n");
        expect(text).toContain("separator");
        expect(text).toContain("first result");
        expect(text).toContain("last result");
        ledger.dispose();
        selectTranscriptBackend("native");
        const view = transcriptBackends.current.create(source);
        expect(view.rows(60).map((row) => row.component)).toEqual([tool, reply]);
        view.dispose();
        selectTranscriptBackend("ledger");
        ledger = transcriptBackends.current.create(source);
        expect(ledger.component.render(60)).toEqual(cold);
        expect(native.children).toEqual([tool, reply]);
        expect(tool.render(60)).toEqual(toolLines);
    } finally {
        ledger.dispose();
        selectTranscriptBackend("native");
    }
});
