import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readLogPage } from "./log-pages.ts";
import { LogViewer } from "./log-viewer.ts";

let directory: string;
let path: string;
const viewers: LogViewer[] = [];

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "background-pages-"));
    path = join(directory, "output.log");
});

afterEach(async () => {
    for (const viewer of viewers.splice(0)) {
        viewer.dispose();
        await viewer.whenIdle();
    }

    await rm(directory, { recursive: true, force: true });
});

function viewerFor(
    options: { rows?: () => number; signal?: AbortSignal; close?: () => void } = {},
): LogViewer {
    const viewer = new LogViewer(path, "Background output", {
        rows: options.rows ?? (() => 12),
        requestRender: () => {},
        close: options.close ?? (() => {}),
        signal: options.signal,
    });
    viewers.push(viewer);

    return viewer;
}

it("traverses every retained UTF-8 byte exactly once, including multibyte page boundaries", async () => {
    for (const character of ["α", "界", "😀"]) {
        const text = `${"x".repeat(DEFAULT_MAX_BYTES - 1)}${character.repeat(DEFAULT_MAX_BYTES)}\nlast`;
        await writeFile(path, text);
        let actual = "";
        let end = 0;
        for (let index = 0; end < Buffer.byteLength(text); index += 1) {
            const page = await readLogPage(path, index);
            expect(page.start).toBe(end);
            expect(page.end - page.start).toBeLessThanOrEqual(DEFAULT_MAX_BYTES + 3);
            expect(page.text).not.toContain("�");
            actual += page.text;
            end = page.end;
        }

        expect(actual).toBe(text);
    }
});

it("End includes a final Unicode scalar crossing the last nominal page boundary", async () => {
    for (const character of ["α", "界", "😀"]) {
        await writeFile(path, `${"x".repeat(DEFAULT_MAX_BYTES - 1)}${character}`);
        const page = await readLogPage(path, "end");
        expect(page.text.endsWith(character)).toBe(true);
        expect(page.index).toBe(0);
        expect(page.count).toBe(1);
    }
});

it("refreshes growing and emptied logs without stale content", async () => {
    await writeFile(path, "initial");
    const viewer = viewerFor();
    await viewer.whenIdle();
    expect(viewer.render(80).join("\n")).toContain("initial");
    await writeFile(path, "x".repeat(DEFAULT_MAX_BYTES) + "new tail");
    viewer.handleInput("\u001b[F");
    await viewer.whenIdle();
    expect(viewer.render(80).join("\n")).toContain("new tail");
    await writeFile(path, "");
    viewer.handleInput("r");
    await viewer.whenIdle();
    const empty = viewer.render(80).join("\n");
    expect(empty).toContain("(no output)");
    expect(empty).not.toContain("new tail");
});

it("opens a sparse 3 GiB log, reaches its tail with End and returns Home with bounded pages", async () => {
    const file = await open(path, "w");
    const size = 3 * 1024 ** 3;
    try {
        await file.truncate(size);
        await file.write(Buffer.from("first marker\n"), 0, 13, 0);
        const tail = Buffer.from("\nlast marker 😀\n");
        await file.write(tail, 0, tail.length, size - tail.length);
    } finally {
        await file.close();
    }

    const viewer = viewerFor();
    expect(viewer.render(80).join("\n")).toContain("Loading log");
    await viewer.whenIdle();
    expect(viewer.render(80).join("\n")).toContain("first marker");
    viewer.handleInput("\u001b[F");
    expect(viewer.render(80).join("\n")).toContain("Loading log");
    await viewer.whenIdle();
    expect(viewer.render(80).join("\n")).toContain("last marker 😀");
    const tailPage = await readLogPage(path, "end");
    expect(tailPage.start).toBeGreaterThan(2 ** 31);
    expect(Buffer.byteLength(tailPage.text)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES + 3);
    viewer.handleInput("\u001b[H");
    expect(viewer.render(80).join("\n")).toContain("Loading log");
    await viewer.whenIdle();
    expect(viewer.render(80).join("\n")).toContain("first marker");
});

it("keeps all lines accessible with page navigation and scrolling and reflows on resize", async () => {
    await writeFile(
        path,
        `begin\n${"界😀 long line ".repeat(20)}\n${Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n")}\n${"z".repeat(DEFAULT_MAX_BYTES)}\nfinal`,
    );
    let rows = 10;
    const viewer = viewerFor({ rows: () => rows });
    await viewer.whenIdle();
    const first = viewer.render(30);
    expect(first.every((line) => visibleWidth(line) <= 30)).toBe(true);
    viewer.handleInput("\u001b[B");
    expect(viewer.render(30)).not.toEqual(first);
    rows = 6;
    viewer.invalidate();
    const resized = viewer.render(17);
    expect(resized.length).toBeLessThanOrEqual(rows);
    expect(resized.every((line) => visibleWidth(line) <= 17)).toBe(true);
    viewer.handleInput("\u001b[6~");
    await viewer.whenIdle();
    expect(viewer.render(80).join("\n")).toContain("Page 2/");
    viewer.handleInput("\u001b[5~");
    await viewer.whenIdle();
    expect(viewer.render(80).join("\n")).toContain("Page 1/");
});

it("scrolls through every line and renders an already loaded page without consulting the file", async () => {
    const lines = Array.from({ length: 80 }, (_, index) => `row ${index} α😀`);
    await writeFile(path, lines.join("\n"));
    const viewer = viewerFor({ rows: () => 4 });
    await viewer.whenIdle();
    await rm(path);
    const seen: string[] = [];
    for (let index = 0; index < lines.length; index += 1) {
        seen.push(viewer.render(80)[2]);
        viewer.handleInput("\u001b[B");
    }

    expect(seen).toEqual(lines);
    viewer.handleInput("r");
    await viewer.whenIdle();
    expect(viewer.render(80).join("\n")).toContain("Could not read log");
});

it("neutralizes terminal controls even when an escape sequence crosses a page boundary", async () => {
    await writeFile(
        path,
        `${"x".repeat(DEFAULT_MAX_BYTES - 1)}\u001b]52;c;payload\u0007\r\u009b31m\u001b[2J\nα😀`,
    );

    for (const index of [0, 1]) {
        const page = await readLogPage(path, index);
        expect(page.text.replace(/\n|\t/gu, "")).not.toMatch(/\p{Cc}/u);
    }

    const viewer = viewerFor();
    await viewer.whenIdle();
    viewer.handleInput("\u001b[F");
    await viewer.whenIdle();
    expect(viewer.render(80).join("\n")).toContain("α😀");
});

it("shows input errors instead of treating them as empty logs, and permits retry", async () => {
    const viewer = viewerFor();
    await viewer.whenIdle();
    expect(viewer.render(80).join("\n")).toContain("Could not read log");
    await writeFile(path, "recovered");
    viewer.handleInput("r");
    await viewer.whenIdle();
    expect(viewer.render(80).join("\n")).toContain("recovered");
    await expect(readLogPage(directory, 0)).rejects.toThrow("regular file");
});

it("coalesces navigation and closes pending reads without late renders or callbacks", async () => {
    await writeFile(path, "start\n" + "x".repeat(DEFAULT_MAX_BYTES * 3) + "\nend");
    let renders = 0;
    let closes = 0;
    const controller = new AbortController();
    const viewer = new LogViewer(path, "Output", {
        rows: () => 10,
        requestRender: () => {
            renders += 1;
        },
        close: () => {
            closes += 1;
        },
        signal: controller.signal,
    });
    viewers.push(viewer);

    for (let i = 0; i < 100; i += 1) viewer.handleInput("\u001b[F");
    viewer.handleInput("\u001b[H");
    await viewer.whenIdle();
    expect(viewer.render(80).join("\n")).toContain("start");
    viewer.handleInput("\u001b[F");
    controller.abort();
    const before = renders;
    await viewer.whenIdle();
    viewer.dispose();
    viewer.handleInput("q");
    expect(renders).toBe(before);
    expect(closes).toBe(1);
    expect(viewer.render(80)).toEqual([]);
});
