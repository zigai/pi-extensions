import { appendFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadReleasePackages, type ReleasePackage } from "./publish-workspace.ts";

/** Resolves scoped or unscoped package tags against actual independent workspace versions. */
export function selectReleasePackage(
    packages: readonly ReleasePackage[],
    tag: string,
): ReleasePackage {
    const separator = tag.lastIndexOf("@");
    if (separator <= 0) throw new Error(`Invalid package tag: ${tag}`);

    const name = tag.slice(0, separator);
    const version = tag.slice(separator + 1);
    const selected = packages.find((workspace) => workspace.name === name);
    if (selected === undefined || selected.private === true)
        throw new Error(`Unknown publishable workspace: ${name}`);
    if (selected.version !== version)
        throw new Error(`Tag version does not match ${name} manifest version`);
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version))
        throw new Error("Invalid release version");

    return selected;
}

const entry = process.argv.at(1);
if (entry !== undefined && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
    let tag = process.env.INPUT_TAG;
    if (tag === undefined || tag.length === 0) tag = process.env.REF_NAME;

    const output = process.env.GITHUB_OUTPUT;
    if (tag === undefined || output === undefined)
        throw new Error("Release selection requires a tag and GITHUB_OUTPUT");

    const selected = selectReleasePackage(loadReleasePackages(process.cwd()), tag);
    appendFileSync(output, `name=${selected.name}\ntag=${tag}\nversion=${selected.version}\n`);
}
