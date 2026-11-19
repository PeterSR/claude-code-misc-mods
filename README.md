# claude-code-misc-mods

Small [Claude Code](https://claude.com/claude-code) mods: plugins built on Claude Code's function hooks. This repository is a plugin marketplace.

```sh
claude plugin marketplace add PeterSR/claude-code-misc-mods
claude plugin install whilst@misc-mods --scope user
```

To work on a mod, add a local clone as the marketplace instead (`claude plugin marketplace add ~/path/to/claude-code-misc-mods`). Claude Code then reads the mod from the folder itself, and `/reload-plugins` picks up edits without a reinstall.

## whilst

Connects Claude Code to [whilst](https://github.com/PeterSR/systemd-whilst), which keeps a Linux machine in the state its rules ask for (inhibitor locks, running units) while their conditions hold. The mod lets whilst rules depend on whether Claude Code is working, and lets your whilst config put a line above the prompt in every session.

### Busy signal

A session counts as busy while a turn runs on its main loop or in any subagent, background subagents included. A turn held on a permission prompt or a question still counts as busy: Claude Code gives no reliable signal for when it is answered, and reporting busy is the safe direction. While busy, the mod keeps `$XDG_RUNTIME_DIR/claude-busy/<session id>` holding `busy` and touches it every minute. When the session goes idle or ends, the file is emptied. After the mod reloads mid-session, it picks up running subagents and a running main-loop turn again from the agent list and from the file itself. Each switch between busy and idle also emits a signal on the session bus, `io.github.PeterSR.ClaudeBusy.Changed` on `/io/github/PeterSR/ClaudeBusy`, so whilst can re-read at once instead of waiting for its next poll.

A whilst fact that counts busy sessions, treating a file not touched for 3 minutes as stale (a session that crashed mid-turn), and cleaning up empty files older than an hour:

```toml
include = ["preset:upower"]   # for `ac` and `battery`; top-level keys go above the tables

[fact.claude_busy]
type    = "int"
command = "d=\"$XDG_RUNTIME_DIR/claude-busy\"; find \"$d\" -type f -empty -mmin +60 -delete 2>/dev/null; find \"$d\" -type f ! -empty -mmin -3 2>/dev/null | wc -l"
on_dbus_session = ["type='signal',interface='io.github.PeterSR.ClaudeBusy',member='Changed'"]
every   = "30s"

# For example: keep the machine awake, lid closed or not, while any session
# works. The battery guard matters: a session left on a permission prompt
# counts as busy, so without it a laptop closed in a bag stays awake until it
# is empty.
[[rule]]
name    = "claude-working"
while   = "claude_busy > 0 && (ac || battery > 15.0)"
linger  = "3m"
inhibit = ["sleep", "handle-lid-switch"]
```

### A line above the prompt

The mod shows the value of the whilst fact `claude_band` as a dim line above the prompt (hidden while a feedback survey is shown). An empty string, or no such fact, shows nothing. What the line says is up to your config, typically an `expr` fact:

```toml
[fact.claude_band]
type = "string"
expr = "claude_busy > 0 && !ac ? 'whilst: on battery, staying awake for ' + string(claude_busy) + ' busy session(s)' : ''"
```

The mod reads the value from whilst's state file (`$XDG_STATE_HOME/whilst/state.json`, by default `~/.local/state/whilst/state.json`). It checks the file's modification time every 15 seconds and parses it only when it has changed, so the line updates within 15 seconds.

### Cost

The turn hooks do no I/O of their own. Each switch between busy and idle costs one small file write and one `busctl` process. While busy, the mod writes once a minute. The line above the prompt costs one `stat` every 15 seconds, plus a read when whilst's state has changed, and redraws only when its text changes.

### Requirements

Linux with a user session bus, `busctl` (part of systemd) and whilst. Without `XDG_RUNTIME_DIR` the busy signal is off. Without whilst's state file, no line is shown.

## License

MIT, see [LICENSE](LICENSE).
