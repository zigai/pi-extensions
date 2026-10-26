import assert from "node:assert/strict";
import { getSelectListTheme, initTheme } from "@earendil-works/pi-coding-agent";
import {
    Container,
    Spacer,
    Text,
    stripTerminalSequences,
    visibleWidth,
} from "@earendil-works/pi-tui";
import { test } from "vitest";
import {
    installCompactStartupBootstrap,
    installCompactStartupPatch,
} from "../src/compact-startup.ts";
import { resolveUiTweaksConfig } from "../src/settings.ts";
import { captureDiagnostics } from "./capture-diagnostics.ts";

initTheme("dark");

class ExpandableText extends Text {
    expanded = false;

    setExpanded(expanded: boolean): void {
        this.expanded = expanded;
    }
}

function startup(customHeader?: Text) {
    const header = Object.assign(
        new ExpandableText(
            " \u001b[31m▀▄▀▄\u001b[0m v1.0\n \u001b[34m▄▀▄▀\u001b[0m old hints\nOnboarding",
            0,
            0,
        ),
        { onLogoClick(): void {} },
    );
    const section = new ExpandableText("[Skills]\n  resource details", 0, 0);
    const diagnostics = new Text("[Extension issues]\n  load failed\n[Skill conflicts]", 0, 0);

    let agents = [
        { path: "one", content: "" },
        { path: "two", content: "" },
    ];

    const mode = {
        customHeader,
        builtInHeader: header,
        version: "1.0",
        toolOutputExpanded: false,
        options: { verbose: false },
        settingsManager: { getQuietStartup: (): boolean => false },
        keybindings: { getKeys: (): string[] => ["ctrl+u"] },
        session: {
            resourceLoader: {
                getAgentsFiles: () => ({ agentsFiles: agents }),
                getSystemPromptSource: (): { path: string } | undefined => undefined,
                getAppendSystemPromptSources: (): { path: string }[] => [],
                getSkills: () => ({ skills: [{ name: "one" }, { name: "two" }] }),
                getExtensions: () => ({ extensions: [{}, {}, { hidden: true }] }),
            },
        },
        loadedResourcesContainer: new Container(),
        resourceSection: section,
        diagnostics,
        ui: { requestRender(): void {} },
        showLoadedResources(): void {
            this.loadedResourcesContainer.clear();
            this.loadedResourcesContainer.addChild(new Spacer(1));
            this.loadedResourcesContainer.addChild(this.resourceSection);
            this.loadedResourcesContainer.addChild(new Spacer(1));
            this.loadedResourcesContainer.addChild(this.diagnostics);
            this.loadedResourcesContainer.addChild(new Spacer(1));
        },
    };

    return {
        mode,
        header,
        section,
        setAgents: (next: typeof agents): void => {
            agents = next;
        },
    };
}

function text(lines: string[]): string {
    return lines.map((line) => stripTerminalSequences(line).trimEnd()).join("\n");
}

test("compact startup keeps colored logo and configured hints, counts actual non-hidden resources", () => {
    const { mode, header, setAgents } = startup();
    const click = header.onLogoClick;
    const handle = installCompactStartupPatch({ compactStartup: true }, mode);
    try {
        mode.showLoadedResources();
        assert.equal(header.onLogoClick, click);
        const lines = header.render(100);
        assert.ok(lines[0].includes("\u001b[31m"));
        assert.ok(lines[1].includes("\u001b[34m"));
        assert.ok(!text(lines).includes("Ready"));
        assert.equal(
            lines[3],
            getSelectListTheme().description("      Context 2 files · Skills 2 · Extensions 2"),
        );
        assert.deepEqual(text(lines).split("\n"), [
            " ▀▄▀▄ Pi v1.0",
            " ▄▀▄▀",
            "",
            "      Context 2 files · Skills 2 · Extensions 2",
            "",
            "      / commands · ! shell · ctrl+u details",
        ]);
        mode.session.resourceLoader.getSystemPromptSource = () => ({ path: "system" });
        mode.session.resourceLoader.getAppendSystemPromptSources = () => [{ path: "append" }];
        setAgents([{ path: "one", content: "" }]);
        mode.showLoadedResources();
        assert.match(text(header.render(100)), /Context 3 files/);

        for (let width = 0; width <= 80; width += 1) {
            for (const line of header.render(width))
                assert.ok(visibleWidth(line) <= width, `overflow at ${width}`);
        }
    } finally {
        handle.dispose();
    }
});

test("native expansion exposes help and resource sections while collapsed diagnostics remain visible", () => {
    const { mode, header, section } = startup();
    const originalHeader = header.render;
    const originalSetExpanded = header.setExpanded;
    const originalSection = section.render;
    const originalShow = mode.showLoadedResources;
    const handle = installCompactStartupPatch({ compactStartup: true }, mode);
    try {
        mode.showLoadedResources();
        assert.deepEqual(text(mode.loadedResourcesContainer.render(100)).split("\n"), [
            "[Extension issues]",
            "  load failed",
            "[Skill conflicts]",
            "",
        ]);

        header.setExpanded(true);

        for (const child of mode.loadedResourcesContainer.children) {
            if (child instanceof ExpandableText) child.setExpanded(true);
        }

        assert.match(text(header.render(100)), /Onboarding/);
        assert.match(text(mode.loadedResourcesContainer.render(100)), /resource details/);
        header.setExpanded(false);
        section.setExpanded(false);
        assert.doesNotMatch(text(header.render(100)), /Onboarding/);
        assert.doesNotMatch(text(mode.loadedResourcesContainer.render(100)), /resource details/);
        handle.update({ compactStartup: false });
        assert.match(text(header.render(100)), /Onboarding/);
        assert.match(text(mode.loadedResourcesContainer.render(100)), /resource details/);
        handle.update({ compactStartup: true });
        assert.equal(installCompactStartupPatch({ compactStartup: true }, mode), handle);
    } finally {
        handle.dispose();
        handle.dispose();
    }

    assert.equal(mode.showLoadedResources, originalShow);
    assert.equal(header.render, originalHeader);
    assert.equal(header.setExpanded, originalSetExpanded);
    assert.equal(section.render, originalSection);
    assert.equal(Object.hasOwn(header, "render"), false);
});

test("disabled, quiet startup and custom headers retain native rendering", () => {
    const { mode, header } = startup();
    const native = header.render(100);
    const handle = installCompactStartupPatch({ compactStartup: false }, mode);
    try {
        mode.showLoadedResources();
        assert.deepEqual(header.render(100), native);
        handle.update({ compactStartup: true });
        assert.match(text(header.render(100)), /Context/);
        mode.settingsManager.getQuietStartup = () => true;
        mode.showLoadedResources();
        assert.deepEqual(header.render(100), native);
        mode.settingsManager.getQuietStartup = () => false;
        mode.customHeader = new Text("custom");
        assert.deepEqual(header.render(100), native);
        mode.customHeader = undefined;
        assert.match(text(header.render(100)), /Context/);
    } finally {
        handle.dispose();
    }
});

test("text wordmark stays intact without a graphical logo", () => {
    const { mode } = startup();
    const header = new ExpandableText(" Pi v1.0\nold hints", 0, 0);
    const textMode = { ...mode, builtInHeader: header };
    const handle = installCompactStartupPatch({ compactStartup: true }, textMode);
    try {
        textMode.showLoadedResources();
        assert.equal(text(header.render(100)).split("\n")[0], " Pi v1.0");
        assert.match(text(header.render(100)), /Context/);
    } finally {
        handle.dispose();
    }
});

test("missing native startup targets warn without breaking startup", async () => {
    let calls = 0;
    const diagnostics = await captureDiagnostics(() => {
        const missing = installCompactStartupPatch({ compactStartup: true }, null);
        missing.dispose();
        const target = {
            showLoadedResources(): void {
                calls += 1;
            },
        };
        const original = target.showLoadedResources;
        const handle = installCompactStartupPatch({ compactStartup: true }, target);
        target.showLoadedResources();
        target.showLoadedResources();
        handle.dispose();
        assert.equal(target.showLoadedResources, original);
    });
    assert.equal(calls, 2);
    assert.equal(diagnostics.length, 2);
    assert.ok(diagnostics.every((diagnostic) => diagnostic.severity === "warning"));
});

test("shared native prototype and every instance restore after repeated startup rendering", () => {
    const first = startup();
    const second = startup();
    const prototype = { showLoadedResources: first.mode.showLoadedResources };
    const original = Object.getOwnPropertyDescriptor(prototype, "showLoadedResources");
    const modes = [first.mode, second.mode];
    for (const mode of modes) {
        Object.setPrototypeOf(mode, prototype);
        Reflect.deleteProperty(mode, "showLoadedResources");
    }

    const handle = installCompactStartupPatch({ compactStartup: true }, prototype);
    try {
        for (const mode of modes) {
            mode.showLoadedResources();
            mode.showLoadedResources();
            assert.match(text(mode.builtInHeader.render(100)), /Context/);
        }

        first.mode.options.verbose = true;
        first.mode.showLoadedResources();
        assert.match(text(first.header.render(100)), /Onboarding/);
        assert.match(text(first.mode.loadedResourcesContainer.render(100)), /resource details/);
    } finally {
        handle.dispose();
    }

    assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, "showLoadedResources"), original);

    for (const mode of modes) {
        assert.match(text(mode.builtInHeader.render(100)), /Onboarding/);
        assert.equal(Object.hasOwn(mode.builtInHeader, "render"), false);
    }
});

test("first mounted frame is compact before session_start and settings are handed off once", async () => {
    const { mode, header } = startup();
    const frames: string[] = [];
    let reads = 0;
    const loaded = resolveUiTweaksConfig([{ label: "test", settings: { compactStartup: true } }]);
    const container = {
        addChild(child: Text): void {
            frames.push(text(child.render(100)));
        },
    };
    const originalAdd = container.addChild;
    let late: ReturnType<typeof installCompactStartupPatch> | undefined;

    type BootstrapOwner = { bootstrap?: ReturnType<typeof installCompactStartupBootstrap> };

    const owner: BootstrapOwner = {};
    const firstFrameMode = {
        ...mode,
        sessionManager: { getCwd: () => "/project" },
        settingsManager: { ...mode.settingsManager, isProjectTrusted: () => true },
        headerContainer: container,
        async init(): Promise<void> {
            this.headerContainer.addChild(header);
            await Promise.resolve();
            assert.ok(owner.bootstrap);
            assert.equal(owner.bootstrap.readSettings("/project", true), loaded);
            late = installCompactStartupPatch(loaded.config, this);
            this.showLoadedResources();
        },
    };
    const originalInit = firstFrameMode.init;
    const bootstrap = installCompactStartupBootstrap(() => {
        reads += 1;
        return loaded;
    }, firstFrameMode);
    owner.bootstrap = bootstrap;
    try {
        await firstFrameMode.init();
        assert.equal(reads, 1);
        assert.match(frames[0], /Context 2 files/);
        assert.doesNotMatch(frames[0], /Ready|Onboarding|old hints/);
        assert.match(text(header.render(100)), /Context 2 files/);
        assert.equal(container.addChild, originalAdd);
    } finally {
        late?.dispose();
        bootstrap.dispose();
    }

    assert.equal(firstFrameMode.init, originalInit);
    assert.equal(Object.hasOwn(header, "render"), false);
});

test("first-frame hook respects disabled config and restores failed initializations", async () => {
    const { mode, header } = startup();
    const loaded = resolveUiTweaksConfig([{ label: "test", settings: { compactStartup: false } }]);
    let frame = "";
    const container = {
        addChild(child: Text): void {
            frame = text(child.render(100));
        },
    };
    const original = container.addChild;
    const initMode = {
        ...mode,
        sessionManager: { getCwd: () => "/project" },
        settingsManager: { ...mode.settingsManager, isProjectTrusted: () => false },
        headerContainer: container,
        async init(): Promise<void> {
            this.headerContainer.addChild(header);
            throw new Error("fixture init failure");
        },
    };
    const bootstrap = installCompactStartupBootstrap(() => loaded, initMode);
    try {
        await assert.rejects(initMode.init(), /fixture init failure/);
        assert.match(frame, /Onboarding/);
        assert.equal(container.addChild, original);
        assert.equal(Object.hasOwn(header, "render"), false);
    } finally {
        bootstrap.dispose();
    }
});

test("reload holds the compact presentation across old runtime disposal and adopts new counts", async () => {
    const { mode, header } = startup();
    const loaded = resolveUiTweaksConfig([{ label: "test", settings: { compactStartup: true } }]);
    let current: ReturnType<typeof installCompactStartupPatch> | undefined;
    const reloader = {
        ...mode,
        async init(): Promise<void> {},
        async handleReloadCommand(): Promise<void> {
            assert.ok(current);
            current.dispose();
            assert.doesNotMatch(text(header.render(100)), /Onboarding|old hints/);
            assert.doesNotMatch(
                text(this.loadedResourcesContainer.render(100)),
                /resource details/,
            );
            await Promise.resolve();
            current = installCompactStartupPatch(loaded.config, this);
            this.showLoadedResources();
        },
    };
    current = installCompactStartupPatch(loaded.config, reloader);
    reloader.showLoadedResources();
    const bootstrap = installCompactStartupBootstrap(() => loaded, reloader);
    try {
        bootstrap.readSettings("/project", true);
        await reloader.handleReloadCommand();
        assert.match(text(header.render(100)), /Context 2 files/);
        header.setExpanded(true);
        assert.match(text(header.render(100)), /Onboarding/);
    } finally {
        current?.dispose();
        bootstrap.dispose();
    }

    assert.equal(Object.hasOwn(header, "render"), false);
});
