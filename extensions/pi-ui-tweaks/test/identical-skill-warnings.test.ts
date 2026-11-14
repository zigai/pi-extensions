import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    InteractiveMode,
    initTheme,
    loadSkills,
    type LoadSkillsResult,
    type ResourceDiagnostic,
} from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import { installLinkedMethodPatch } from "@zigai/pi-extension-internals";
import { afterEach, beforeEach, test } from "vitest";
import { identicalSkillBundles, skillComparisonBudget } from "../src/identical-skill-bundles.ts";
import { installIdenticalSkillWarningsPatch } from "../src/identical-skill-warnings.ts";
import { captureDiagnostics } from "./capture-diagnostics.ts";

initTheme("dark");
let directory: string;
let winner: string;
let loser: string;
const disposables: { dispose(): void }[] = [];
beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "pi-identical-skills-"));
    winner = join(directory, "project", "ebit");
    const actual = join(directory, "template", "ebit");
    loser = join(directory, "ancestor", "ebit");

    for (const root of [winner, actual]) {
        mkdirSync(join(root, "references"), { recursive: true });
        mkdirSync(join(root, "scripts"));
        writeFileSync(
            join(root, "SKILL.md"),
            "---\nname: ebit\ndescription: Test bundle\n---\nRead references/guide.md\n",
        );

        writeFileSync(join(root, "references", "guide.md"), "Reference\n");
        writeFileSync(join(root, "scripts", "run.sh"), "echo ok\n");
    }

    mkdirSync(join(directory, "ancestor"));
    symlinkSync(actual, loser, "dir");
});

afterEach(() => {
    for (const disposable of disposables.reverse()) disposable.dispose();
    disposables.length = 0;
    rmSync(directory, { recursive: true, force: true });
});

function loaded(): LoadSkillsResult {
    return loadSkills({
        cwd: directory,
        agentDir: join(directory, "agent"),
        includeDefaults: false,
        skillPaths: [winner, loser],
    });
}

function show(mode: ReturnType<typeof startup>["mode"]): void {
    const method: unknown = Object.getOwnPropertyDescriptor(
        InteractiveMode.prototype,
        "showLoadedResources",
    )?.value;
    if (typeof method === "function") method.call(mode, { showDiagnosticsWhenQuiet: true });
}

function startup(result: LoadSkillsResult) {
    const loader = {
        getSkills() {
            return result;
        },
        getPrompts: () => ({ prompts: [], diagnostics: [] }),
        getThemes: () => ({ themes: [], diagnostics: [] }),
        getExtensions: () => ({ extensions: [], errors: [] }),
    };
    const mode = {
        session: {
            resourceLoader: loader,
            extensionRunner: {
                getCommandDiagnostics: () => [],
                getShortcutDiagnostics: () => [],
            },
        },
        loadedResourcesContainer: new Container(),
        shouldShowStartupDetails: () => false,
        getBuiltInCommandConflictDiagnostics: () => [],
        formatDiagnostics: (diagnostics: ResourceDiagnostic[]) =>
            diagnostics.map((d) => d.message).join("\n"),
    };
    Object.setPrototypeOf(mode, InteractiveMode.prototype);

    return {
        mode,
        loader,
        render: () =>
            stripTerminalSequences(mode.loadedResourcesContainer.render(160).join("\n"))
                .split("\n")
                .map((line) => line.trimEnd())
                .join("\n"),
    };
}

function install() {
    const handle = installIdenticalSkillWarningsPatch({ hideIdenticalSkillWarnings: true });
    disposables.push(handle);
    return handle;
}

test("real loader still collides for copied bundles; real InteractiveMode presentation removes the entire header", () => {
    const result = loaded();
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0]?.filePath, join(winner, "SKILL.md"));
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0]?.type, "collision");
    const original = structuredClone(result);
    const { mode, loader, render } = startup(result);
    const descriptor = Object.getOwnPropertyDescriptor(loader, "getSkills");
    show(mode);
    assert.match(render(), /\[Skill warnings\]/);
    assert.match(render(), /name "ebit" collision/);
    const handle = install();
    show(mode);
    assert.doesNotMatch(render(), /\[Skill warnings\]|collision/);
    assert.deepEqual(Object.getOwnPropertyDescriptor(loader, "getSkills"), descriptor);
    assert.equal(loader.getSkills(), result);
    assert.deepEqual(result, original);
    assert.deepEqual(loaded(), original);
    handle.update({ hideIdenticalSkillWarnings: false });
    show(mode);
    assert.match(render(), /\[Skill warnings\]/);
    handle.update({ hideIdenticalSkillWarnings: true });
    show(mode);
    assert.doesNotMatch(render(), /\[Skill warnings\]/);
    handle.dispose();
    handle.dispose();
    show(mode);
    assert.match(render(), /\[Skill warnings\]/);
});

test("changed reference/script, missing/extra files, unreadable entries and nested symlinks preserve collisions", () => {
    const { mode, render } = startup(loaded());
    install();
    const reference = join(loser, "references", "guide.md");
    writeFileSync(reference, "Different\n");
    show(mode);
    assert.match(render(), /collision/);
    writeFileSync(reference, "Reference\n");
    writeFileSync(join(loser, "scripts", "run.sh"), "echo no\n");
    show(mode);
    assert.match(render(), /collision/);
    writeFileSync(join(loser, "scripts", "run.sh"), "echo ok\n");
    writeFileSync(join(loser, "extra"), "extra");
    show(mode);
    assert.match(render(), /collision/);
    rmSync(join(loser, "extra"));
    chmodSync(reference, 0);
    show(mode);
    assert.match(render(), /collision/);
    chmodSync(reference, 0o644);
    rmSync(reference);
    show(mode);
    assert.match(render(), /collision/);
    symlinkSync(join(winner, "references", "guide.md"), reference);
    show(mode);
    assert.match(render(), /collision/);
    rmSync(reference);
    writeFileSync(reference, "Reference\n");
    show(mode);
    assert.doesNotMatch(render(), /collision/);
});

test("mixed diagnostics retain real collisions, errors, warnings and other resource kinds in order", () => {
    const result = loaded();
    const collision = result.diagnostics[0];
    assert.ok(collision.collision);
    const real = {
        ...collision,
        collision: { ...collision.collision, loserPath: join(directory, "missing", "SKILL.md") },
    };
    const prompt = {
        ...collision,
        message: "prompt collision",
        collision: { ...collision.collision, resourceType: "prompt" as const },
    };
    const warning = { type: "warning" as const, message: "invalid name" };
    const error = { type: "error" as const, message: "load error" };
    result.diagnostics.push(real, warning, prompt, error);
    const { mode, render } = startup(result);
    install();
    show(mode);
    assert.match(
        render(),
        /\[Skill warnings\]\nname "ebit" collision\ninvalid name\nprompt collision\nload error/,
    );
    assert.equal(result.diagnostics.length, 5);
});

test("temporary getSkills wrapper restores inherited descriptors even when presentation throws", () => {
    const result = loaded();
    const original = function () {
        return result;
    };

    class Loader {
        getSkills(this: void): LoadSkillsResult {
            return original();
        }
    }

    const loader = new Loader();
    const inherited = loader.getSkills;
    const target = {
        session: { resourceLoader: loader },
        showLoadedResources() {
            assert.deepEqual(this.session.resourceLoader.getSkills().diagnostics, []);
            throw new Error("render failed");
        },
    };
    const handle = installIdenticalSkillWarningsPatch({ hideIdenticalSkillWarnings: true }, target);
    disposables.push(handle);
    assert.throws(() => target.showLoadedResources(), /render failed/);
    assert.equal(Object.hasOwn(loader, "getSkills"), false);
    assert.equal(loader.getSkills, inherited);
});

test("installer updates idempotently and reinstalls after disposal", () => {
    const before = Object.getOwnPropertyDescriptor(
        InteractiveMode.prototype,
        "showLoadedResources",
    );
    const first = install();
    const patched = Object.getOwnPropertyDescriptor(
        InteractiveMode.prototype,
        "showLoadedResources",
    );
    assert.equal(installIdenticalSkillWarningsPatch({ hideIdenticalSkillWarnings: false }), first);
    assert.deepEqual(
        Object.getOwnPropertyDescriptor(InteractiveMode.prototype, "showLoadedResources"),
        patched,
    );
    const { mode, render } = startup(loaded());
    show(mode);
    assert.match(render(), /collision/);
    first.dispose();
    assert.deepEqual(
        Object.getOwnPropertyDescriptor(InteractiveMode.prototype, "showLoadedResources"),
        before,
    );
    const second = install();
    assert.notEqual(second, first);
    show(mode);
    assert.doesNotMatch(render(), /collision/);
});

test("warning patch unlinks safely beneath another presentation patch", () => {
    const result = loaded();
    const seen: ResourceDiagnostic[][] = [];
    const target = {
        session: { resourceLoader: { getSkills: () => result } },
        showLoadedResources(): void {
            seen.push(this.session.resourceLoader.getSkills().diagnostics);
        },
    };
    const original = Object.getOwnPropertyDescriptor(target, "showLoadedResources");
    const handle = installIdenticalSkillWarningsPatch({ hideIdenticalSkillWarnings: true }, target);
    disposables.push(handle);
    const outer = installLinkedMethodPatch(
        target,
        "showLoadedResources",
        (previous) =>
            function () {
                previous.call(this);
            },
    );
    disposables.push(outer);
    target.showLoadedResources();
    assert.deepEqual(seen[0], []);
    handle.dispose();
    target.showLoadedResources();
    assert.equal(seen[1], result.diagnostics);
    outer.dispose();
    assert.deepEqual(Object.getOwnPropertyDescriptor(target, "showLoadedResources"), original);
});

test("frozen loader passes through unchanged", async () => {
    const diagnostics = await captureDiagnostics(() => {
        const result = loaded();
        const loader = Object.freeze({ getSkills: () => result });
        let seen: LoadSkillsResult | undefined;
        const target = {
            session: { resourceLoader: loader },
            showLoadedResources(): void {
                seen = this.session.resourceLoader.getSkills();
            },
        };
        const handle = installIdenticalSkillWarningsPatch(
            { hideIdenticalSkillWarnings: true },
            target,
        );
        try {
            target.showLoadedResources();
            assert.equal(seen, result);
        } finally {
            handle.dispose();
        }
    });
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0]?.message ?? "", /not patchable/);
});

test("missing host seams warn without preventing startup", async () => {
    const diagnostics = await captureDiagnostics(() => {
        installIdenticalSkillWarningsPatch({ hideIdenticalSkillWarnings: true }, null).dispose();
        let calls = 0;
        const target = {
            showLoadedResources() {
                calls += 1;
            },
        };
        const handle = installIdenticalSkillWarningsPatch(
            { hideIdenticalSkillWarnings: true },
            target,
        );
        try {
            target.showLoadedResources();
            target.showLoadedResources();
            assert.equal(calls, 2);
        } finally {
            handle.dispose();
        }
    });
    assert.equal(diagnostics.length, 2);
    assert.match(diagnostics[0]?.message ?? "", /missing showLoadedResources/);
    assert.match(diagnostics[1]?.message ?? "", /missing resourceLoader.getSkills/);
});

test("comparison limits fail closed, including loose Markdown skills", () => {
    const paths = [join(winner, "SKILL.md"), join(loser, "SKILL.md")] as const;
    assert.equal(identicalSkillBundles(...paths, skillComparisonBudget()), true);
    assert.equal(identicalSkillBundles(...paths, { entries: 1, bytes: 1024 }), false);
    assert.equal(identicalSkillBundles(...paths, { entries: 2048, bytes: 1 }), false);
    assert.equal(
        identicalSkillBundles(join(winner, "other.md"), paths[1], skillComparisonBudget()),
        false,
    );
});
