# gdg-jarvis — repository facts

Room control plane for a live GDG IoT demo. Read `docs/DEVIATIONS.md` before changing
anything structural; it records why the implementation departs from `docs/SPEC.md`, and
each entry names a specific demo-day failure that motivated it.

## Running it locally

```bash
scripts/setup-kali.sh --tokens-only        # writes core/config/nodes.json (gitignored)
node core/server.js --host 127.0.0.1 --port 3000

# a whole room on one machine
scripts/sim-node.sh ALPHA <token> http://127.0.0.1:3000
scripts/sim-node.sh BETA  <token> http://127.0.0.1:3000 --os windows

npm test                                   # wire encoding, incl. the real bash decoder
scripts/health-check.sh http://127.0.0.1:3000
```

Node tokens are in `core/config/nodes.json`, which is gitignored. Get one with:

```bash
node -e "console.log(require('./core/config/nodes.json').nodes.ALPHA.token)"
```

## Constraints that are not obvious from the code

**Core has no dependencies and must keep none.** During the demo the Kali machine's Wi-Fi
*is* the access point, so it has no internet. Adding a package means adding a way for Core
to fail to start at the venue. `core/lib/http.js` exists for this reason.

**The agents are shell scripts and must stay dependency-free.** `agent/jarvis-agent.sh`
targets **bash 3.2** — the version macOS ships — so no associative arrays, no `mapfile`,
no `${var,,}`. `agent/jarvis-agent.ps1` targets **Windows PowerShell 5.1**. Neither may
grow a dependency: the whole reason they are shell is that a teammate's laptop has nothing
installed and a downloaded binary meets Gatekeeper or SmartScreen.

**No page may make an external request.** No webfonts, no CDNs, nothing. JARVIS-NET has no
internet and a blocking third-party fetch is a black rectangle over someone's laptop until
it times out.

**Choreography uses delays relative to receipt, never absolute timestamps.** There is no
NTP on JARVIS-NET and laptop clocks differ by seconds. If you find yourself sending a
wall-clock time between machines, that is the bug.

## Things already learned the hard way

- `[hidden]` in the UA stylesheet loses to any class that sets `display`. `jarvis.css` has
  a global `[hidden] { display: none !important }` — without it the overlay's escape hatch
  renders during every takeover. Screenshot the UI; this was invisible in code review.
- Headless Chrome reports `prefers-reduced-motion: reduce`, so screenshot checks silently
  skip every animation unless you emulate `no-preference`.
- macOS `date` has no `%N`. Use `curl -w '%{time_total}'` for millisecond timing in shell.
- `$args` is a PowerShell automatic variable. Never assign to it inside a function, and
  note that `[CmdletBinding()]` scripts do not receive it at all.
- Chromium's `--start-fullscreen` is unreliable on macOS; `--kiosk` works. Launch the
  binary directly, not via `open -a`, or you get no PID to terminate later.
- The MCP Python SDK renamed `FastMCP` to `MCPServer` in 2.0.
- **bash defers a trap until the foreground command finishes.** An SSE stream never
  finishes, so `curl | while read` made SIGTERM unhandled and the agent had to be
  SIGKILLed — skipping cleanup and orphaning the overlay. Both agents read through a FIFO
  so the foreground command is the interruptible `read` builtin. Interactive Ctrl+C hides
  this bug, because the terminal signals the whole process group.
- For a backgrounded **pipeline**, `$!` is the *last* command, not the first. Piping an
  agent through `sed` for a prettier prefix silently makes its recorded PID the prefixer's.
- A non-interactive shell sets SIGINT to *ignore* for background jobs, and bash cannot trap
  a signal that was ignored on entry. Testing Ctrl+C handling with `nohup cmd &` then
  `kill -INT` proves nothing — use SIGTERM.

## Testing what the simulator cannot

`scripts/sim-node.sh` never opens a browser. It cannot prove that a takeover renders, that
release restores a desktop, or that the user's own Chrome survives. Those are marked
**[hw]** in `docs/REHEARSAL.md` and need real laptops.

The one that matters most: **after `release`, a teammate's own browser session must be
intact — same tabs, same windows.** The dedicated `--user-data-dir` is what makes that
true, and it is the single assumption the whole design rests on.

## Layout

```
core/lib/wire.js          percent-encoding; the security boundary for the shell agents
core/lib/commands.js      the only path to a node — single funnel, so logging cannot be missed
core/lib/registry.js      presence follows the SSE connection, not the heartbeat
core/lib/choreography.js  stagger and cascade timing
core/public/shared/       design tokens, scenes, wall renderer — shared by all three UIs
agent/                    macOS bash + Windows PowerShell, same wire protocol
mcp/server.py             HTTP to Core only; contains no OS-specific logic by design
```
