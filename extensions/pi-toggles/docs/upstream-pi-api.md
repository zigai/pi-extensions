# Pi resource-control API needed by Pi Toggles

Pi Toggles controls tools and loaded skills with Pi's current public extension API. Complete extension slash-command control needs a source-qualified inventory and a pre-handler invocation gate. Prompt templates and extension loading are deliberately outside Pi Toggles' scope.

## Inactive resource inventory

Expose source-qualified slash commands, including commands unavailable through the current active command list:

```ts
pi.getAllCommands(): CommandInfo[];
```

Every entry needs a stable runtime ID, declared name, description, active state, command kind, and `SourceInfo`. IDs must remain unambiguous when commands collide.

## Runtime active sets

Expose extension-command visibility changes without rewriting Pi settings or reimplementing command resolution:

```ts
pi.setActiveCommands(ids: readonly string[]): void;
```

Pi Toggles already separates skill model visibility from user invocation with `systemPromptOptions.skills`, `formatSkillsForPrompt()`, and the pre-expansion `input` event.

## Invocation gate

Add a blockable event before extension-command handling:

```ts
pi.on("command_call", (event) => {
  // event.id: source-qualified resource ID
  // event.name, event.args, event.sourceInfo
  return { block: true, reason: "Disabled by policy" };
});
```

The event must run before the selected handler. Filtering autocomplete alone is not enforcement. Built-in Pi commands can remain explicitly excluded.

## Change events

Control-plane extensions need to observe state changed by presets and other extensions:

```ts
pi.on("active_tools_changed", (event) => {});
pi.on("resources_changed", (event) => {});
```

Events should identify the previous and current source-qualified active sets and the change source where available.

## Structured skill-prompt customization

Let `before_agent_start` return a structured options patch so skill filtering does not require replacing the block rendered by Pi's public formatter:

```ts
return {
  systemPromptOptions: {
    skills: filteredSkills,
  },
};
```

The current implementation remains on public API: it renders the original and policy-filtered sections with `formatSkillsForPrompt()` and replaces that exact section in the chained prompt.

## Source-qualified tool state

`setActiveTools()` currently uses names. A stable tool runtime ID would make state and diagnostics unambiguous when an extension overrides a built-in or another extension tool.

Until these contracts exist, Pi Toggles reports extension slash commands as unsupported and does not use private imports, monkey-patching, file renames, or cosmetic invocation controls.
