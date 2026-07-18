import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";

import {
  createGoalCreationPrompt,
  renderGoalCreationTemplate,
} from "../src/goal-creation-prompt.js";
import {
  ensureGoalConfigFiles,
  getGoalGlobalConfigPath,
  getGoalGlobalConfigSchemaPath,
  loadGoalSettings,
} from "../src/goal-settings.js";
import { createThreadGoal } from "../src/state.js";

function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

test("goal settings files are discoverable and preserve existing config", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-goal-settings-"));
  try {
    ensureGoalConfigFiles(agentDir);
    const configPath = getGoalGlobalConfigPath(agentDir);
    const schemaPath = getGoalGlobalConfigSchemaPath(agentDir);
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
      $schema: "./config.schema.json",
      creationPromptPath: null,
      disabledToolsWhileGoalActive: [],
    });
    assert.match(readFileSync(schemaPath, "utf8"), /creationPromptPath/);
    assert.match(readFileSync(schemaPath, "utf8"), /disabledToolsWhileGoalActive/);

    writeJson(configPath, { creationPromptPath: "keep-me.md" });
    ensureGoalConfigFiles(agentDir);
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
      creationPromptPath: "keep-me.md",
    });
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("configured prompt templates resolve by scope, interpolate attributes, and reread edits", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-goal-template-"));
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  const globalConfigPath = getGoalGlobalConfigPath(agentDir);
  const globalTemplatePath = join(dirname(globalConfigPath), "global.md");
  const projectConfigPath = join(projectDir, ".pi", "pi-codex-goal", "config.json");
  const projectTemplatePath = join(dirname(projectConfigPath), "project.md");
  const currentGoal = createThreadGoal("existing <goal>");
  const input = {
    task: "Build & verify",
    minimumTimeMinutes: 15,
    maximumTimeMinutes: 60,
  };

  try {
    writeJson(globalConfigPath, { creationPromptPath: "./global.md" });
    writeText(
      globalTemplatePath,
      "global {{task}}\n{{constraints}}\n{{cwd}}\n{{currentGoal}}\n{{minimumTimeMinutes}}/{{maximumTimeMinutes}}",
    );
    writeJson(projectConfigPath, { creationPromptPath: "./project.md" });
    writeText(projectTemplatePath, "project-v1 {{task}}\n{{constraints}}");

    const untrusted = createGoalCreationPrompt(
      input,
      { cwd: projectDir, isProjectTrusted: () => false },
      currentGoal,
      agentDir,
    );
    assert.equal(untrusted.ok, true);
    assert.equal(untrusted.templatePath, globalTemplatePath);
    assert.match(untrusted.prompt, /^global Build &amp; verify/m);
    assert.match(untrusted.prompt, /Minimum active time: 15 minutes/);
    assert.match(untrusted.prompt, /Maximum active time: 60 minutes/);
    assert.match(untrusted.prompt, /minimum_time_minutes=15/);
    assert.match(untrusted.prompt, /maximum_time_minutes=60/);
    assert.match(untrusted.prompt, /existing &lt;goal&gt;/);

    const trustedV1 = createGoalCreationPrompt(
      input,
      { cwd: projectDir, isProjectTrusted: () => true },
      currentGoal,
      agentDir,
    );
    assert.equal(trustedV1.ok, true);
    assert.equal(trustedV1.templatePath, projectTemplatePath);
    assert.match(trustedV1.prompt, /^project-v1/);

    writeText(projectTemplatePath, "project-v2 {{task}}\n{{constraints}}");
    const trustedV2 = createGoalCreationPrompt(
      input,
      { cwd: projectDir, isProjectTrusted: () => true },
      currentGoal,
      agentDir,
    );
    assert.equal(trustedV2.ok, true);
    assert.match(trustedV2.prompt, /^project-v2/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("active-goal disabled tools resolve from global and trusted-project settings", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-goal-tool-settings-"));
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  const globalConfigPath = getGoalGlobalConfigPath(agentDir);
  const projectConfigPath = join(projectDir, ".pi", "pi-codex-goal", "config.json");

  try {
    writeJson(globalConfigPath, {
      disabledToolsWhileGoalActive: ["ask_user_question", "ask_user_question"],
    });
    writeJson(projectConfigPath, {
      disabledToolsWhileGoalActive: ["agent_browser"],
    });

    const untrusted = loadGoalSettings(
      { cwd: projectDir, isProjectTrusted: () => false },
      agentDir,
    );
    assert.deepEqual(untrusted, {
      ok: true,
      settings: {
        creationPromptPath: null,
        activeGoalToolPolicy: { disabledTools: ["ask_user_question"] },
      },
    });

    const trusted = loadGoalSettings({ cwd: projectDir, isProjectTrusted: () => true }, agentDir);
    assert.deepEqual(trusted, {
      ok: true,
      settings: {
        creationPromptPath: null,
        activeGoalToolPolicy: { disabledTools: ["agent_browser"] },
      },
    });

    writeJson(projectConfigPath, {
      disabledToolsWhileGoalActive: ["update_goal"],
    });
    const invalid = loadGoalSettings({ cwd: projectDir, isProjectTrusted: () => true }, agentDir);
    assert.equal(invalid.ok, false);
    assert.match(invalid.message, /update_goal must remain available/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("creation template validation rejects missing and unknown dynamic attributes", () => {
  const context = { cwd: "/tmp/project", currentGoal: null };
  const missing = renderGoalCreationTemplate("only {{task}}", { task: "ship" }, context);
  const unknown = renderGoalCreationTemplate(
    "{{task}} {{constraints}} {{mystery}}",
    { task: "ship" },
    context,
  );

  assert.deepEqual(missing, {
    ok: false,
    message: "Goal prompt template must include {{constraints}}.",
  });
  assert.deepEqual(unknown, {
    ok: false,
    message: "Unknown goal prompt attribute: mystery.",
  });
});
