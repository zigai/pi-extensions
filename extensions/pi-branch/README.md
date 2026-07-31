# Pi Branch

This Pi extension branches the current session into parallel tmux or Ghostty panes.

## Install

```sh
pi install npm:@zigai/pi-branch
```

## Commands

### `/branch [args]`

Forks the current Pi session into one or more new Pi processes.

Typed named-argument examples:

```text
/branch
/branch 3
/branch --count 3
/branch --layout current-tab --count 3
/branch --layout new-tab --count 4
/branch --prompt "investigate the failing tests"
/branch --keep-open
/branch --worktree
/branch --layout current-tab --count 3 --prompt "investigate separate approaches"
/branch --help
```

Press Tab after `/branch` to open the typed-argument form. `/branch --help` shows generated command help. The typed args are:

- `[count]` / `--count <1-100>` — number of forks to create; default `1`.
- `--layout <separate|current-tab|new-tab>` — where forks open; default `separate`. `separate` opens each fork in its own tab/window, `current-tab` adds forks beside the current Pi session, and `new-tab` puts all forks together in one new tab/window.
- `--keep-open` / `--no-keep-open` — keep the terminal shell open after Pi exits.
- `--worktree` — open forks in git worktrees.
- `--prompt <text>` — optional initial prompt sent to each fork.

When running inside tmux, the default `separate` layout opens each fork in a new tmux window/tab immediately after the current one. `current-tab` splits the current tmux window, leaving the current Pi session in place and adding one pane per fork. `new-tab` creates one new tmux window containing all fork panes. New-tab grids use a predictable row-first layout; for example, six forks open as three columns by two rows. By default, the tmux window or pane closes when the forked Pi process exits. Pass `--keep-open` to run Pi without `exec` and drop back to a shell after Pi exits. New tmux windows reuse the current Pi session name when available and append a concise index, such as `My task 1`. Forked Pi processes preserve the current model when Pi exposes it to the extension context.

On macOS Ghostty, `separate` opens a Ghostty window for each fork, `current-tab` splits the current window, and `new-tab` opens one new split window. On Linux Ghostty, only `separate` is available; the split layouts require tmux.

## Worktrees

By default, forks launch in the current working directory. When `--worktree` is passed, `/branch` creates one worktree per fork under the configured worktree directory, creates a new branch named like `pi-branch/<session>-<id>` from the current `HEAD`, writes the forked Pi session with the worktree as its `cwd`, and opens the new terminal there.

## Configuration

Configuration is optional. Global config lives at `~/.pi/agent/pi-branch/config.json`.

| Key           | Type           | Default       | Description                                                                                                                                                 |
| ------------- | -------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worktreeDir` | string or null | `"worktrees"` | Directory for `/branch --worktree`; `~` is supported, relative paths resolve from the config file location, and `null` or empty disables worktree creation. |

```json
{
  "$schema": "./config.schema.json",
  "worktreeDir": "worktrees"
}
```

## Development note

This extension intentionally writes new Pi session JSONL files directly so child Pi processes can start from the current committed branch state in separate terminal sessions. That couples the extension to Pi's session file format; review this code when upgrading Pi across session-format changes or when a higher-level session-forking API becomes available.
