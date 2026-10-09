import assert from "node:assert/strict";
import { test } from "vitest";
import {
    createMentionExpansion,
    createMentionSelections,
    expandMentionText,
    renderReplacementTemplate,
    type ExpansionSource,
} from "../src/mention-resolution.ts";
import type { Candidate } from "../src/source-contract.ts";

const session: Candidate = {
    id: "$1",
    label: "work",
    segment: "work",
    navigable: true,
    selectable: false,
};

const pane: Candidate = {
    id: "%7",
    label: "logs",
    segment: "logs",
    navigable: false,
    selectable: true,
    replacement: "tmux pane %7",
};

const source: ExpansionSource = {
    id: "tmux",
    trigger: "t:",
    separator: ":",
    async resolve(segments) {
        if (segments.join(":") === "work:logs")
            return { status: "resolved", path: [session, pane] };

        return { status: "unresolved", reason: "missing" };
    },
};

test("expands the complete chain once and leaves incomplete or missing targets literal", async () => {
    assert.equal(
        await expandMentionText("Use t:work:logs, leave t:work: and t:gone alone.", [source]),
        "Use tmux pane %7, leave t:work: and t:gone alone.",
    );
    assert.equal(
        await expandMentionText("t:work:logs", [{ ...source, replacement: () => "t:work:logs" }]),
        "t:work:logs",
    );
});

test("occurrence snapshots retain distinct selected IDs and discard edited targets", async () => {
    const selections = createMentionSelections();
    const text = "t:work:logs t:work:logs";
    selections.record(
        { sourceId: "tmux", start: 0, end: 11, text: "t:work:logs", path: [session, pane] },
        text,
    );
    selections.record(
        {
            sourceId: "tmux",
            start: 12,
            end: 23,
            text: "t:work:logs",
            path: [session, { ...pane, id: "%8", replacement: "tmux pane %8" }],
        },
        text,
    );
    const unavailable: ExpansionSource = {
        ...source,
        resolve: async () => ({ status: "unresolved", reason: "gone" }),
    };
    assert.equal(
        await expandMentionText(text, [unavailable], { snapshots: selections.snapshot(text) }),
        "tmux pane %7 tmux pane %8",
    );
    const edited = "t:other:logs t:work:logs";
    selections.reconcile(edited);
    assert.equal(
        await expandMentionText(edited, [unavailable], { snapshots: selections.snapshot(edited) }),
        "t:other:logs tmux pane %8",
    );
});

test("parenthesized selected occurrences survive surrounding prose edits", async () => {
    const selections = createMentionSelections();
    selections.record(
        { sourceId: "tmux", start: 1, end: 12, text: "t:work:logs", path: [session, pane] },
        "(t:work:logs ",
    );
    const text = "(t:work:logs )";
    const snapshots = selections.snapshot(text);
    assert.equal(snapshots.length, 1);
    assert.equal(
        await expandMentionText(text, [{ ...source, expansionPolicy: "selected-only" }], {
            snapshots,
        }),
        "(tmux pane %7 )",
    );
});

test("extending a selected token invalidates its occurrence snapshot", () => {
    const selections = createMentionSelections();
    selections.record(
        { sourceId: "tmux", start: 0, end: 11, text: "t:work:logs", path: [session, pane] },
        "t:work:logs",
    );

    assert.equal(selections.snapshot("t:work:logs:more").length, 0);
    selections.record(
        { sourceId: "tmux", start: 0, end: 11, text: "t:work:logs", path: [session, pane] },
        "t:work:logs",
    );

    assert.equal(selections.snapshot("t:work:logs.extra").length, 0);
});

test("ambiguous deletion of identical occurrences never transfers one selected identity to the other", () => {
    const selections = createMentionSelections();
    const text = "t:work:logs t:work:logs";
    selections.record(
        { sourceId: "tmux", start: 0, end: 11, text: "t:work:logs", path: [session, pane] },
        text,
    );
    selections.record(
        {
            sourceId: "tmux",
            start: 12,
            end: 23,
            text: "t:work:logs",
            path: [session, { ...pane, id: "%8" }],
        },
        text,
    );

    assert.equal(selections.snapshot("t:work:logs").length, 0);
});

test("selection-only and template expansion never serialize provider data", async () => {
    assert.equal(
        await expandMentionText("t:work:logs", [{ ...source, expansionPolicy: "selected-only" }]),
        "t:work:logs",
    );
    assert.equal(
        renderReplacementTemplate("Pane {{id}} at {{path}}", [
            session,
            { ...pane, data: { secret: "private" } },
        ]),
        "Pane %7 at work:logs",
    );
    assert.throws(() => renderReplacementTemplate("{{data.secret}}", [pane]), /undeclared field/);
});

test("custom terminal insertion text expands from its selected occurrence in one pass", async () => {
    const text = "inspect selected pane now";

    const snapshots = [
        { sourceId: "tmux", start: 8, end: 21, text: "selected pane", path: [session, pane] },
    ];
    assert.equal(
        await expandMentionText(text, [source], { snapshots }),
        "inspect tmux pane %7 now",
    );
});

test("large active contexts preserve every resolved target through rebuilds", async () => {
    const expansion = createMentionExpansion();
    const messages = Array.from({ length: 513 }, (_value, timestamp) => ({
        role: "user" as const,
        content: "t:work:logs",
        timestamp,
    }));
    const first = await expansion.messages(messages, [source]);
    const unavailable: ExpansionSource = {
        ...source,
        resolve: async () => ({ status: "unresolved", reason: "gone" }),
    };
    assert.deepEqual(await expansion.messages(structuredClone(messages), [unavailable]), first);
});

test("context rebuilding retains resolved submissions and preserves other message blocks", async () => {
    const expansion = createMentionExpansion();
    const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };

    const messages = [
        {
            role: "user" as const,
            timestamp: 1,
            content: [{ type: "text" as const, text: "t:work:logs" }, image],
        },
    ];

    const first = await expansion.messages(messages, [source]);
    assert.equal(first[0]?.role, "user");
    const unavailable: ExpansionSource = {
        ...source,
        resolve: async () => ({ status: "unresolved", reason: "gone" }),
    };
    assert.deepEqual(await expansion.messages(structuredClone(messages), [unavailable]), first);
    assert.deepEqual(messages[0]?.content[0], { type: "text", text: "t:work:logs" });
});
