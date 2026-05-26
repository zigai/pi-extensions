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

### `/branch-out [count] [optional prompt]`

Forks the current Pi session into one or more new Pi processes.

Examples:

```text
/branch-out
/branch-out investigate the failing tests
/branch-out 3
/branch-out 3 investigate separate approaches
```

A leading positive integer is treated as the number of forks to create. Everything after that integer is sent as the optional initial prompt to each fork. The fork count is capped at 10.

When running inside tmux, each fork opens in a right-hand tmux split. On macOS Ghostty, forks open in Ghostty splits. On Linux Ghostty, forks open in new Ghostty windows.
