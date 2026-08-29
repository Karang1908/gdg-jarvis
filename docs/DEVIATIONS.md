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

1. The agent traps `EXIT`, `INT`, `TERM` and `HUP` and tears the overlay down on any exit
   path.
2. The overlay page runs a dead-man switch: if Core goes silent for 45 seconds — three
   missed keep-alives — it closes itself.
3. The overlay accepts a local escape gesture regardless of connection state: **hold
   Escape** for just over a second.

Path 3 is the one a panicking teammate can use, so it is a hold rather than a tap. A tap
can be struck by accident and would drop a screen mid-demo; a hold cannot, and it can show
a progress bar, which matters because anyone performing this gesture is already worried
and deserves to see that it is working.

---

## D5 — The wall device's overlay is the Command Wall

**Spec:** §18 puts the Command Wall fullscreen on the Presenter Mac; §43 has
`takeover(ALL)` switch every display to JARVIS. The presenter's machine is both.

**Problem:** undefined interaction. A takeover overlay on MAIN covers the wall the
audience is supposed to be reading.

**Change:** the wall device — the one whose agent was started with `--wall`, and otherwise
the lowest-numbered device online — is a normal device whose overlay resolves *into* the
wall. The takeover animation plays, then the page settles into the Command Wall scene. Release closes the
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

## D8 — Any number of devices, enrolled by a shared secret

**Spec:** §8 defines a fixed roster with a pre-shared token per node; §28 requires that
"only explicitly configured Node IDs may register".

**Problem:** that model does not survive contact with a real room. It fixes the guest list
before anyone arrives, so a teammate who turns up unplanned cannot join, an extra laptop
means editing JSON and restarting Core, and every person has to be handed the *right*
token out of four that look identical. It also asks the presenter to remember which
codename is which machine while talking to an audience.

**Change:** one join secret for the whole demo, baked by Core into the script it serves at
`/join`. Any device presenting it enrolls and is assigned the next free number. There is no
roster, no per-device token, and no upper limit.

What is deliberately kept from §1 and §28:

- Joining the Wi-Fi still grants nothing. Enrollment is a separate, authenticated step.
- The admin token — the one that controls *other people's* machines — is unchanged, is
  never handed out, and is what every control endpoint requires.
- Every enrollment and every refusal is logged with its source address.
- The operator can see every device on the wall and remove one with `/api/forget`.

**The trade, stated plainly:** anyone who obtains the join secret can enroll a device. The
secret is inside a script handed to teammates, so it should be assumed to leak. What that
buys an attacker is the ability to put a JARVIS overlay **on their own screen**. It does not
let them see the room, command another device, or reach the admin token. Core refuses to
start if `admin.token` and `join.secret` are ever equal, because that mistake would turn a
handout into the key to every laptop.

---

## D9 — Devices are numbered, not named

**Spec:** §3 and §8 use fixed codenames — ALPHA, BETA, GAMMA, MAIN.

**Problem:** codenames are a second thing to memorise, on top of which physical laptop is
which. Under stage lighting the presenter has to translate "the Windows one" to "BETA" to a
machine on a table, and the audience has no way to check the translation.

**Change:** devices are numbered in join order and addressed by number everywhere — the
wall, the controller, the voice layer, and MCP. Each also reports its **hostname and OS**,
which is what a person uses to recognise their own laptop, shown under the number rather
than instead of it.

Numbers are stable across reconnects, keyed on a hostname+OS fingerprint. A laptop that
drops off the Wi-Fi and returns is still device 3. Renumbering mid-demo would be the single
most confusing thing this system could do: the presenter says "identify three" and the wrong
screen answers.

Hostnames are also accepted as targets, because someone reading the wall will say "Ravi's
MacBook" as readily as "3" — but an ambiguous hostname is refused rather than resolved to a
guess.

---

## D10 — The microphone is on Core, and the phone is a remote

**Spec:** §30 puts natural language entirely in the LLM, reached through MCP.

**Problem:** three things. The LLM path needs internet and adds a round trip to moments
that have to be instant; nothing in the spec lets the presenter stop the system listening,
even though they spend most of the demo talking to an audience rather than to JARVIS; and
the spec never says *where* the microphone is.

**Change, part one — where it listens.** The microphone is on the machine running Core,
next to the speakers and the model. It is not on the phone.

This was built the other way first, with the browser doing the listening, and that was
wrong. It put recognition on whichever handset happened to be holding the page, which meant
the room's ability to hear depended on a phone's position, its browser, and a secure
context — a plain-http page gets no microphone at all, so an earlier version shipped a
self-signed certificate purely to work around that. All of it disappears once the
microphone lives where the rest of the system already does. Core hears, transcribes,
decides, and speaks; the certificate, the https listener, and the browser recogniser are
gone.

The phone keeps the mic button, and it does what the presenter thinks it does — it opens
and closes the microphone. Just not a microphone in the phone.

**Change, part two — what it does without a model.** A transcript is matched against a
fixed list of phrases in `core/lib/intents.js` before any model is involved. No round trip,
no LLM in the path, and it cannot invent a command that was never spoken. Anything that
does not match goes to `agy`, which reasons about it and calls the room's MCP tools. Two
speeds, and the fast one is the one the demo leans on.

Matching is deliberately conservative about what counts as a command. A device reference
that names no real device does not match, so "take a look at this slide" reaches the model
rather than seizing a laptop. A false positive in front of an audience is far worse than a
miss — a miss just costs the model round trip that unrecognised speech was always going to
take.

**Change, part three — the control.** A microphone toggle, closed by default. Whatever Core
heard is pushed to the phone and displayed even when it matched nothing, because a live mic
that did not recognise a phrase and a dead mic must never look the same.

Separately, a **JARVIS-audible** toggle mutes JARVIS's speech. The two are deliberately
distinct and worded so: the microphone is what JARVIS hears, the other is what it says. A
muted device still executes everything; it simply makes no sound, and reports `muted` as a
skip reason so the wall shows why rather than swallowing it.

**Honest limitation:** transcription quality is whatever is installed on Core. Local
whisper is good and needs no network; with neither whisper nor sox present, Core falls back
to fixed-length recording windows and cloud transcription, which is worse on both counts
and says so in the log rather than quietly sounding broken.

---

## D11 — The brain runs on Core, not on the presenter's machine

**Spec:** §29 puts the MCP server, the LLM client, and the voice on the Presenter Mac, and
makes that machine dual-homed — JARVIS-NET over Wi-Fi with no internet, the internet over a
tethered iPhone. §31 has each device speak for itself.

**Problem:** it puts the hardest network arrangement on the machine that is also driving the
projector, and it scatters JARVIS across the room.

- The Mac has to hold two routes correctly, in the right order, while presenting. Get the
  service order wrong and either the LLM loses the internet or the room becomes
  unreachable, and both look like the demo simply breaking.
- Speech belonging to whichever device was addressed means JARVIS has no voice at all until
  a device enrols, and the voice moves around the room depending on what was last targeted.
- The thinking happens in one place and the room lives in another, with a Wi-Fi hop between
  every tool call and its effect.

**Change:** Core, the MCP server, the AI client, and the voice all run on the Kali machine.

```
   KALI                                        JARVIS-NET
   ├── ethernet / tethered phone → internet    │
   ├── agy CLI ─┐                              ├── device 1  (macOS)
   ├── MCP ─────┤ localhost                    ├── device 2  (Windows)
   ├── Core ────┘                              └── device 3  (macOS)
   └── speakers → JARVIS's voice
```

Kali is now the dual-homed machine, which is the right place for it: Wi-Fi is already
committed to being the access point, so the second route is ethernet or a tethered phone,
and nobody is holding it while talking to an audience. The presenter's Mac becomes an
ordinary device that happens to drive the projector.

MCP reaches Core over localhost, so there is no network hop between the model and the room.

**JARVIS gets one voice.** Speech comes from the machine running Core, because one presence
has one voice — and because it then works before a single device has enrolled, which matters
for the moment the room hears "Yes, sir" before anything has been taken over. Per-device
speech still exists and is still right for the deliberate effect of every laptop saying the
same thing at once; it is simply no longer the default.

**The trade:** if Kali has no internet, the LLM layer is gone. That is survivable by
construction — §39 already requires the demo to run from the controller with no LLM at all,
and the controller's own voice control matches phrases locally with no model in the path. A
tethered phone on Kali's USB is the fallback, exactly as the spec proposed for the Mac.

---

## D12 — The personality is a file

**Spec:** §30 gives the LLM its system instructions as a block of text inside the spec.

**Problem:** a system prompt written into a document is a system prompt nobody tunes. The
voice of the thing is the part most worth iterating on between rehearsals, and it should not
require editing code or hunting through a spec to change.

**Change:** `core/config/personality.md` — plain markdown with optional YAML frontmatter,
edited like any other file. Core loads it and serves it at `/api/personality`; the MCP
server takes it as its `instructions`, which is what an MCP client surfaces to the model;
and `scripts/install-mcp.sh` copies it to Antigravity's custom-agent location.

One source, three consumers, no copy that can quietly disagree with another.
`POST /api/personality/reload` re-reads it without restarting Core, so it can be adjusted
between run-throughs.

The MCP server falls back progressively — Core, then the file on disk, then a terse
built-in — because a personality that silently failed to load would leave JARVIS sounding
like a generic assistant with nothing to indicate why.

---

## D13 — A cached voice, natural where it counts

**Spec:** §31 has each machine speak with its own platform synthesiser.

**Problem:** `espeak` on Linux sounds like a 1980s train announcement, and the whole demo
turns on JARVIS sounding like something worth listening to. But the natural options are
cloud calls, and putting a 1–3 second network round trip — over a tethered phone — in front
of every line JARVIS says is not something to do live.

**Change:** a provider chain with a cache in front of it.

```
speak(text)
  ├── cached?  ── play the file                  no network, no synthesiser
  └── not cached
        ├── gemini   natural, needs internet ──┐
        ├── piper    natural, local, fast    ──┤── cache ── play
        └── say / spd-say / espeak            ──┘
```

The ordinary path is a live call: a line comes in, it is synthesised, it is played. Two
things sit on top of that and neither is something to think about.

**A latency budget.** A live call that has not produced audio within `budgetMs` — one
second by default — is abandoned, and the local voice speaks instead. A demo has a rhythm;
asking JARVIS a question and waiting three seconds reads as broken even when it is working
perfectly. The abandoned call is deliberately *not* cancelled: it finishes in the background
and its audio is kept, so the same line is right next time. Being late is a reason to stop
waiting, not a reason to throw away work that is nearly done.

The fallback is chosen by a `network` flag on each provider rather than by name. Excluding
only "gemini" would mean any future cloud backend fell back to itself, which is not a
fallback — it just pays the same latency twice. That was a real bug, caught by a test with a
deliberately slow stand-in provider.

**A cache**, which is simply "do not pay for the same line twice". It fills itself as JARVIS
talks; nothing has to be run for it to work. `scripts/warm-voice.sh` exists to fill it ahead
of time from `core/config/phrases.json` if a venue's connection is bad, but it is an
optimisation for a known-bad network, not a step in the setup.

Gemini's style prompt is what justifies the call at all: the model is told *how* to deliver
a line, not merely what to say, so "Yes, sir" comes out measured and dry. No concatenative
engine can do that at any price.

The cache key includes the provider, voice, model and style prompt, so changing any of them
produces fresh audio. Without that, editing the style prompt and hearing no difference would
lead straight to the conclusion that the setting does nothing.

**Measured, not assumed.** Time to first sound, which is the number a presenter feels:

| | |
| --- | --- |
| cached line | ~0 ms |
| live synthesis, local voice | ~470 ms |
| live synthesis, cloud | network round trip, capped at `budgetMs` |

An earlier version of this note claimed ~700ms of unavoidable player overhead. That was
wrong: it measured the player process's whole lifetime, which is dominated by how long the
line takes to *say*. Spawning the player and reaching first sound is effectively immediate.

---

## D14 — Device numbers are assignable

**Spec:** no equivalent; numbering did not exist until D9.

**Problem:** join order is whatever order people happened to open a terminal in. The
presenter's own machine ends up as device 4, the laptop nearest the projector is 2, and the
run of show has to be rewritten around an accident.

**Change:** `POST /api/renumber`, and a panel in the controller. Numbers can be assigned
deliberately, and any device can be designated **main** — the one showing the Command Wall,
and the word an operator actually says.

Renumbering **swaps** with whatever holds the destination number rather than inserting and
shifting. Shifting would renumber machines nobody touched, which is precisely what D9
promises not to do: the presenter has already said "identify three" out loud, and it cannot
come to mean a different laptop a minute later. A swap moves exactly two devices and is its
own undo.

The assignment is recorded against the machine's fingerprint, so it survives a reconnect —
a laptop deliberately made device 1 is still device 1 after a Wi-Fi blip, or the assignment
was pointless. "Main" likewise follows the machine rather than the number: renumber the main
device and it is still main.

---

## Not changed

For the avoidance of doubt, these remain exactly as specified:

- The trust model in §1 — joining the Wi-Fi grants nothing; only a device that enrolled
  with the join secret receives commands, and only the admin token commands other people's
  machines. See D8 for what changed underneath and what did not.
- The capability denylist in §12 — no `run_shell`, no `run_powershell`, no
  `execute_code`. The LLM never reaches a shell.
- The application allowlist in §13 — logical names only, never paths or shell strings.
- The MCP boundary in §25 — MCP talks to Core over HTTP and contains no OS-specific logic.
  D11 moves which machine it runs on, not what it is allowed to do.
- The reliability rule in §39 — the first takeover is manually triggered from `/control`.
  Voice and the LLM are layered on afterwards and are never load-bearing.
