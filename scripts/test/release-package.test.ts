import { expect, test } from "vitest";
import { selectReleasePackage } from "../release-package.ts";

const packages = [
    { name: "@test/extension", version: "1.2.3" },
    { name: "pi-typed-args", version: "0.1.1" },
    { name: "private", version: "1.0.0", private: true },
];

test.each([
    ["@test/extension@1.2.3", packages[0]],
    ["pi-typed-args@0.1.1", packages[1]],
] as const)("selects independent scoped and unscoped workspace tag %s", (tag, selected) => {
    expect(selectReleasePackage(packages, tag)).toEqual(selected);
});

test.each(["bad", "missing@1.0.0", "private@1.0.0", "pi-typed-args@0.1.0"])(
    "rejects unknown, private, or mismatched tag %s",
    (tag) => {
        expect(() => selectReleasePackage(packages, tag)).toThrow();
    },
);
