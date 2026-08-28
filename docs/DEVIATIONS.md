# Deviations from the Specification

`docs/SPEC.md` is preserved verbatim as the reference design. This file records every
place the implementation intentionally departs from it, and why. Each deviation exists
because the spec'd approach has a concrete failure mode on demo day.

Nothing here changes the architecture, the security model, or the demo script. The
control plane, the trust model, and the seven phases in §32 are implemented as written.

---

## D1 — Zero-dependency agents; SSE instead of Socket.IO

**Spec:** §6 (Python 3 + `python-socketio`), §35 (PyInstaller executables).

**Problem:** the teammate machine is the one machine we cannot debug during the event.

- `/usr/bin/python3` on a stock Mac is a stub that prompts to install Xcode Command
  Line Tools. A teammate who has never opened a terminal does not have Python.
- PyInstaller `--onefile` binaries on Apple Silicon are unsigned. Gatekeeper refuses
  them outright, and the quarantine bit is set by AirDrop, USB, and browser download
  alike. Clearing it requires `xattr -dr com.apple.quarantine`, in a terminal, per
  machine.
- Windows adds SmartScreen on the `.exe` and execution policy on `.ps1`.

**Change:** the agents are written in the shells that ship with the operating system.

| Platform | Agent | Interpreter | Preinstalled |
| --- | --- | --- | --- |
| macOS | `agent/jarvis-agent.sh` | `/bin/bash` (3.2 compatible) | always |
| Windows | `agent/jarvis-agent.ps1` | Windows PowerShell 5.1 | always |

Transport becomes **Server-Sent Events for Core→agent push, plain HTTP POST for
agent→Core**. SSE is a `curl -N` stream that a shell reads line by line; it reconnects
on its own and needs no library on either end. Enrollment is one pasted line:

```
curl -s http://10.42.0.1:3000/join | sh -s ALPHA
```

Scripts piped from `curl` are never quarantined, so Gatekeeper never appears.

**Consequence for Core:** dropping Socket.IO lets Core run on the Node standard library
with **no `npm install` at all**. This matters more than it looks — during the demo the
Kali laptop's Wi-Fi *is* the access point, so Kali has no internet. A dependency-free
Core cannot fail to start because a package was never fetched.

**Cost:** §35's packaging milestone disappears. There is nothing to build or sign.

---

## D2 — Choreography uses relative delays, not absolute timestamps

**Spec:** §24 — Core issues a future wall-clock `startAt`; each client animates relative
to it.

**Problem:** that requires synchronized clocks. There is no internet on JARVIS-NET, so
there is no NTP, and laptop clocks routinely differ by seconds. The cascade would not
look staggered; it would look broken.

**Change:** Core sends `delayMs` **relative to receipt**. Each node starts its animation
`delayMs` milliseconds after the command arrives. LAN jitter on a quiet AP is on the
order of ten milliseconds, which is well below the threshold of visible desync.

The spec's own guidance in §24 — "do not attempt millisecond-perfect synchronization;
visually convincing synchronization is sufficient" — is satisfied more reliably by the
simpler mechanism.

---

## D3 — Agents hold the display awake

**Spec:** silent on power management.

**Problem:** §32 Phase 1 is *deliberately boring and long*. By the time TAKEOVER fires,
some laptops will have slept or locked. A locked Mac renders nothing, and no amount of
correct command dispatch fixes that.

**Change:** for its entire lifetime the agent holds a wake lock — `caffeinate -dimsu` on
macOS, `SetThreadExecutionState` on Windows — released automatically on exit.

A screen that was **already locked** before the agent started cannot be woken by any
userspace process. So the agent additionally reports display state, and the Command Wall
shows an explicit per-node awake indicator. The operator learns about a dark node before
triggering the takeover, not during it.

---

## D4 — The overlay cannot outlive the agent

**Spec:** §28 requires Ctrl+C to stop remote control; §16 requires release to restore the
desktop.

**Problem:** neither states that the overlay dies *with* the agent. If the agent crashes
or the terminal is closed, the teammate's laptop is left showing a fullscreen black
window with no way back that they will find under stage lighting.

**Change:** three independent recovery paths, in order of preference.

1. The agent traps `EXIT`, `INT`, `TERM` and tears the overlay down on any exit path.
2. The overlay page runs a dead-man switch: if Core becomes unreachable for longer than
   the configured grace period, it closes itself.
3. The overlay accepts a local escape gesture (`Esc` three times) regardless of
   connection state.

Path 3 is the one a panicking teammate can use. It is documented on the overlay itself.

---

## D5 — MAIN's overlay is the Command Wall

**Spec:** §18 puts the Command Wall fullscreen on the Presenter Mac; §43 has
`takeover(ALL)` switch every display to JARVIS. MAIN is both.

**Problem:** undefined interaction. A takeover overlay on MAIN covers the wall the
audience is supposed to be reading.

**Change:** MAIN is a normal node whose overlay resolves *into* the wall. The takeover
animation plays, then the page settles into the Command Wall scene. Release closes the
overlay and the presenter's slides return untouched, exactly as §32 Phase 8 requires.

One page, one process, one release path — the same as every other node.

---

## D6 — `--kiosk`, and the browser binary is launched directly

**Spec:** §16 recommends `--app=<URL> --start-fullscreen`.

**Problem:** `--start-fullscreen` is unreliable on macOS; the window opens, but windowed.
And `open -a` returns immediately without giving us the child PID, so there is nothing to
terminate on release.

**Change:** the agent execs the browser binary directly and keeps the PID:

```
/Applications/Google Chrome.app/Contents/MacOS/Google Chrome \
  --user-data-dir=<dedicated temp profile> \
  --kiosk --app=<overlay URL>
```

The dedicated `--user-data-dir` is what makes release safe: it forces a separate process
tree from the user's own browser session, so terminating it cannot disturb their tabs.
This is verified by an acceptance test, not assumed — see `docs/REHEARSAL.md`.

Browsers are probed in order (Chrome, Brave, Edge, Chromium). A node that finds none
simply does not advertise the `takeover` capability, which the spec's capability model
in §9 already handles correctly.

---

## D7 — URL validation is an allowlist; the controller authenticates

**Spec:** §28 rejects `file://` and `javascript:`; §27 requires an admin token for the
controller but does not say how the controller obtains one.

**Change, part one:** URL validation accepts **only** `http:` and `https:` and rejects
everything else. A denylist has to enumerate every dangerous scheme correctly forever;
an allowlist has to enumerate two safe ones. Validation runs in Core *and* again in the
agent, because the agent is the thing holding the shell.

**Change, part two:** `/control` presents a token entry screen and holds the admin token
in `sessionStorage`. Every control API call carries it as a bearer token. Tokens are
never placed in a URL, where they would survive in history and in Core's access log.

**Change, part three:** node tokens are passed to the agent via **stdin or environment**,
not `--token` on the command line, because command-line arguments are world-readable in
`ps` output on both platforms. The `--token` flag is still accepted for compatibility
with §35's documented invocation, and warns when used.

---

## Not changed

For the avoidance of doubt, these remain exactly as specified:

- The trust model in §1 — joining the Wi-Fi grants nothing; only an enrolled agent with a
  valid per-node token receives commands.
- The capability denylist in §12 — no `run_shell`, no `run_powershell`, no
  `execute_code`. The LLM never reaches a shell.
- The application allowlist in §13 — logical names only, never paths or shell strings.
- The MCP boundary in §25 — MCP talks to Core over HTTP and contains no OS-specific logic.
- The reliability rule in §39 — the first takeover is manually triggered from `/control`.
  Voice and the LLM are layered on afterwards and are never load-bearing.
