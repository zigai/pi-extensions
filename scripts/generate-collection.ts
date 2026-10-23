import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { Value } from "typebox/value";

import {
    collectionResources,
    discoverWorkspacePackages,
    workspaceManifest,
} from "./workspace-packages.ts";

const storedManifest = Type.Object(
    {
        ...workspaceManifest.properties,
        pi: Type.Optional(
            Type.Object(workspaceManifest.properties.pi.properties, { additionalProperties: true }),
        ),
    },
    { additionalProperties: true },
);
const modeSchema = Type.Enum(["generate", "check"]);

export function generateCollectionManifests(root: string, mode: "generate" | "check"): void {
    const inventory = discoverWorkspacePackages(root, false);
    const resources = collectionResources(inventory.defaultExtensions);
    for (const collection of inventory.collections) {
        const file = path.join(collection.directory, "package.json");
        const original = readFileSync(file, "utf8");
        const manifest = Value.Parse(storedManifest, JSON.parse(original));
        manifest.dependencies = resources.dependencies;
        manifest.bundleDependencies = resources.bundleDependencies;
        manifest.pi = { ...manifest.pi, ...resources.pi };

        const next = `${JSON.stringify(manifest, null, 2)}\n`;
        if (next === original) continue;

        if (mode === "check")
            throw new Error(
                `Collection manifest is stale: ${file}; run npm run collection:generate`,
            );

        writeFileSync(file, next);
    }
}

const entry = process.argv.at(1);
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
    generateCollectionManifests(process.cwd(), Value.Parse(modeSchema, process.argv.at(2)));
}
