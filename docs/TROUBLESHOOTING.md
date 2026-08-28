# Troubleshooting

Ordered by when it will happen to you, not by severity.

**First, always:** the big red **RELEASE ALL** on `/control/` works from any scroll
position, with any target selected, and never asks for confirmation. Use it, then debug.

---

## Core will not start

### `Placeholder tokens still present for: admin, MAIN, ...`

Working as intended. Core refuses to boot with `CHANGE-ME` tokens, because a Core that
starts with placeholders fails in front of an audience instead of at setup time.

```bash
scripts/setup-kali.sh --tokens-only
```

### `No node registry at core/config/nodes.json`

Same fix. The registry is gitignored on purpose — real tokens never reach the repository.

### `Nodes ALPHA and BETA share a token`

Two nodes with one token makes the activity log fiction: a command becomes attributable to
either machine. Regenerate.

### `EADDRINUSE`

An old Core is still running.

```bash
pkill -f 'core/server.js'
```

---

## A teammate cannot enroll

### `REJECT bad_token`

The token does not match. They are the same length and look alike — check you handed over
the right one. `scripts/setup-kali.sh` prints each node's line individually to avoid this.

### `REJECT unknown_node`

The node ID is not in `nodes.json`. Case does not matter; spelling does.

### `Core unreachable; retrying in 1s`

Not an auth problem — the agent cannot reach Core at all.

```bash
# On the teammate's machine
ping 10.42.0.1                   # is the network there?
curl http://10.42.0.1:3000/healthz   # is Core there?
```

If ping works and curl does not, Core is bound to the wrong interface. Check the address
it printed at startup and restart with `--host` set to the AP address.

### Nothing happens at all when they paste the line

They are on macOS and used `sh` instead of `bash`. The agent uses bash string replacement
that `/bin/sh` on Linux does not implement. It is `bash -s`.

### Windows: `running scripts is disabled on this system`

Execution policy. The `iwr | iex` form avoids it entirely — that is why it is the
documented one. If they are running a downloaded file:

```powershell
powershell -ExecutionPolicy Bypass -File jarvis-agent.ps1 -Node BETA -Token <token>
```

---

## The node is online but nothing shows

### The wall says `screen locked`

This is the one failure no command can fix. The agent holds the display awake for its
whole lifetime, but it cannot unlock a screen that was already locked when it started.

Walk over and unlock it. Then ask them not to lock it again — the wall will tell you if
they do.

### The node has no `takeover` capability

No Chromium-family browser was found, so the node correctly did not advertise it. Check
the agent's startup banner: it prints the browser it found, or says it found none.

Install Chrome or Edge. On Windows, Edge is always present, so this is a macOS-only
situation in practice.

### The overlay opens but the page is blank

The overlay could not reach Core. The HUD in the top right will say `LINK LOST`.

Usually the node roamed to a different Wi-Fi band or another network entirely. Check it is
still on JARVIS-NET, then `release` and `takeover` that node again.

### The overlay opens on the wrong display

Chromium opens on whichever display was last active. Click on the target display before
triggering the takeover, or make it the primary display.

---

## Commands are refused

Every refusal names its reason, on the wall in purple and in the controller's feedback
line. They mean exactly what they say.

| Reason | What happened |
| --- | --- |
| `offline` | The node's command channel is not connected. |
| `capability_missing:takeover` | That node never advertised it. Usually no browser. |
| `app_not_allowlisted` | The app is not in `core/config/apps.json`. |
| `app_unavailable_on:windows` | Listed, but with no Windows mapping. |
| `scheme_not_allowed:file` | Only `http` and `https` are accepted. Working as intended. |
| `action_unknown` | No such action. There is deliberately no shell action. |
| `no_overlay` | A scene was sent to a node that has not been taken over. |
| `bad_session` | The agent's session expired. It will re-register on its own. |

`no_overlay` on a node you *did* take over means its browser closed. Take it over again.

---

## Choreography looks wrong

### The cascade travels in the wrong direction

`core/config/layout.json` lists the nodes in the wrong order. It should match the physical
left-to-right arrangement as the **audience** sees it, not as you see it from the stage.

```json
{ "order": ["ALPHA", "BETA", "GAMMA", "MAIN"], "stepMs": 180 }
```

This is a config edit. Do not change code for it.

### The stagger is invisible, or it looks like lag

`stepMs`. Below about 90ms it reads as simultaneous; above about 400ms it reads as a slow
system. 180 is the default for a reason.

### Screens animate at visibly different times

Not clock skew — the protocol never uses wall-clock time between machines. It is network
delay, which means one node is on a weak signal. Move it closer to the Kali laptop, or
check whether it has drifted onto a different band.

---

## Tethering Kali to a phone over USB

The intended arrangement: Wi-Fi runs the access point, the phone carries the internet the
model needs. Check it with the phone plugged in:

```bash
scripts/setup-kali.sh --check
```

That reports the uplink interface, whether the internet is actually reachable through it,
and whether its subnet collides with JARVIS-NET.

### Android

Plug in, then **Settings → Network → Hotspot & tethering → USB tethering**. Linux sees an
RNDIS or NCM interface (`usb0`, `enp0s20u1`) and NetworkManager configures it with no help.
This is the easy path — if you have a choice of phones, use the Android one.

### iPhone

Needs more:

```bash
sudo apt install usbmuxd libimobiledevice6 ipheth-utils
```

Then plug in, **unlock the phone**, accept **Trust This Computer**, and turn on **Personal
Hotspot**. The interface appears as `eth1` or similar. If nothing appears, `systemctl
restart usbmuxd` and re-plug. The trust prompt only appears on an unlocked screen, and a
locked phone silently does nothing.

### It is a charging cable

The most common cause of "USB tethering does nothing". Plenty of cables carry power and no
data. Swap the cable before debugging anything else.

### The phone is also your controller

If one phone is both tethering to Kali and running `/control/`, it has to be on JARVIS-NET
Wi-Fi *and* serving cellular over USB at the same time. That works, but Android sometimes
decides to route tethered traffic over its Wi-Fi connection — which here has no internet —
and the model goes quiet for no visible reason.

Use a different device for the controller if you have one: a second phone, or just a
browser window on the presenter's Mac. If you only have the one phone, test the combination
before the day rather than assuming it.

### It worked, then stopped

The phone locked, the hotspot timed out with no clients, or the cable moved. USB tethering
keeps the phone charging from the laptop, so battery is rarely the cause. Re-check with
`scripts/setup-kali.sh --check`.

### None of it works and the talk is in ten minutes

Nothing about the demo needs the internet except the model. Everything in
[REHEARSAL.md](REHEARSAL.md)'s run of show can be driven from `/control/` — the takeover,
identify, scenes, move, cascade, release, and every spoken line under **JARVIS SAYS**. Run
it from the controller and the room cannot tell.

---

## The presenter's Mac loses the internet

Only relevant if you are still running the AI layer on the Mac. Since DEVIATIONS.md D11 the
brain runs on Kali, and the Mac is an ordinary device that needs nothing but JARVIS-NET —
so the usual answer is that it does not matter.

```bash
scripts/health-check.sh http://10.42.0.1:3000
```

It reports both routes explicitly. What you want:

```
route to Core uses en0        ← Wi-Fi, JARVIS-NET
default route uses en7        ← iPhone over USB
```

If the default route is also `en0`, macOS is trying to reach the internet over a network
that has none. Open **System Settings → Network → ⋯ → Set Service Order** and drag the
iPhone above Wi-Fi.

The route to Core does not depend on service order — `10.42.0.0/24` is directly connected
over Wi-Fi and stays reachable regardless.

---

## The AI layer

### `JARVIS_ADMIN_TOKEN is not set`

Deliberate: the MCP server refuses to start rather than failing on the first tool call. A
model that gets an authorization error mid-conversation retries rather than reporting it,
and the presenter would hear silence instead of a cause.

### `No module named 'mcp.server.fastmcp'`

An old SDK. `FastMCP` became `MCPServer` in SDK 2.0.

```bash
.venv/bin/pip install -U -r mcp/requirements.txt
```

### The model invents node names

It skipped `list_nodes()`. The system prompt in SPEC.md §30 tells it to call that whenever
a device is referenced ambiguously. Every tool refuses an unknown node and returns the real
list, so this is self-correcting — but a model that guesses once will guess again, and the
prompt is the fix.

### The voice layer is unreliable in the room

Expected. That is why it is last in the build order and why every scripted line is a button
under **JARVIS SAYS** on `/control/`. Tap the line. The room cannot tell.

---

## Getting a screen back, in order of preference

1. **RELEASE ALL** on `/control/`.
2. `curl -X POST -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \
   -d '{"target":"ALL"}' http://10.42.0.1:3000/api/release`
3. On the affected machine: **hold Escape** on the overlay for a second.
4. On the affected machine: Ctrl+C the agent. Its trap tears the overlay down.
5. Ctrl+C on Core. It releases the room on its way out.
6. Close the browser window: Cmd+Q on macOS, Alt+F4 on Windows.

Steps 3, 4, and 6 need no network at all. Whoever is sitting in front of the screen can
always get it back without finding you.
