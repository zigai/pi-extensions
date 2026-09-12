import { readFileSync } from "node:fs";
import Type from "typebox";
import { Value } from "typebox/value";
import { expect, it } from "vitest";

const dependencyMap = Type.Record(Type.String(), Type.String());
const manifestSchema = Type.Object({
    dependencies: Type.Optional(dependencyMap),
    devDependencies: Type.Optional(dependencyMap),
    peerDependencies: Type.Optional(dependencyMap),
    optionalDependencies: Type.Optional(dependencyMap),
});
const lockSchema = Type.Object({ packages: Type.Object({ "": manifestSchema }) });
const sections = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
] as const;

it.each(sections)("keeps manifest and lockfile root %s declarations identical", (section) => {
    const manifest = Value.Parse(
        manifestSchema,
        JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")),
    );
    const lock = Value.Parse(
        lockSchema,
        JSON.parse(readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8")),
    );

    expect(lock.packages[""][section] ?? {}).toEqual(manifest[section] ?? {});
});
