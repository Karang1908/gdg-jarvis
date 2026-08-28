# J.A.R.V.I.S. Room Control System

A local-network control plane for a live GDG IoT demonstration. Several pre-authorized
laptops join a private Wi-Fi network, each runs a small agent, and a presenter can put a
cinematic fullscreen interface on all of them at once — then hand every desktop back
untouched.

The audience experiences *JARVIS took over the room*. The engineering underneath is a
private network, authenticated device enrollment, persistent command channels, capability
discovery, and event-driven orchestration. The spectacle gets attention; the architecture
is what makes it an IoT demonstration.

**It works with no internet.** Internet is needed only for the optional voice/LLM layer.

---

## What's here

```
core/      JARVIS Core — registry, command bus, web UI. Node, zero dependencies.
agent/     Node agents. bash for macOS, PowerShell for Windows. Nothing to install.
mcp/       MCP server, so an AI client can drive the room.
scripts/   Kali setup, health check, and a simulator for rehearsing without hardware.
docs/      The original spec, deviations from it, the wire protocol, rehearsal, fixes.
```

Three surfaces, all served by Core:

| Route | What it is |
| --- | --- |
| `/control/` | The controller. Phone-sized. **This is the guaranteed path.** |
| `/wall/` | The Command Wall. Fullscreen on the presenter's display. |
| `/overlay/` | The fullscreen surface an agent puts over a teammate's desktop. |

---

## Just want to see it work?

On a Mac, with no Kali box and no teammates:

```bash
git clone https://github.com/Karang1908/gdg-jarvis.git
cd gdg-jarvis
scripts/start-mac.sh
```

That runs Core, enrols the Mac as `MAIN`, and prints the admin token and URLs. Open
`/control/` on your phone or in a second window, paste the token, tap **TAKE THE ROOM** —
the Mac goes fullscreen and becomes the Command Wall. Tap **RELEASE ALL** to get your
desktop back. Ctrl+C stops everything and releases every screen.

Teammates on the same Wi-Fi can join with the lines it prints. Everything works except
JARVIS-NET itself, which is the only thing the Kali machine adds.

---

## Bring it up from nothing

### 1. Kali — the access point and Core

```bash
git clone https://github.com/Karang1908/gdg-jarvis.git
cd gdg-jarvis
sudo scripts/setup-kali.sh
```

That checks the Wi-Fi adapter really supports AP mode, generates the two secrets, brings up
`JARVIS-NET` with the passphrase `gdg@essentials2026`, and prints the join line.

There is nothing to install. Core runs on the Node standard library alone — no
`npm install`, which matters because during the demo this machine's Wi-Fi *is* the access
point and it has no internet.

```bash
node core/server.js --host 10.42.0.1 --port 3000
```

Ctrl+C releases the room before exiting.

### 2. Teammates — one line, the same for everybody

Join `JARVIS-NET` (password `gdg@essentials2026`), then paste one line. No device name, no
token — Core bakes its own address and the join secret into the script when it serves it.

**macOS**

```bash
curl -s http://10.42.0.1:3000/join | bash
```

**Windows**

```powershell
iwr http://10.42.0.1:3000/join.ps1 -UseBasicParsing | iex
```

It prints the device number it was given — `You are device: 3` — and that number is how the
presenter refers to it. There is no limit on how many people join, and nobody has to edit a
config file to add one.

Nothing is installed and nothing appears on screen. They keep using the laptop normally.
Ctrl+C ends remote control immediately.

*Why a pasted line rather than an app to double-click:* a downloaded binary is quarantined
by Gatekeeper and flagged by SmartScreen, on every machine, in front of everyone. A script
piped from `curl` is not. See [D1](docs/DEVIATIONS.md#d1--zero-dependency-agents-sse-instead-of-socketio).

### 3. Presenter — the wall and the controller

Open `http://10.42.0.1:3000/wall/` fullscreen on the display, and
`http://10.42.0.1:3000/control/` on a phone. Both ask once for the admin token.

The controller carries two toggles that are easy to confuse, so they are worded apart:

| | |
| --- | --- |
| **MIC** | Your microphone. Off by default. On, it listens for commands — "take the room", "identify two", "release the room" — matched locally in the browser, with no LLM in the path. |
| **JARVIS AUDIBLE** | JARVIS's voice. Mutes speech without affecting anything else. |

Then, before you trust any of it:

```bash
scripts/health-check.sh http://10.42.0.1:3000
```

Run it **from the presenter's Mac**, not from Kali. Checking Core from the machine Core
runs on proves nothing about the Wi-Fi, and the Wi-Fi is what fails.

### 4. The AI layer — also on Kali

Core, the MCP server, the `agy` CLI, and JARVIS's voice all run on the Kali machine. Run
this **there**:

```bash
python3 -m venv .venv && .venv/bin/pip install -r mcp/requirements.txt
scripts/install-mcp.sh
```

That registers the tools in `~/.gemini/config/mcp_config.json` — the config Antigravity 2.x
shares across the IDE, the `agy` CLI, and the SDK — keeping any other MCP servers you
already have, and installs the personality as a custom agent. Restart Antigravity, then ask
it *"how many devices are online?"*.

Kali needs internet for the model. Its Wi-Fi is busy being the access point, so use
**ethernet or a phone tethered over USB**. `scripts/setup-kali.sh` tells you whether a
separate uplink exists. Without one everything except the AI layer still works.

JARVIS speaks from Kali, so its audio output is the room's voice — feed it to the PA if
there is one:

```bash
sudo apt install speech-dispatcher espeak-ng      # if it is not already there
```

### 5. Who JARVIS is

`core/config/personality.md` is the system prompt. Plain markdown — edit it and JARVIS
changes.

```bash
$EDITOR core/config/personality.md
curl -X POST -H "Authorization: Bearer <admin token>" \
  http://127.0.0.1:3000/api/personality/reload
```

One file, three consumers: Core serves it, the MCP server takes it as its `instructions`
(which is what a client hands the model), and `scripts/install-mcp.sh` copies it to
Antigravity's custom-agent location. Nothing else holds a copy that can disagree.

**Do not build the demo on this.** The first cinematic moment is triggered by hand from
`/control/`; the LLM is a second interface to a system that already works without it.

---

## Rehearsing without four laptops

```bash
scripts/sim-node.sh "Ravi-PC" --os windows
scripts/sim-node.sh "anita-mbp"
scripts/sim-node.sh "lab-thinkpad" --os linux
```

Synthetic devices enroll, heartbeat, and acknowledge, so the wall, the controller, and the
whole command path can be exercised on one machine. Six of them is worth running at least
once: nobody discovers the wall stops composing until the sixth person joins.

`--os windows` makes Core resolve application names against the Windows column of the
allowlist, so a mistake in `apps.json` surfaces at your desk rather than on stage.

They cannot prove that a takeover renders or that release restores a desktop. Only real
hardware does that — [REHEARSAL.md](docs/REHEARSAL.md) marks which tests need it.

---

## How it works

```
   KALI  ── ethernet / tethered phone ──→ internet (the model)
   │
   │   agy CLI ──→ MCP ──┐
   │                     │ localhost
   │   JARVIS's voice ───┤
   │                     ▼
   │                JARVIS CORE ──── 10.42.0.1
   │                     │
   └── Wi-Fi AP          │  SSE, one stream per device
       JARVIS-NET  ┌─────┼─────┐
                   ▼     ▼     ▼
              device 1  dev 2  dev 3      ← numbered in join order
               (agent) (agent) (agent)
                   │     │     │
                   ▼     ▼     ▼
          fullscreen overlay, dedicated browser profile

   CONTROLLER (any phone on JARVIS-NET) ──── HTTP ──→ Core
```

Everything that thinks lives on Kali. The presenter's Mac is an ordinary device that
happens to drive the projector — no dual-homing, no MCP, nothing to get wrong while
talking.

Four things are worth knowing about the design.

**One voice, one brain.** Core, the model, and the speech all run on Kali. JARVIS can talk
before a single device has joined, and it does not move around the room depending on what
was last targeted.

**Joining the Wi-Fi grants nothing.** A machine is controllable only once someone runs the
agent, which enrolls with a join secret. Every command channel is authenticated and a
rejected client never receives a command. The admin token — the one that commands *other
people's* machines — is separate, is never handed out, and Core refuses to start if the two
are ever the same value.

**The LLM cannot reach a shell.** Not by policy — structurally. No action in the protocol
carries a command line. Applications are referenced by logical name against an allowlist,
URLs must be `http` or `https`, and every value is percent-encoded before it reaches a
shell agent, so nothing crossing the wire can be interpreted as anything but data.

**Release is safe.** Each overlay runs in a dedicated browser profile, which forces a
separate process tree from the user's own browser. Terminating the overlay cannot touch
their tabs, and their desktop returns exactly as they left it.

**Nothing fails silently.** Every dispatch reports the nodes it could not reach and why —
offline, screen locked, capability not advertised, argument refused. During a live demo,
a partial success that looks total is the worst possible outcome.

The full wire protocol is in [PROTOCOL.md](docs/PROTOCOL.md).

---

## If something goes wrong

The big red **RELEASE ALL** button on `/control/` always works, ignores what is selected,
and never asks for confirmation.

Failing that, from any machine that can reach Core:

```bash
curl -X POST -H "Authorization: Bearer <admin token>" \
  -H 'Content-Type: application/json' -d '{"target":"ALL"}' \
  http://10.42.0.1:3000/api/release
```

Failing that, on the affected laptop: **hold Escape** on the overlay, or Ctrl+C the agent.
Either gives that screen back on its own, with no help from the network.

Failing all of it, Ctrl+C on Core releases the room on its way out.

[TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) covers the rest.

---

## Documentation

| | |
| --- | --- |
| [SPEC.md](docs/SPEC.md) | The original specification, preserved verbatim |
| [DEVIATIONS.md](docs/DEVIATIONS.md) | Every intentional departure from it, and why |
| [PROTOCOL.md](docs/PROTOCOL.md) | The wire protocol |
| [REHEARSAL.md](docs/REHEARSAL.md) | Acceptance tests and the run-of-show |
| [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | What breaks, and what to do |

---

## A note on what this is

This is an orchestration platform for explicitly enrolled devices belonging to a team that
agreed to take part. The theatrical text on screen says `NODE ACQUIRED`; the honest
description is `AUTHORIZED NODE, CONTROL CHANNEL ESTABLISHED`, and the explanation given
to the audience should be the honest one.

It never scans for devices, never touches a machine that has not run the agent, and
executes only a fixed set of allowlisted actions. Every remote action is logged.
