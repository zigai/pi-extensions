# Pi Toggles

Pi Toggles is a central control panel for deciding which tools and skills Pi exposes and can run. Policy can be temporary for one session or persist globally or in a trusted project.

- Inspect tools, skills, and extension slash commands with their source and effective policy.
- Set tools to `inherit`, `on`, `off`, or `lazy`, and block calls to tools that policy disables.
- Control skill visibility and `/skill:name` invocation separately with `on`, `off`, `name-only`, and `user-only`.
- Bundle capability decisions and prompt guidance into profiles, then activate them with typed conditions.
- Accept context facts and tool defaults from companion extensions without overriding explicit user policy.
- Surface controls that Pi's public extension API cannot currently enforce.

## Install

```sh
pi install git:github.com/zigai/pi-toggles
```

## Quick start

Open Pi and run:

```text
/toggles
```

Choose a scope, stage changes in the interactive panel, and press `Ctrl+S` to apply them. Session policy survives reloads and resumes of the same saved session. Global and trusted-project policy is stored in Pi Toggles settings.

You can also make common changes directly:

```text
/toggles list tool
/toggles set write off --scope session
/toggles explain write
/toggles doctor
```

Lazy tools stay out of the initial model context and can be activated through the policy-aware `search_capabilities` tool. Disabled skills are removed from model context and blocked from explicit `/skill:name` expansion, although Pi's read-only autocomplete may still display them.

<!-- pi-extension-settings:start -->
## Configuration

Global settings are stored in `~/.pi/agent/extension-settings/pi-toggles.json`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Enforce Pi Toggles policy while preserving the recovery command. |
| `defaults.unknownCondition` | `no-match` | `"no-match"` | Treat unknown or failed condition facts as a non-match. |
| `defaults.lazyToolLimit` | integer | `5` | Maximum tools activated by one lazy capability search. |
| `defaults.showStatus` | boolean | `true` | Show a compact footer status when policy changes Pi or has diagnostics. |
| `activeProfile` | string | — | Persistent profile selected at this settings scope. |
| `overrides` | PolicyDecision[] | `[]` | Explicit persistent capability decisions. |
| `profiles` | Record<string, CapabilityProfile> | `{}` | Named bundles of capability decisions and prompt fragments. |
| `promptFragments` | PromptFragment[] | `[]` | Owned system-prompt fragments available to profiles and conditions. |
| `rules` | PolicyRule[] | `[]` | Conditional decisions and profile activations. |

### Defaults

```json
{
  "$schema": "./schemas/pi-toggles.schema.json",
  "enabled": true,
  "defaults": {
    "unknownCondition": "no-match",
    "lazyToolLimit": 5,
    "showStatus": true
  },
  "overrides": [],
  "profiles": {},
  "promptFragments": [],
  "rules": []
}
```

### Advanced example

```json
{
  "$schema": "./schemas/pi-toggles.schema.json",
  "activeProfile": "focused",
  "profiles": {
    "focused": {
      "decisions": [
        {
          "target": {
            "kind": "tool",
            "name": "bash"
          },
          "state": "off"
        }
      ],
      "promptFragments": [
        "focus"
      ]
    }
  },
  "promptFragments": [
    {
      "id": "focus",
      "content": {
        "kind": "inline",
        "text": "Keep responses focused on the requested change."
      },
      "priority": 10
    }
  ]
}
```
<!-- pi-extension-settings:end -->

Trusted-project settings use `.pi/extension-settings/pi-toggles.json` and are ignored until Pi trusts the project.

Profiles group decisions and prompt fragments. Declarative rules activate them from session, model, prompt, Git, project-file, or extension-provided facts without running JavaScript or shell commands. Frequently changing rules can reduce prompt-cache reuse.

## Limits

Pi Toggles controls tools and loaded skills. Pi exposes extension commands for inspection but has no public API for disabling an individual command or intercepting it before execution, so command controls are reported as unsupported. Built-in commands, prompt templates, and extension loading are outside Pi Toggles' scope.

## Documentation

- [Cooperative tool activation](docs/activation-coordination.md)
- [Pi resource-control API gaps](docs/upstream-pi-api.md)

## License

[MIT](LICENSE)
