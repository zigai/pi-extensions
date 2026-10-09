import { Container, Loader, Spacer, Text, TuiMainScreen } from "@earendil-works/pi-tui";
import { describe, expect, it, onTestFinished } from "vitest";
import { VirtualTerminal } from "../support/virtual-terminal.ts";
import { configureWorkingWidgetSpacingPatch } from "../../src/pi/patches/working-widget-spacing.ts";

function installWorkingWidgetSpacingPatch(
    prototype: typeof Container.prototype = Container.prototype,
): void {
    configureWorkingWidgetSpacingPatch(true, prototype);
}

function createStaticLoader(message = "Working..."): Loader {
    const terminal = new VirtualTerminal(100, 40);
    const ui = new TuiMainScreen(terminal);
    const loader = new Loader(
        ui,
        (text) => text,
        (text) => text,
        message,
        { frames: ["⠋"] },
    );
    onTestFinished(() => {
        loader.stop();
        ui.stop();
        terminal.dispose();
    });

    return loader;
}

function unpad(lines: ReadonlyArray<string>): string[] {
    return lines.map((line) => line.trimEnd());
}

describe("working widget spacing patch", () => {
    it("removes Pi's empty above-editor spacer after a visible status loader", () => {
        const root = new Container();
        const statusContainer = new Container();
        const emptyAboveEditorWidgets = new Container();
        const editorContainer = new Container();

        statusContainer.addChild(createStaticLoader());
        emptyAboveEditorWidgets.addChild(new Spacer(1));
        editorContainer.addChild(new Text("chat box", 0, 0));

        root.addChild(statusContainer);
        root.addChild(emptyAboveEditorWidgets);
        root.addChild(editorContainer);

        installWorkingWidgetSpacingPatch();

        expect(unpad(root.render(80))).toEqual(["", " ⠋ Working...", "chat box"]);
    });

    it("keeps ordinary spacer containers that do not follow a status loader", () => {
        const root = new Container();
        const textContainer = new Container();
        const spacerContainer = new Container();
        const editorContainer = new Container();

        textContainer.addChild(new Text("ordinary widget", 0, 0));
        spacerContainer.addChild(new Spacer(1));
        editorContainer.addChild(new Text("chat box", 0, 0));

        root.addChild(textContainer);
        root.addChild(spacerContainer);
        root.addChild(editorContainer);

        installWorkingWidgetSpacingPatch();

        expect(unpad(root.render(80))).toEqual(["ordinary widget", "", "chat box"]);
    });

    it("keeps the loader spacing stable after repeat installation", () => {
        const root = new Container();
        const status = new Container();
        const spacer = new Container();
        status.addChild(createStaticLoader());
        spacer.addChild(new Spacer(1));
        root.addChild(status);
        root.addChild(spacer);
        root.addChild(new Text("chat box", 0, 0));

        installWorkingWidgetSpacingPatch();
        installWorkingWidgetSpacingPatch();

        expect(unpad(root.render(80))).toEqual(["", " ⠋ Working...", "chat box"]);
    });

    it("restores the original container render method when disabled", () => {
        class TestContainer extends Container {
            override render(_width: number): string[] {
                return ["original"];
            }
        }

        const prototype = TestContainer.prototype;
        configureWorkingWidgetSpacingPatch(true, prototype);
        configureWorkingWidgetSpacingPatch(false, prototype);

        expect(prototype.render(80)).toEqual(["original"]);
    });

    it("does not clobber container render wrappers installed later", () => {
        class TestContainer extends Container {
            override render(_width: number): string[] {
                return ["original"];
            }
        }

        const prototype = TestContainer.prototype;
        configureWorkingWidgetSpacingPatch(true, prototype);
        class PatchedContainer extends TestContainer {}

        const patchedPrototype = PatchedContainer.prototype;
        const patchedRenderDescriptor = Object.getOwnPropertyDescriptor(prototype, "render");
        if (patchedRenderDescriptor === undefined) {
            throw new Error("expected Glowup container render wrapper");
        }

        Object.defineProperty(patchedPrototype, "render", patchedRenderDescriptor);
        prototype.render = function renderWithLaterWrapper(
            this: Container,
            width: number,
        ): string[] {
            return ["foreign", ...patchedPrototype.render.call(this, width)];
        };
        configureWorkingWidgetSpacingPatch(false, prototype);

        expect(prototype.render(80)).toEqual(["foreign", "original"]);
    });
});
