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
/branch --count 3
/branch --panes --count 3
/branch --prompt "investigate the failing tests"
/branch --keep-open
/branch --panes --count 3 --prompt "investigate separate approaches"
/branch ?
/branch ??
```

`/branch ?` opens the typed-argument prompt flow when `pi-typed-commands` is enabled. `/branch ??` shows command help. The typed args are:

- `--count <1-100>` — number of forks to create; default `1`.
- `--panes` / `--no-panes` — open tmux panes or Ghostty splits instead of windows.
- `--keep-open` / `--no-keep-open` — keep the terminal shell open after Pi exits.
- `--prompt <text>` — optional initial prompt sent to each fork.

When running inside tmux, each fork opens in a new tmux window/tab immediately after the current tmux window by default. Pass `--panes` to open right-hand tmux panes instead. By default, the tmux window or pane closes when the forked Pi process exits. Pass `--keep-open` to run Pi without `exec` and drop back to a shell after Pi exits. New tmux windows reuse the current Pi session name when available and append a concise index, such as `My task 1`. Forked Pi processes preserve the current model when Pi exposes it to the extension context.

On macOS Ghostty, forks open in Ghostty windows by default and Ghostty splits with `--panes`. On Linux Ghostty, forks open in new Ghostty windows.

## Development note

This extension intentionally writes new Pi session JSONL files directly so child Pi processes can start from the current committed branch state in separate terminal sessions. That couples the extension to Pi's session file format; review this code when upgrading Pi across session-format changes or when a higher-level session-forking API becomes available.
