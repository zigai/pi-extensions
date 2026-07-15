import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
    type ArgumentDefinitions,
    defineTypedCommand,
    enumArgument,
    group,
    type MultiArgumentValue,
    multiEnumArgument,
    numberArgument,
    parseTypedCommandArgs,
    stringArgument,
    toTypedParseResult,
} from "../src/index.js";
import { compileTypedCommandDefinition } from "../src/compiler.js";

function expectType<T>(_value: T): void {}

describe("compile-time API inference", () => {
    it("preserves enum literals without as const and narrows parse results", () => {
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
                expectType<readonly ("api" | "web")[] | undefined>(args.tags);
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

    it("preserves literals in separately declared argument maps", () => {
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
                expectType<readonly ("api" | "web")[] | undefined>(values.tags);
            },
        });
        const parsed = command.parse("--env dev --tags api");

        assert.equal(parsed.status, "success");
    });

    it("infers nested grouped handler values", () => {
        const command = defineTypedCommand({
            name: "grouped-type-demo",
            description: "Grouped type demo",
            args: {
                database: group({
                    host: stringArgument({ required: true }),
                    port: numberArgument(),
                }),
            },
            refine(_values, context) {
                expectType<ReadonlySet<"database.host" | "database.port">>(context.provided);
                return [];
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

    it("types required, defaulted, optional, multi, and refinement paths", () => {
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
                expectType<readonly ("bug" | "feature")[] | undefined>(args.labels);
                expectType<ReadonlySet<"start" | "end" | "ref" | "labels">>(context.provided);
                return [];
            },
            run(values) {
                expectType<number>(values.start);
                expectType<number | undefined>(values.end);
                expectType<string>(values.ref);
                expectType<readonly ("bug" | "feature")[]>(values.labels);
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
            expectType<readonly ("bug" | "feature")[]>(parsed.value.labels);
        }
    });

    it("rejects invalid public contracts at compile time", () => {
        const assertPublicContracts = (): void => {
            const dynamicRequired = Math.random() > 0.5;
            stringArgument({ required: dynamicRequired });

            // @ts-expect-error required arguments cannot also define defaults.
            stringArgument({ required: true, default: "main" });
            // @ts-expect-error dynamic requiredness cannot be combined with defaults.
            stringArgument({ required: dynamicRequired, default: "main" });
            // @ts-expect-error enum factories preserve required/default exclusivity.
            enumArgument(["dev", "prod"], { required: true, default: "dev" });
            // @ts-expect-error enum factories reject dynamic requiredness with defaults.
            enumArgument(["dev", "prod"], { required: dynamicRequired, default: "dev" });
            // @ts-expect-error multi-enum factories preserve required/default exclusivity.
            multiEnumArgument(["api", "web"], { required: true, default: ["api"] });
            // @ts-expect-error multi-enum factories reject dynamic requiredness with defaults.
            multiEnumArgument(["api", "web"], {
                required: dynamicRequired,
                default: ["api"],
            });

            defineTypedCommand({
                name: "invalid-contract-demo",
                description: "Invalid contract demo",
                args: {
                    // @ts-expect-error required arguments cannot also define defaults.
                    bad: { type: "string", required: true, default: "main" },
                },
                run() {},
            });

            const multiIsReadonly: MultiArgumentValue extends unknown[] ? false : true = true;
            void multiIsReadonly;

            const definitions: ArgumentDefinitions = {
                env: enumArgument(["dev", "prod"], { required: true }),
            };
            // @ts-expect-error public definition maps are readonly.
            definitions.ref = stringArgument();

            const actualArgs = { count: numberArgument({ required: true }) };
            const unrelatedArgs = { branch: stringArgument({ required: true }) };
            const compiled = compileTypedCommandDefinition({
                name: "actual-grammar",
                description: "Actual grammar",
                args: actualArgs,
            });
            if (compiled.ok) {
                const parsed = parseTypedCommandArgs(
                    { args: compiled.command.args, compiled: compiled.command },
                    "--count 2",
                );
                // @ts-expect-error conversion cannot select definitions unrelated to its grammar.
                toTypedParseResult<typeof unrelatedArgs>(compiled.command, parsed);
            }
        };
        void assertPublicContracts;

        assert.ok(true);
    });
});
