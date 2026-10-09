import { expect, test } from "vitest";
import {
    isPublishedOnNpm,
    loadReleasePackages,
    planWorkspacePublish,
    publishWorkspace,
    type ReleasePackage,
} from "../publish-workspace.ts";

const internals: ReleasePackage = { name: "@test/internals", version: "0.1.3" };
const anything: ReleasePackage = {
    name: "@test/anything",
    version: "0.1.0",
    dependencies: { [internals.name]: internals.version, external: "^1.0.0" },
};

const skill: ReleasePackage = {
    name: "@test/skill",
    version: "0.10.1",
    dependencies: { [anything.name]: anything.version, [internals.name]: internals.version },
};
const packages = [skill, internals, anything];

test("publishes missing prerequisites once, dependency first", async () => {
    const published: string[] = [];
    await publishWorkspace(packages, skill.name, {
        isPublished: async () => false,
        publish: async (workspace) => {
            published.push(workspace.name);
        },
    });
    expect(published).toEqual([internals.name, anything.name, skill.name]);
});

test("skips exact published versions, including an already published target", async () => {
    const published: string[] = [];
    await publishWorkspace(packages, skill.name, {
        isPublished: async (workspace) => workspace.name !== anything.name,
        publish: async (workspace) => {
            published.push(workspace.name);
        },
    });
    expect(published).toEqual([anything.name]);
});

test("preserves historical pins and includes optional runtime dependencies", () => {
    const target: ReleasePackage = {
        ...skill,
        dependencies: { [internals.name]: "0.1.0" },
        optionalDependencies: { [anything.name]: anything.version },
    };
    expect(
        planWorkspacePublish([internals, { ...anything, dependencies: {} }, target], skill.name),
    ).toEqual([{ ...anything, dependencies: {} }, target]);
});

test("optional dependencies override ordinary dependencies with the same name", () => {
    const target: ReleasePackage = {
        ...skill,
        dependencies: { [internals.name]: internals.version },
        optionalDependencies: { [internals.name]: "0.1.0" },
    };
    expect(planWorkspacePublish([internals, target], skill.name)).toEqual([target]);
});

test("rejects dependency cycles before registry operations", async () => {
    let registryCalls = 0;
    await expect(
        publishWorkspace(
            [{ ...internals, dependencies: { [anything.name]: anything.version } }, anything],
            anything.name,
            {
                isPublished: async () => {
                    registryCalls++;
                    return false;
                },
                publish: async () => {
                    throw new Error("must not publish");
                },
            },
        ),
    ).rejects.toThrow("dependency cycle");
    expect(registryCalls).toBe(0);
});

test("rejects unknown targets, private packages and unsupported local specs", () => {
    expect(() => planWorkspacePublish(packages, "missing")).toThrow("Unknown workspace");
    expect(() => planWorkspacePublish([{ ...internals, private: true }], internals.name)).toThrow(
        "private workspace",
    );

    expect(() =>
        planWorkspacePublish(
            [
                internals,
                {
                    ...anything,
                    dependencies: { [internals.name]: "^0.1.0" },
                },
            ],
            anything.name,
        ),
    ).toThrow("Expected exact workspace dependency");
});

test("registry errors stop publication", async () => {
    const error = new Error("registry unavailable");
    let published = false;
    await expect(
        publishWorkspace(packages, skill.name, {
            isPublished: async () => {
                throw error;
            },
            publish: async () => {
                published = true;
            },
        }),
    ).rejects.toBe(error);
    expect(published).toBe(false);
});

test("recovers a publication race only when the exact version now exists", async () => {
    const existing = new Set<string>();
    const attempts: string[] = [];
    await publishWorkspace(packages, skill.name, {
        isPublished: async (workspace) => existing.has(`${workspace.name}@${workspace.version}`),
        publish: async (workspace) => {
            attempts.push(workspace.name);
            existing.add(`${workspace.name}@${workspace.version}`);
            throw new Error("another workflow won");
        },
    });
    expect(attempts).toEqual([internals.name, anything.name, skill.name]);
});

test("waits for a staged prerequisite to become visible before publishing its consumer", async () => {
    let elapsed = 0;
    let staged = false;
    const attempts: string[] = [];
    await publishWorkspace(
        [internals, anything],
        anything.name,
        {
            isPublished: async (workspace) =>
                workspace.name === internals.name && staged && elapsed >= 30_000,
            publish: async (workspace) => {
                attempts.push(workspace.name);

                if (workspace.name === internals.name) {
                    staged = true;
                    throw new Error("Cannot publish over previously staged version");
                }

                expect(elapsed).toBeGreaterThanOrEqual(30_000);
            },
        },
        async (milliseconds) => {
            elapsed += milliseconds;
        },
    );
    expect(attempts).toEqual([internals.name, anything.name]);
});

test("stops waiting when the exact version never becomes visible", async () => {
    const error = new Error("publish failed");
    let elapsed = 0;
    await expect(
        publishWorkspace(
            [internals],
            internals.name,
            {
                isPublished: async () => false,
                publish: async () => {
                    throw error;
                },
            },
            async (milliseconds) => {
                elapsed += milliseconds;
            },
        ),
    ).rejects.toBe(error);
    expect(elapsed).toBeGreaterThan(0);
    expect(elapsed).toBeLessThanOrEqual(300_000);
});

test("propagates a genuine publish failure without publishing consumers", async () => {
    const error = new Error("publish denied");
    const attempts: string[] = [];
    await expect(
        publishWorkspace(
            packages,
            skill.name,
            {
                isPublished: async () => false,
                publish: async (workspace) => {
                    attempts.push(workspace.name);
                    throw error;
                },
            },
            async () => {},
        ),
    ).rejects.toBe(error);
    expect(attempts).toEqual([internals.name]);
});

test("a registry error after a failed publish cannot count as a successful race", async () => {
    let lookups = 0;
    await expect(
        publishWorkspace([internals], internals.name, {
            isPublished: async () => {
                if (lookups++ > 0) throw new Error("registry unavailable");
                return false;
            },
            publish: async () => {
                throw new Error("publish denied");
            },
        }),
    ).rejects.toThrow("registry unavailable");
});

test("public registry probe requests the exact scoped version without credentials", async () => {
    const request: typeof fetch = async (url, options) => {
        expect(url).toBe("https://registry.npmjs.org/%40test%2Finternals/0.1.3");
        expect(options?.headers).toEqual({ Accept: "application/json" });
        expect(options?.redirect).toBe("error");
        expect(options?.signal).toBeInstanceOf(AbortSignal);

        return Response.json(internals);
    };
    expect(await isPublishedOnNpm(internals, request)).toBe(true);
});

test("only HTTP 404 proves version absence", async () => {
    expect(await isPublishedOnNpm(internals, async () => new Response(null, { status: 404 }))).toBe(
        false,
    );

    for (const status of [401, 403, 429, 500, 503]) {
        await expect(
            isPublishedOnNpm(internals, async () => new Response(null, { status })),
        ).rejects.toThrow(`HTTP ${status}`);
    }

    await expect(
        isPublishedOnNpm(internals, async () => {
            throw new Error("network down");
        }),
    ).rejects.toThrow("network down");
});

test("a package document or another version does not prove publication", async () => {
    for (const response of [{ name: internals.name }, { ...internals, version: "0.1.0" }, {}]) {
        await expect(
            isPublishedOnNpm(internals, async () => Response.json(response)),
        ).rejects.toThrow("Unexpected registry response");
    }

    await expect(
        isPublishedOnNpm(internals, async () => new Response("invalid json")),
    ).rejects.toThrow(SyntaxError);
});

test("loads real workspace release metadata without tightening architecture fixtures", () => {
    const workspaces = loadReleasePackages(process.cwd());
    const target = workspaces.find((workspace) => workspace.name === "@zigai/pi-mention-anything");
    const dependency = workspaces.find(
        (workspace) => workspace.name === "@zigai/pi-extension-internals",
    );
    expect(dependency).toBeDefined();
    expect(target?.dependencies?.["@zigai/pi-extension-internals"]).toBe(dependency?.version);
    expect(
        planWorkspacePublish(workspaces, "@zigai/pi-mention-anything").map(
            (workspace) => workspace.name,
        ),
    ).toEqual([
        "@zigai/pi-extension-internals",
        "@zigai/pi-extension-settings",
        "@zigai/pi-mention-anything",
    ]);
});
