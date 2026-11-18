# Pi Monitor

Let Pi watch logs, files, jobs, and WebSockets and react to each event. The agent starts a monitor, keeps working, and each event arrives as a message. When the agent is idle, an event starts a new turn.

## Installation

```sh
pi install npm:@zigai/pi-monitor
```

## Quick start

Ask Pi:

```text
Start the dev server, then watch its log and fix any error that shows up.
```

The agent uses these tools:

| Tool                | Purpose                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------- |
| `monitor`           | Watch a shell `command`; set a `description`, `cwd`, and `timeout`.                     |
| `monitor_websocket` | Watch a WebSocket `url`; set a `description`, `protocols`, and `timeout`.               |
| `monitor_stop`      | Stop a monitor and its process tree or socket.                                          |
| `monitor_list`      | List this session's monitors with their state, event count, time left, and output file. |

## Events

Each stdout line of the command is an event. Lines that arrive within 200 ms form one message. Lines longer than 500 characters and events longer than 3000 characters are cut. Output on stderr does not create events; it goes to the output file.

`monitor_websocket` turns each text frame into an event. Binary frames show as `[binary frame, N bytes]`.

Events that arrive while the agent works reach it after its current tool calls. An event that arrives while the agent is idle starts a new turn.

## Rate limit

A monitor can deliver a burst of 10 events, then one event every 2 seconds. Events over that rate are dropped, and the next delivered event says how many were dropped. A monitor that stays over the rate for 30 seconds is stopped with a notice.

## Lifetime

A monitor ends when its command exits or its socket closes. The agent gets one notice with the exit code or close code. A monitor also expires after its `timeout`: 300 seconds by default, 1800 at most. The agent gets one notice at expiry and can start the monitor again.

Monitors belong to the current Pi session. Switching sessions, reloading extensions, or quitting Pi stops them.

Output files stay in `~/.pi/agent/monitor/<session-id>/` until you delete them.

## Inspecting monitors

Use `/monitors` to list monitors, read a monitor's output, or stop one. Stopping a monitor here tells the agent without starting a turn.

Load `@zigai/pi-status-bar` to show a running count such as `2 monitors`.

## License

[MIT](LICENSE)
