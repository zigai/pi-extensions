import { describe, expect, it } from "vitest";
import { Type } from "typebox";

import type { JsonValue } from "../src/json-value.ts";
import { settingsValidationIssues, unsupportedSettingsKeyPath } from "../src/settings-layer.ts";

function messages(
    schema: Parameters<typeof settingsValidationIssues>[0],
    value: JsonValue,
): string[] {
    return settingsValidationIssues(schema, value).map((issue) => issue.message);
}

describe("safe settings validation issues", () => {
    it("projects common validator keywords to package-owned messages", () => {
        expect(messages(Type.String(), 1)).toContain("Setting has the wrong type");
        expect(messages(Type.Literal("a"), "b")).toContain(
            "Setting does not match the required value",
        );
        expect(messages(Type.Enum({ A: "a", B: "b" }), "c")).toContain(
            "Setting is not one of the allowed values",
        );
        expect(messages(Type.String({ format: "email" }), "invalid")).toContain(
            "Setting failed validation",
        );
        expect(messages(Type.Union([Type.String(), Type.Number()]), false)).toContain(
            "Setting does not match an allowed form",
        );
        expect(messages(Type.Number({ maximum: 2 }), 3)).toContain(
            "Number is above the allowed maximum",
        );
        expect(messages(Type.Number({ minimum: 2 }), 1)).toContain(
            "Number is below the allowed minimum",
        );
        expect(messages(Type.Array(Type.String(), { maxItems: 1 }), ["a", "b"])).toContain(
            "Array has too many items",
        );
        expect(messages(Type.Array(Type.String(), { minItems: 2 }), ["a"])).toContain(
            "Array has too few items",
        );
        expect(messages(Type.String({ maxLength: 1 }), "long")).toContain(
            "Text is longer than allowed",
        );
        expect(messages(Type.String({ minLength: 2 }), "a")).toContain(
            "Text is shorter than allowed",
        );
        expect(messages(Type.String({ pattern: "^a$" }), "b")).toContain(
            "Text does not match the required format",
        );
    });

    it("preserves declared paths and redacts dynamic record keys", () => {
        const schema = Type.Object(
            {
                profiles: Type.Record(
                    Type.String(),
                    Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false }),
                ),
            },
            { additionalProperties: false },
        );

        const issues = settingsValidationIssues(schema, {
            profiles: { "private-profile-name": { enabled: "wrong" } },
        });

        expect(issues).toContainEqual({
            path: "/profiles/<key>/enabled",
            message: "Setting has the wrong type",
        });
        expect(JSON.stringify(issues)).not.toContain("private-profile-name");
    });

    it("reports required and unexpected properties without exposing their values", () => {
        const schema = Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false });
        const issues = settingsValidationIssues(schema, { privateTypo: "private-value" });

        expect(issues.map((issue) => issue.message)).toEqual(
            expect.arrayContaining(["Unexpected setting", "Required setting is missing"]),
        );
        expect(JSON.stringify(issues)).not.toContain("privateTypo");
        expect(JSON.stringify(issues)).not.toContain("private-value");
    });
});

describe("unsupported settings keys", () => {
    it("finds prototype-sensitive keys recursively", () => {
        expect(unsupportedSettingsKeyPath({ safe: [{ constructor: true }] })).toBe(
            "/safe/0/constructor",
        );
        expect(unsupportedSettingsKeyPath({ safe: { prototype: true } })).toBe("/safe/prototype");
        expect(unsupportedSettingsKeyPath({ safe: true })).toBeUndefined();
    });
});
