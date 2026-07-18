import assert from "node:assert/strict";
import { test } from "vitest";

import { getTypedCommands } from "pi-typed-args/pi";

import { createRuntimeHarness } from "./support/runtime-harness.js";

test("/goal accepts -r before free-form text and rejects inline expanded-form options", async () => {
  const rawHarness = createRuntimeHarness();
  await rawHarness.runCommand("-r Preserve this exact objective");
  assert.equal(rawHarness.snapshot().goal?.objective, "Preserve this exact objective");
  assert.equal(rawHarness.snapshot().goal?.minimumActiveSeconds, null);
  assert.equal(rawHarness.snapshot().goal?.maximumActiveSeconds, null);

  for (const inline of [
    "--min-time 15 Build and verify",
    "--max-time 60 Build and verify",
    "--minimum-time-minutes 15 Build and verify",
    "--maximum-time-minutes 60 Build and verify",
    "--disabled-tools ask_user_question Build and verify",
    "--enabled-tools web_run Build and verify",
    "--adjust-existing Build and verify",
  ]) {
    const inlineHarness = createRuntimeHarness();
    await inlineHarness.runCommand(inline);
    assert.equal(inlineHarness.snapshot().goal, null, inline);
    assert.equal(inlineHarness.sentMessages.length, 0, inline);
    assert.equal(inlineHarness.sentUserMessages.length, 0, inline);
  }
});

test("/goal registers a flat arrow-navigable form without tool controls", () => {
  const before = new Set(getTypedCommands());
  createRuntimeHarness();
  const command = getTypedCommands().find((candidate) => {
    if (before.has(candidate)) {
      return false;
    }
    return candidate.name === "goal" && candidate.args.task?.ui?.widget === "text";
  });
  assert.ok(command);

  assert.equal(command.args.disabledTools, undefined);
  assert.equal(command.args.enabledTools, undefined);
  assert.equal(command.args.adjustedDisabledTools, undefined);
  assert.equal(command.args.adjustedEnabledTools, undefined);

  for (const definition of Object.values(command.args)) {
    assert.equal(definition.ui?.section, undefined);
    assert.notEqual(definition.ui?.advanced, true);
  }

  const raw = command.args.raw;
  assert.ok(raw);
  assert.equal(raw?.ui?.widget, "custom");
  assert.equal(
    raw?.ui?.custom?.renderValue?.({
      name: "raw",
      definition: raw,
      value: undefined,
      values: {},
      selected: false,
      width: 20,
      theme: { bold: (text) => text, fg: (_color, text) => text },
      formatValue: String,
    }),
    "expand",
  );

  const adjustExisting = command.args.adjustExisting;
  const adjustedObjective = command.args.adjustedObjective;
  assert.equal(adjustExisting?.formOnly, true);
  assert.equal(adjustExisting?.ui?.widget, "custom");
  assert.equal(adjustedObjective?.ui?.copyFrom, "currentObjective");
  assert.equal(adjustedObjective?.ui?.widget, "text");
});
