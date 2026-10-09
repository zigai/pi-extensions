import assert from "node:assert/strict";
import { test } from "vitest";

import type { Component } from "@earendil-works/pi-tui";

import { installLiveFooter } from "../src/footer-transition.ts";
import type { PlainFooterTheme } from "../src/footer-rendering.ts";
import { DEFAULT_FOOTER_CONFIG } from "../src/settings.ts";
import type { FooterData } from "../src/footer-model.ts";

type TestTui = {
    requestRender(): void;
    setClearOnShrink(enabled: boolean): void;
};

type CapturedFooterFactory = (
    tui: TestTui,
    theme: PlainFooterTheme,
    footerData: FooterData,
) => Component;

test("live footer leaves native clear-on-shrink disabled", () => {
    let capturedFactory: CapturedFooterFactory | undefined;

    const ctx = {
        cwd: "/tmp/project",
        model: {
            provider: "test-provider",
            id: "test-model",
            contextWindow: 1000,
        },
        getContextUsage() {
            return undefined;
        },
        ui: {
            setFooter(factory: CapturedFooterFactory | undefined): void {
                capturedFactory = factory;
            },
        },
    };

    installLiveFooter(ctx, () => "medium", DEFAULT_FOOTER_CONFIG);

    if (capturedFactory === undefined) {
        assert.fail("expected footer factory to be registered");
    }

    let clearOnShrinkEnabled = false;
    const tui: TestTui = {
        requestRender() {},
        setClearOnShrink(enabled: boolean) {
            clearOnShrinkEnabled = enabled;
        },
    };
    const footerData: FooterData = {
        getGitBranch() {
            return "main";
        },
        getExtensionStatuses() {
            return new Map();
        },
        onBranchChange() {
            return () => {};
        },
    };

    capturedFactory(
        tui,
        {
            fg(_role, text) {
                return text;
            },
        },
        footerData,
    );

    assert.equal(clearOnShrinkEnabled, false);
});
