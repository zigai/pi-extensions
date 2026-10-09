import assert from "node:assert/strict";
import { test } from "vitest";

import { expandMentions, expandMentionsInMessages, formatMention } from "../src/api.ts";

type Candidate = {
    readonly name: string;
    readonly replacement?: string;
};

const candidates: Candidate[] = [
    { name: "staging", replacement: "environment:staging" },
    { name: "North America", replacement: "region:north-america" },
    { name: "plain" },
];

const options = {
    trigger: "%",
    items: candidates,
    nameOf: (candidate: Candidate) => candidate.name,
    replacementOf: (candidate: Candidate) => candidate.replacement ?? candidate.name,
};

test("formats arbitrary simple and quoted mention names", () => {
    assert.equal(formatMention("staging", "%"), "%staging");
    assert.equal(formatMention("North America", "%"), '%"North America"');
});

test("expands known mentions with per-item replacements and name defaults", () => {
    assert.equal(
        expandMentions('Deploy %staging, then notify %"North America" and %plain.', options),
        "Deploy environment:staging, then notify region:north-america and plain.",
    );
});

test("supports regex-significant multi-character triggers", () => {
    assert.equal(
        expandMentions("Deploy ++staging", { ...options, trigger: "++" }),
        "Deploy environment:staging",
    );
});

test("leaves unknown mentions unchanged", () => {
    assert.equal(expandMentions("Inspect %unknown", options), "Inspect %unknown");
});

test("only expands recent user context", () => {
    const messages = [
        { role: "user" as const, content: "Old %staging", timestamp: 1 },
        {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "Done" }],
            timestamp: 2,
            stopReason: "stop" as const,
            api: "openai-completions" as const,
            provider: "test",
            model: "test",
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
        },
        { role: "user" as const, content: "New %staging", timestamp: 3 },
    ];

    const expanded = expandMentionsInMessages(messages, options);
    assert.equal(expanded[0], messages[0]);
    const recent = expanded.at(2);
    assert.equal(recent?.role, "user");
    assert.equal(recent.content, "New environment:staging");
});
