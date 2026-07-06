import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type PackageJson = {
    readonly exports: Readonly<Record<string, unknown>> | undefined;
    readonly dependencies: Readonly<Record<string, string>> | undefined;
    readonly devDependencies: Readonly<Record<string, string>> | undefined;
    readonly peerDependencies: Readonly<Record<string, string>> | undefined;
    readonly peerDependenciesMeta:
        | Readonly<Record<string, { readonly optional?: boolean }>>
        | undefined;
};

function readPackageJson(): PackageJson {
    const value: unknown = JSON.parse(readFileSync("package.json", "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("package.json must contain an object");
    }

    return {
        exports: parseUnknownRecord(Reflect.get(value, "exports")),
        dependencies: parseStringRecord(Reflect.get(value, "dependencies")),
        devDependencies: parseStringRecord(Reflect.get(value, "devDependencies")),
        peerDependencies: parseStringRecord(Reflect.get(value, "peerDependencies")),
        peerDependenciesMeta: parseOptionalPeerMetaRecord(
            Reflect.get(value, "peerDependenciesMeta"),
        ),
    };
}

function parseUnknownRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const record: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
        record[key] = item;
    }
    return record;
}

function parseStringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }

    const record: Record<string, string> = {};
    for (const [key, item] of Object.entries(value)) {
        if (typeof item !== "string") {
            return undefined;
        }
        record[key] = item;
    }
    return record;
}

function parseOptionalPeerMetaRecord(
    value: unknown,
): Readonly<Record<string, { readonly optional?: boolean }>> | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }

    const record: Record<string, { readonly optional?: boolean }> = {};
    for (const [key, item] of Object.entries(value)) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
            return undefined;
        }
        const optional = Reflect.get(item, "optional");
        record[key] = typeof optional === "boolean" ? { optional } : {};
    }
    return record;
}

describe("package manifest", () => {
    it("exports the passive Codex-look protocol for extension authors", () => {
        const manifest = readPackageJson();

        expect(manifest.exports?.["./protocol"]).toBe("./src/tool-rendering/protocol.ts");
    });

    it("keeps Pi core packages as peers instead of bundled runtime dependencies", () => {
        const manifest = readPackageJson();
        const piCorePackages = [
            "@earendil-works/pi-coding-agent",
            "@earendil-works/pi-tui",
            "typebox",
        ];

        for (const packageName of piCorePackages) {
            expect(manifest.dependencies?.[packageName]).toBeUndefined();
            expect(manifest.peerDependencies?.[packageName]).toBe("*");
            expect(manifest.peerDependenciesMeta?.[packageName]?.optional).toBe(true);
        }
        expect(manifest.devDependencies?.typebox).toBeDefined();
    });
});
