# Pi Expanded Skills

Expanded cross-harness skill compatibility for Pi.

## Install

```sh
pi install git:github.com/zigai/pi-expanded-skills
```

For this private package on this machine, load the local working copy from Pi settings:

```json
{
  "packages": ["/home/zigai/Projects/pi-expanded-skills"]
}
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

## Development

```sh
npm install
just check
just coverage
```
