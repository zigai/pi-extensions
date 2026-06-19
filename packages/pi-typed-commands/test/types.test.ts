import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    defineTypedCommand,
    enumArgument,
    group,
    multiEnumArgument,
    numberArgument,
    stringArgument,
} from "../src/index.js";

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

    void it("preserves literals in separately declared argument maps", () => {
        const args = {
            env: enumArgument(["dev", "prod"], { required: true }),
            ref: stringArgument({ default: "main" }),
            tags: multiEnumArgument(["api", "web"]),
        };

        const command = defineTypedCommand({
            name: "separate-args-demo",
            description: "Separate args demo",
            args,
            run(values) {
                expectType<"dev" | "prod">(values.env);
                expectType<string>(values.ref);
                expectType<Array<"api" | "web"> | undefined>(values.tags);
            },
        });
        const parsed = command.parse("--env dev --tags api");

        assert.equal(parsed.status, "success");
    });

    void it("infers nested grouped handler values", () => {
        const command = defineTypedCommand({
            name: "grouped-type-demo",
            description: "Grouped type demo",
            args: {
                database: group({
                    host: stringArgument({ required: true }),
                    port: numberArgument(),
                }),
            },
            run(values) {
                expectType<string>(values.database.host);
                expectType<number | undefined>(values.database.port);
            },
        });
        const parsed = command.parse("--database-host localhost --database-port 5432");

        assert.equal(parsed.status, "success");
        if (parsed.status === "success") {
            expectType<string>(parsed.value.database.host);
            assert.equal(parsed.value.database.host, "localhost");
        }
    });

    void it("types required, defaulted, optional, multi, and refinement paths", () => {
        const command = defineTypedCommand({
            name: "type-coverage-demo",
            description: "Type coverage demo",
            args: {
                start: numberArgument({ required: true }),
                end: numberArgument(),
                ref: stringArgument({ default: "main" }),
                labels: multiEnumArgument(["bug", "feature"], { required: true }),
            },
            refine(args, context) {
                expectType<number | undefined>(args.start);
                expectType<number | undefined>(args.end);
                expectType<string | undefined>(args.ref);
                expectType<Array<"bug" | "feature"> | undefined>(args.labels);
                expectType<ReadonlySet<"start" | "end" | "ref" | "labels">>(context.provided);
                return [];
            },
            run(values) {
                expectType<number>(values.start);
                expectType<number | undefined>(values.end);
                expectType<string>(values.ref);
                expectType<Array<"bug" | "feature">>(values.labels);
            },
        });
        const parsed = command.parse("--start 1 --labels bug");
        const invalid = command.parse("--start bad");

        if (invalid.status === "error") {
            expectType<number | undefined>(invalid.partial.start);
        }
        assert.equal(parsed.status, "success");
        if (parsed.status === "success") {
            expectType<number>(parsed.value.start);
            expectType<Array<"bug" | "feature">>(parsed.value.labels);
        }
    });
});
