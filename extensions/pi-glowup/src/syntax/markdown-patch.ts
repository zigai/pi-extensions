import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { highlightSyntaxCode } from "./highlighter.ts";

const MARKDOWN_PATCH_KEY = Symbol.for("zigai.pi-codex-look.syntax-markdown");
const MARKDOWN_THEME_CACHE = new WeakMap<MarkdownTheme, MarkdownTheme>();

type MarkdownInstance = object;

type MarkdownPrototype = {
  render?: (this: MarkdownInstance, width: number) => string[];
  [MARKDOWN_PATCH_KEY]?: true;
};

/** Installs an idempotent Markdown render patch that injects the central syntax highlighter. */
export function installMarkdownSyntaxPatch(
  prototype: MarkdownPrototype = Markdown.prototype as unknown as MarkdownPrototype,
): void {
  if (prototype[MARKDOWN_PATCH_KEY] === true) {
    return;
  }

  const originalRender = prototype.render;
  prototype.render = function renderWithCodexLookSyntax(this: MarkdownInstance, width: number) {
    injectSyntaxTheme(this);
    return originalRender?.call(this, width) ?? [];
  };
  prototype[MARKDOWN_PATCH_KEY] = true;
}

function injectSyntaxTheme(instance: MarkdownInstance): void {
  if (isThinkingMarkdown(instance)) {
    return;
  }

  const theme = Reflect.get(instance, "theme");
  if (!isMarkdownTheme(theme)) {
    return;
  }

  const wrappedTheme = syntaxMarkdownTheme(theme);
  if (wrappedTheme !== theme) {
    Reflect.set(instance, "theme", wrappedTheme);
  }
}

function syntaxMarkdownTheme(theme: MarkdownTheme): MarkdownTheme {
  const cached = MARKDOWN_THEME_CACHE.get(theme);
  if (cached) {
    return cached;
  }

  const wrapped: MarkdownTheme = {
    ...theme,
    highlightCode(code: string, lang?: string): string[] {
      return highlightSyntaxCode(code, lang);
    },
  };
  MARKDOWN_THEME_CACHE.set(theme, wrapped);
  return wrapped;
}

function isThinkingMarkdown(instance: MarkdownInstance): boolean {
  const defaultTextStyle = Reflect.get(instance, "defaultTextStyle");
  return (
    typeof defaultTextStyle === "object" &&
    defaultTextStyle !== null &&
    Reflect.get(defaultTextStyle, "italic") === true
  );
}

function isMarkdownTheme(value: unknown): value is MarkdownTheme {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "codeBlock") === "function"
  );
}
