import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { catalogKey, readCatalogs, saveCatalog, toCatalog, type Catalog } from "../src/catalog.ts";

const directories: string[] = [];

afterEach(async () => {
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true });
});

async function catalogsFile(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "pi-lazy-mcp-catalog-"));
    directories.push(directory);
    return join(directory, "catalogs.json");
}

const sample: Catalog = {
    instructions: "Use the sample tools",
    tools: [
        {
            name: "lookup",
            description: "Look up a sample",
            inputSchema: { type: "object", properties: { key: { type: "string" } } },
        },
    ],
};

describe("catalog store", () => {
    it("treats a missing file as having no catalogs", async () => {
        expect(readCatalogs(await catalogsFile())).toEqual(new Map());
    });

    it.each(["{ not json", "[]", '"text"', "null"])(
        "treats corrupt content %s as missing and replaces it on the next save",
        async (content) => {
            const path = await catalogsFile();
            await writeFile(path, content);

            expect(readCatalogs(path)).toEqual(new Map());

            saveCatalog(path, "sample:1", sample);
            expect(readCatalogs(path).get("sample:1")).toEqual(sample);
        },
    );

    it.each([
        ["a non-object", "text"],
        ["tools of the wrong type", { tools: "none" }],
        ["a tool without an input schema", { tools: [{ name: "lookup" }] }],
        [
            "duplicate tool names",
            {
                tools: [
                    { name: "lookup", inputSchema: {} },
                    { name: "lookup", inputSchema: {} },
                ],
            },
        ],
    ])(
        "counts an entry with %s as missing without losing its neighbours",
        async (_label, entry) => {
            const path = await catalogsFile();
            await writeFile(path, JSON.stringify({ "sample:bad": entry, "sample:good": sample }));

            const catalogs = readCatalogs(path);
            expect(catalogs.has("sample:bad")).toBe(false);
            expect(catalogs.get("sample:good")).toEqual(sample);
        },
    );

    it("merges with what another session wrote since this one last read", async () => {
        const path = await catalogsFile();
        saveCatalog(path, "first:1", sample);
        const other: Catalog = { tools: [] };
        await writeFile(
            path,
            JSON.stringify({ "first:1": sample, "second:1": other, "third:1": other }),
        );

        saveCatalog(path, "fourth:1", other);

        expect([...readCatalogs(path).keys()].sort()).toEqual([
            "first:1",
            "fourth:1",
            "second:1",
            "third:1",
        ]);
    });

    it("replaces the saved catalog of the same key", async () => {
        const path = await catalogsFile();
        saveCatalog(path, "sample:1", sample);
        saveCatalog(path, "sample:1", { tools: [] });
        expect(readCatalogs(path).get("sample:1")).toEqual({ tools: [] });
    });

    it("leaves only the complete file behind", async () => {
        const path = await catalogsFile();
        saveCatalog(path, "sample:1", sample);
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ "sample:1": sample });
        expect(await readdir(dirname(path))).toEqual(["catalogs.json"]);
    });

    it("leaves no temporary file when the final rename fails", async () => {
        const directory = dirname(await catalogsFile());
        const path = join(directory, "occupied");
        await mkdir(path);

        expect(() => {
            saveCatalog(path, "sample:1", sample);
        }).toThrow();

        expect(await readdir(directory)).toEqual(["occupied"]);
    });

    it("keeps the previous file when the directory refuses new files", async () => {
        const path = await catalogsFile();
        saveCatalog(path, "sample:1", sample);
        await chmod(dirname(path), 0o500);
        try {
            expect(() => {
                saveCatalog(path, "other:1", { tools: [] });
            }).toThrow();

            expect(readCatalogs(path).get("sample:1")).toEqual(sample);
            expect(readCatalogs(path).has("other:1")).toBe(false);
        } finally {
            await chmod(dirname(path), 0o700);
        }
    });

    it("creates a missing agent directory", async () => {
        const path = join(dirname(await catalogsFile()), "agent", "catalogs.json");
        saveCatalog(path, "sample:1", sample);
        expect(readCatalogs(path).get("sample:1")).toEqual(sample);
    });
});

describe("catalog keys", () => {
    const key = (name: string, config: Parameters<typeof catalogKey>[1]) =>
        catalogKey(name, config);

    it("changes with the server name, command, args, and url", () => {
        const keys = [
            key("sample", { command: "tool", args: ["serve"] }),
            key("other", { command: "tool", args: ["serve"] }),
            key("sample", { command: "tool2", args: ["serve"] }),
            key("sample", { command: "tool", args: ["run"] }),
            key("sample", { url: "http://127.0.0.1:1/mcp" }),
            key("sample", { url: "http://127.0.0.1:2/mcp" }),
        ];
        expect(new Set(keys).size).toBe(keys.length);
    });

    it("ignores settings that do not change which server runs", () => {
        expect(
            key("sample", {
                command: "tool",
                args: ["serve"],
                env: { TOKEN: "${SAMPLE_TOKEN}" },
                exposure: "direct",
                enabled: false,
                timeout: 5,
            }),
        ).toBe(key("sample", { command: "tool", args: ["serve"] }));
    });

    it("never carries configured values into the key", () => {
        expect(
            key("sample", { url: "http://127.0.0.1:1/mcp", headers: { Authorization: "secret" } }),
        ).not.toContain("secret");
    });
});

describe("catalogs from a server", () => {
    it("compares equal after a round trip through the file, so a saved catalog is not seen as stale", async () => {
        const path = await catalogsFile();
        const catalog = toCatalog(undefined, [
            {
                name: "lookup",
                title: "Lookup",
                description: "Look up a sample",
                inputSchema: { type: "object", properties: { nested: { type: "array" } } },
                annotations: { readOnlyHint: true },
            },
        ]);

        saveCatalog(path, "sample:1", catalog);

        expect(Object.keys(catalog)).toEqual(["tools"]);
        expect(readCatalogs(path).get("sample:1")).toStrictEqual(catalog);
    });

    it("drops optional fields of the wrong type instead of failing the server", () => {
        const catalog = toCatalog(undefined, [
            JSON.parse(
                '{"name":"lookup","inputSchema":{},"title":7,"outputSchema":null,"icons":[{}]}',
            ),
        ]);
        expect(catalog).toEqual({ tools: [{ name: "lookup", inputSchema: {} }] });
    });

    it("rejects duplicate tool names", () => {
        expect(() =>
            toCatalog(undefined, [
                { name: "lookup", inputSchema: {} },
                { name: "lookup", inputSchema: {} },
            ]),
        ).toThrow("duplicate");
    });

    it("trims instructions and treats blank ones as absent", () => {
        expect(toCatalog("  Use it  \n", []).instructions).toBe("Use it");
        expect(Object.keys(toCatalog("  ", []))).toEqual(["tools"]);
    });
});
