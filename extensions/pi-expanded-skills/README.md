# Pi Enhanced Skills

Enhanced cross-harness skill compatibility for Pi.

## Install

```sh
pi install npm:@zigai/pi-enhanced-skills
```

## Extension

This package adds compatibility behavior for Anthropic/Claude Code and OpenAI/Codex-style skills.

### Invocation Metadata

`SKILL.md` frontmatter supports:

```yaml
disable-model-invocation: false
user-invocable: true
```

- `disable-model-invocation: true` keeps the skill out of the model-visible skills list.
- `user-invocable: false` hides the skill from `/skill:` autocomplete and blocks direct `/skill:name` use.

OpenAI/Codex sidecars support only this field:

```yaml
policy:
  allow_implicit_invocation: false
```

`policy.allow_implicit_invocation: false` is treated like `disable-model-invocation: true` for Pi's model prompt. Other OpenAI sidecar fields are ignored.

### Dynamic Context Injection

Skill content can include Claude-style shell injection:

```markdown
Current diff:
!`git diff --stat`
```

When a known skill is invoked or read in full, the command runs from the skill directory and its output is inserted for that invocation only. The source `SKILL.md` is not modified. Fenced blocks are also supported:

````markdown
```!
git status --short
```
````

Command output is bounded and command execution times out after 10 seconds.

### Skill Usage Tracking

Skill usage is appended to `<Pi agent dir>/state/pi-enhanced-skills/skill-usage.jsonl` as JSONL.
Each record includes the session id, current model, project folder, skill name, skill path, file path, and whether the event came from a direct `/skill:` invocation, a mention-expanded skill block, or an agent `read` of `SKILL.md` or a file under the skill directory, with `SKILL.md` references marked separately.
Raw skill contents and user arguments are not stored.

## Development

```sh
just --justfile ../../Justfile setup
just check
just coverage
```

## License

[MIT](LICENSE)
