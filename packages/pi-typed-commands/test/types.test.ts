import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defineTypedCommand } from "../src/index.js";

function expectType<T>(_value: T): void {}

void describe("compile-time API inference", () => {
    void it("preserves enum literals without as const and narrows parse results", () => {
        const command = defineTypedCommand({
            name: "type-demo",
            description: "Type inference demo",
            args: {
                env: { type: "enum", values: ["dev", "staging", "prod"], required: true },
                ref: { type: "string", default: "main" },
                tags: { type: "multi-enum", values: ["api", "web"] },
                count: { type: "number" },
            },
            run(args) {
                expectType<"dev" | "staging" | "prod">(args.env);
                expectType<string>(args.ref);
                expectType<Array<"api" | "web"> | undefined>(args.tags);
                expectType<number | undefined>(args.count);
            },
        });

        const parsed = command.parse("--env prod --tags api");

        assert.equal(parsed.status, "success");
        if (parsed.status === "success") {
            expectType<"dev" | "staging" | "prod">(parsed.value.env);
            expectType<string>(parsed.value.ref);
            assert.equal(parsed.value.env, "prod");
            assert.equal(parsed.value.ref, "main");
        }
    });
});
