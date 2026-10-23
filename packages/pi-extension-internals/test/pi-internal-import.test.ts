import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import {
    bindExtensionDiagnostics,
    loadPiInternalModule,
    warnPiInternalPatchUnavailable,
} from "@zigai/pi-extension-internals";

type ThemeModuleView = {
    readonly theme: unknown;
};

type InstallationModuleView = {
    readonly installation: string;
};

function hasTheme(value: unknown): value is ThemeModuleView {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) {
        return false;
    }

    return "theme" in value && value.theme !== undefined;
}

function hasInstallation(value: unknown): value is InstallationModuleView {
    if (typeof value !== "object" || value === null || !("installation" in value)) {
        return false;
    }

    return typeof value.installation === "string";
}

async function captureWarnings(run: () => Promise<void> | void): Promise<string[]> {
    const warnings: string[] = [];
    const binding = bindExtensionDiagnostics({
        hasUI: true,
        ui: {
            notify(message) {
                warnings.push(message);
            },
        },
    });
    try {
        await run();
    } finally {
        binding.dispose();
    }

    return warnings;
}

test("formats Pi internal patch warnings with optional Error details", async () => {
    const warnings = await captureWarnings(() => {
        warnPiInternalPatchUnavailable("pi-example", "message patch");
        warnPiInternalPatchUnavailable("pi-example", "selector patch", new Error("export missing"));
        warnPiInternalPatchUnavailable("pi-example", "theme patch", "not an Error");
        warnPiInternalPatchUnavailable("pi-example", "empty error patch", new Error(""));
    });

    expect(warnings).toEqual([
        "[pi-example] message patch unavailable; Pi internals may have changed",
        "[pi-example] selector patch unavailable; Pi internals may have changed: export missing",
        "[pi-example] theme patch unavailable; Pi internals may have changed",
        "[pi-example] empty error patch unavailable; Pi internals may have changed",
    ]);
});

test("loads and parses a real Pi internal module through the guarded boundary", async () => {
    const warnings = await captureWarnings(async () => {
        const loaded = await loadPiInternalModule("modes/interactive/theme/theme.js", {
            scope: "pi-example",
            feature: "theme",
            parse(module: unknown): "loaded" | undefined {
                if (!hasTheme(module)) return undefined;
                return "loaded";
            },
        });
        expect(loaded).toBe("loaded");
    });

    expect(warnings).toEqual([]);
});

test("loads internals from the running Pi entrypoint instead of the extension dependency", async ({
    onTestFinished,
}) => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "pi-internal-host-"));
    const fixtureDirectory = join(
        fixtureRoot,
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
    );
    const bundleDirectory = join(fixtureDirectory, "dist", "bundle");
    const originalEntrypoint = process.argv[1];
    const originalPiFlag = process.env.PI_CODING_AGENT;
    const originalPackageDirectory = process.env.PI_PACKAGE_DIR;
    onTestFinished(async () => {
        process.argv[1] = originalEntrypoint;
        if (originalPiFlag === undefined) {
            delete process.env.PI_CODING_AGENT;
        } else {
            process.env.PI_CODING_AGENT = originalPiFlag;
        }

        if (originalPackageDirectory === undefined) {
            delete process.env.PI_PACKAGE_DIR;
        } else {
            process.env.PI_PACKAGE_DIR = originalPackageDirectory;
        }

        await rm(fixtureRoot, { recursive: true, force: true });
    });

    await mkdir(bundleDirectory, { recursive: true });
    await writeFile(
        join(fixtureDirectory, "package.json"),
        '{"name":"@earendil-works/pi-coding-agent","type":"module"}\n',
    );
    await writeFile(join(bundleDirectory, "cli.js"), "");
    await writeFile(
        join(fixtureDirectory, "dist", "host-probe.js"),
        'export const installation = "running-pi";\n',
    );
    process.argv[1] = join(bundleDirectory, "cli.js");
    process.env.PI_CODING_AGENT = "true";
    delete process.env.PI_PACKAGE_DIR;

    const loaded = await loadPiInternalModule("host-probe.js", {
        scope: "pi-example",
        feature: "host probe",
        parse(module: unknown): string | undefined {
            if (!hasInstallation(module)) return undefined;
            return module.installation;
        },
    });

    expect(loaded).toBe("running-pi");
});

test("reports parser rejection, parser failures, and missing Pi modules", async () => {
    const warnings = await captureWarnings(async () => {
        expect(
            await loadPiInternalModule("modes/interactive/theme/theme.js", {
                scope: "pi-example",
                feature: "rejected theme",
                parse: () => undefined,
            }),
        ).toBeUndefined();

        expect(
            await loadPiInternalModule("modes/interactive/theme/theme.js", {
                scope: "pi-example",
                feature: "broken parser",
                parse() {
                    throw new Error("invalid theme shape");
                },
            }),
        ).toBeUndefined();

        expect(
            await loadPiInternalModule("missing/internal-module.js", {
                scope: "pi-example",
                feature: "missing module",
                parse: () => "unreachable",
            }),
        ).toBeUndefined();
    });

    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toBe(
        "[pi-example] rejected theme unavailable; Pi internals may have changed",
    );

    expect(warnings[1]).toBe(
        "[pi-example] broken parser unavailable; Pi internals may have changed: invalid theme shape",
    );

    expect(warnings[2]).toContain(
        "[pi-example] missing module unavailable; Pi internals may have changed:",
    );
});

test("rejects internal module paths outside the coding-agent package", async () => {
    let parserCalls = 0;
    const warnings = await captureWarnings(async () => {
        const parse = (): string => {
            parserCalls += 1;
            return "unreachable";
        };
        expect(
            await loadPiInternalModule("../package.json", {
                scope: "pi-example",
                feature: "traversal module",
                parse,
            }),
        ).toBeUndefined();

        expect(
            await loadPiInternalModule("/tmp/outside.js", {
                scope: "pi-example",
                feature: "absolute module",
                parse,
            }),
        ).toBeUndefined();
    });

    expect(parserCalls).toBe(0);
    expect(warnings).toEqual([
        "[pi-example] traversal module unavailable; Pi internals may have changed: Pi internal module path escapes the coding-agent package",
        "[pi-example] absolute module unavailable; Pi internals may have changed: Pi internal module path must be relative to the coding-agent package",
    ]);
});
