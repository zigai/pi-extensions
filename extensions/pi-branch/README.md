# pi-branch-out

Pi package for branching the current session into parallel tmux or Ghostty panes.

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

When running inside tmux, each fork opens in a new tmux window/tab by default. Pass `--panes`, `--pane`, or `-p` to open right-hand tmux panes instead. New tmux windows reuse the current Pi session name when available and append an index, such as `My task branch 1 of 3`.

On macOS Ghostty, forks open in Ghostty windows by default and Ghostty splits with `--panes`. On Linux Ghostty, forks open in new Ghostty windows.
