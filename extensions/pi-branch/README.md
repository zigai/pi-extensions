# Pi Branch

This Pi extension branches the current session into parallel tmux or Ghostty panes.

## Install

```sh
pi install git:github.com/zigai/pi-branch
```

For this private package on this machine, load the local working copy from Pi settings:

```json
{
  "packages": ["/home/zigai/Projects/pi-branch"]
}
```

## Commands

### `/branch [args]`

Forks the current Pi session into one or more new Pi processes.

Typed named-argument examples:

```text
/branch
/branch 3
/branch --count 3
/branch --panes --count 3
/branch --pane-window --count 4
/branch --prompt "investigate the failing tests"
/branch --keep-open
/branch --worktree
/branch --panes --count 3 --prompt "investigate separate approaches"
/branch --help
```

Press Tab after `/branch` to open the typed-argument form. `/branch --help` shows generated command help. The typed args are:

- `[count]` / `--count <1-100>` — number of forks to create; default `1`.
- `--panes` — split the current tab/window into panes.
- `--pane-window` — open one new tab/window split into panes.
- `--keep-open` / `--no-keep-open` — keep the terminal shell open after Pi exits.
- `--worktree` — open forks in git worktrees.
- `--prompt <text>` — optional initial prompt sent to each fork.

When running inside tmux, each fork opens in a new tmux window/tab immediately after the current tmux window by default. Pass `--panes` to split the current tmux window into panes, or `--pane-window` to create one new tmux window containing all fork panes. Pane layouts are balanced automatically: two or three panes use an even horizontal layout, and four or more panes use a tiled grid. By default, the tmux window or pane closes when the forked Pi process exits. Pass `--keep-open` to run Pi without `exec` and drop back to a shell after Pi exits. New tmux windows reuse the current Pi session name when available and append a concise index, such as `My task 1`. Forked Pi processes preserve the current model when Pi exposes it to the extension context.

On macOS Ghostty, forks open in Ghostty windows by default, split the current window with `--panes`, or open one new split window with `--pane-window`. On Linux Ghostty, forks open in new Ghostty windows; pane modes require tmux.

## Worktrees

By default, forks launch in the current working directory. When `/branch --worktree` is passed, worktrees are created under `~/.pi/agent/worktrees` unless you override the location with this global Pi setting in `~/.pi/agent/settings.json`:

```json
{
  "piBranch": {
    "worktreeDir": "~/Projects/pi-worktrees"
  }
}
```

When `--worktree` is passed, `/branch` creates one worktree per fork under the configured/default worktree directory, creates a new branch named like `pi-branch/<session>-<id>` from the current `HEAD`, writes the forked Pi session with the worktree as its `cwd`, and opens the new terminal there. Relative `worktreeDir` values are resolved relative to `~/.pi/agent`.

## Development note

This extension intentionally writes new Pi session JSONL files directly so child Pi processes can start from the current committed branch state in separate terminal sessions. That couples the extension to Pi's session file format; review this code when upgrading Pi across session-format changes or when a higher-level session-forking API becomes available.
