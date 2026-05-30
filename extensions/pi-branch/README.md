# Pi Branch Out

Pi extension for branching the current session into parallel tmux or Ghostty panes.

## Install

```sh
pi install git:github.com/zigai/pi-branch-out
```

For this private package on this machine, load the local working copy from Pi settings:

```json
{
  "packages": ["/home/zigai/Projects/pi-branch-out"]
}
```

## Commands

### `/branch-out [--panes] [count] [optional prompt]`

Forks the current Pi session into one or more new Pi processes.

Examples:

```text
/branch-out
/branch-out investigate the failing tests
/branch-out 3
/branch-out 3 investigate separate approaches
/branch-out --panes 3 investigate separate approaches
```

A leading positive integer, after any flags, is treated as the number of forks to create. Everything after that integer is sent as the optional initial prompt to each fork. The fork count is capped at 10.

When running inside tmux, each fork opens in a new tmux window/tab by default. Pass `--panes`, `--pane`, or `-p` to open right-hand tmux panes instead. New tmux windows reuse the current Pi session name when available and append a concise index, such as `My task 1`. Forked Pi processes preserve the current model when Pi exposes it to the extension context.

On macOS Ghostty, forks open in Ghostty windows by default and Ghostty splits with `--panes`. On Linux Ghostty, forks open in new Ghostty windows.

## Development note

This extension intentionally writes new Pi session JSONL files directly so child Pi processes can start from the current committed branch state in separate terminal sessions. That couples the extension to Pi's session file format; review this code when upgrading Pi across session-format changes or when a higher-level session-forking API becomes available.
