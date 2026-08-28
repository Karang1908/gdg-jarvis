# JARVIS Room Control System
## Implementation & Handoff Specification

### Project Goal

Build a local-network, multi-device control system for a live GDG IoT demonstration. Multiple pre-authorized Mac and Windows laptops will connect to a private Wi-Fi network created by a Kali Linux laptop. Each participating laptop runs a lightweight JARVIS Agent silently in the background. A central JARVIS Core maintains the device registry and can remotely instruct enrolled machines to display fullscreen cinematic interfaces, open approved applications, open websites, speak text, identify themselves, change scenes, and return to their previous state.

A local MCP server exposes these capabilities as tools to an external AI/voice client such as Antigravity. This allows commands such as:

“Jarvis, take the room.”

“Jarvis, identify Beta.”

“Open Chrome on Alpha.”

“Open the GDG website on the Windows machine.”

“Move yourself to Gamma.”

“Take control of everything.”

“Release the room.”

The actual device-control system MUST remain completely functional without internet. Internet is needed only for the optional cloud LLM/voice layer.

---

# 1. Core Design Principle

Joining the Wi-Fi does NOT automatically provide control over a device.

Every participating computer must explicitly run a trusted JARVIS Agent. The agent establishes an authenticated connection to JARVIS Core and advertises the actions it supports.

Architecture:

```text
                         INTERNET
                            │
                       iPhone USB
                            │
                            ▼
                    PRESENTER MAC
                Antigravity / Voice AI
                            │
                         MCP
                            │
                            ▼
                    JARVIS MCP SERVER
                            │
                         HTTP
                            │
                            ▼
                     JARVIS CORE
                     Kali Linux
                     10.42.0.1
                            │
                       JARVIS-NET
                            │
          ┌─────────────────┼─────────────────┐
          │                 │                 │
          ▼                 ▼                 ▼
       ALPHA              BETA              GAMMA
       macOS             Windows            macOS
     Jarvis Agent       Jarvis Agent      Jarvis Agent

                 PRESENTER MAC
                 is also a node
                       │
                       ▼
               Main HDMI Display
               + mirrored prompts
```

The Kali machine is:

- Wi-Fi hotspot
- JARVIS Core
- Web server
- Socket.IO server
- Device registry
- Event bus
- Command API
- Static asset server
- Logging server

The Presenter Mac is:

- a normal JARVIS controlled node
- MCP host
- Antigravity/LLM host
- voice input host
- main presentation/display computer

---

# 2. Hardware Environment

Expected devices:

```text
1 × Kali Linux laptop
1 × Presenter MacBook
1 × iPhone
2–5 × teammate Mac/Windows laptops
1 × Main HDMI display
2 × mirrored teleprompter displays
```

The main display and two teleprompters show the same output from the Presenter Mac and should be treated as one large “JARVIS Command Wall.”

No Raspberry Pi or ESP32 is required.

---

# 3. Network Architecture

The Kali laptop creates:

```text
SSID: JARVIS-NET
```

This network should have:

- no dependency on campus Wi-Fi
- no dependency on internet
- DHCP enabled
- client-to-client communication enabled
- private RFC1918 addressing

Likely configuration:

```text
Kali/JARVIS Core:
10.42.0.1

ALPHA:
10.42.0.x

BETA:
10.42.0.x

GAMMA:
10.42.0.x
```

Do NOT rely on fixed client IP addresses.

Clients identify themselves using Node IDs.

Example:

```text
ALPHA
BETA
GAMMA
MAIN
```

---

# 4. Kali Hotspot Setup

First identify the Wi-Fi interface:

```bash
nmcli device status
```

Confirm AP mode support:

```bash
iw list | grep -A 15 "Supported interface modes"
```

The output should include:

```text
* AP
```

Assuming interface `wlan0`:

```bash
sudo nmcli device wifi hotspot \
  ifname wlan0 \
  con-name JARVIS-NET \
  ssid JARVIS-NET \
  band bg \
  password 'ArcReactor42!'
```

Disable AP client isolation:

```bash
sudo nmcli connection modify JARVIS-NET \
  802-11-wireless.ap-isolation no
```

Restart:

```bash
sudo nmcli connection down JARVIS-NET
sudo nmcli connection up JARVIS-NET
```

Determine the Kali IP:

```bash
ip -4 addr show wlan0
```

The software must permit the JARVIS Core URL to be configurable rather than permanently assuming `10.42.0.1`.

---

# 5. Required Repository Structure

Create a monorepo:

```text
jarvis/
│
├── core/
│   ├── server.js
│   ├── package.json
│   ├── config/
│   │   ├── nodes.json
│   │   └── apps.json
│   ├── services/
│   │   ├── registry.js
│   │   ├── commands.js
│   │   ├── auth.js
│   │   └── choreography.js
│   └── public/
│       ├── wall/
│       ├── controller/
│       ├── overlay/
│       └── assets/
│
├── agent/
│   ├── jarvis_agent.py
│   ├── config.example.json
│   ├── requirements.txt
│   ├── platform/
│   │   ├── macos.py
│   │   └── windows.py
│   └── installers/
│       ├── run-macos.command
│       └── run-windows.bat
│
├── mcp/
│   ├── server.py
│   ├── requirements.txt
│   └── README.md
│
├── scripts/
│   ├── setup-kali.sh
│   └── health-check.sh
│
└── README.md
```

---

# 6. Technology Stack

## JARVIS Core

Use:

```text
Node.js
Express
Socket.IO
```

Install:

```bash
npm install express socket.io cors
```

Core runs by default on:

```text
http://10.42.0.1:3000
```

## JARVIS Agent

Use Python 3.

Suggested packages:

```text
python-socketio
requests
psutil
```

Install:

```bash
pip install python-socketio requests psutil
```

The agent should remain lightweight.

Do NOT require Docker on client machines.

## MCP Server

Use Python and an MCP SDK compatible with the chosen AI client.

The MCP server should communicate with JARVIS Core through its HTTP API.

---

# 7. JARVIS Agent Startup Experience

The teammate workflow must be extremely simple.

A teammate should:

1. Connect to `JARVIS-NET`.
2. Receive the provided folder/script.
3. Run one command/file.
4. Leave it running.
5. Continue using the laptop normally.

Example macOS:

```text
double-click:

run-macos.command
```

Example Windows:

```text
double-click:

run-windows.bat
```

Or CLI:

```bash
python jarvis_agent.py \
  --node ALPHA \
  --token <TOKEN> \
  --server http://10.42.0.1:3000
```

After connection, the agent should print:

```text
JARVIS NODE AGENT

Node: ALPHA
Core: 10.42.0.1
Authenticated: YES
Status: READY

Running in background.
```

Nothing should appear over the user's desktop until commanded.

---

# 8. Node Configuration

Example configuration:

```json
{
  "nodeId": "ALPHA",
  "token": "alpha-secret-value",
  "server": "http://10.42.0.1:3000",
  "browser": "chrome"
}
```

Server-side node configuration:

```json
{
  "ALPHA": {
    "token": "alpha-secret-value"
  },
  "BETA": {
    "token": "beta-secret-value"
  },
  "GAMMA": {
    "token": "gamma-secret-value"
  },
  "MAIN": {
    "token": "main-secret-value"
  }
}
```

Do NOT trust a client merely because it knows a Node ID.

---

# 9. Registration Protocol

When the agent connects:

```json
{
  "event": "register",
  "nodeId": "ALPHA",
  "token": "...",
  "os": "macos",
  "hostname": "Alice-MacBook",
  "capabilities": [
    "takeover",
    "release",
    "open_url",
    "open_app",
    "identify",
    "speak",
    "set_volume"
  ]
}
```

The server responds:

```json
{
  "status": "accepted",
  "sessionId": "..."
}
```

Invalid nodes:

```json
{
  "status": "rejected"
}
```

Rejected devices must NOT receive command events.

---

# 10. Heartbeats

Every agent sends approximately every 5 seconds:

```json
{
  "event": "heartbeat",
  "nodeId": "ALPHA",
  "timestamp": 123456789,
  "state": "ready"
}
```

Core marks the node offline after approximately 15 seconds without heartbeat.

The Command Wall updates automatically.

Example:

```text
MAIN      ● ONLINE
ALPHA     ● ONLINE
BETA      ● ONLINE
GAMMA     ○ OFFLINE
```

---

# 11. Command Schema

Every command should have:

```json
{
  "commandId": "uuid",
  "target": "ALPHA",
  "action": "open_app",
  "args": {
    "app": "chrome"
  },
  "issuedAt": 123456789
}
```

Targets may be:

```text
ALPHA
BETA
GAMMA
MAIN
ALL
```

Agent acknowledgment:

```json
{
  "commandId": "uuid",
  "nodeId": "ALPHA",
  "status": "success",
  "message": "Chrome launched"
}
```

Possible states:

```text
received
executing
success
failed
unsupported
```

---

# 12. Allowed Capabilities

The first implementation MUST support:

```text
list_nodes
identify
takeover
release
show_scene
broadcast_scene
open_app
open_url
speak
set_volume
```

Optional:

```text
close_app
play_audio
play_video
move_scene
cascade
blackout
red_alert
```

Do NOT expose:

```text
run_shell
run_powershell
run_command
execute_code
```

The LLM must never receive arbitrary shell execution.

---

# 13. Application Allowlist

Applications are referenced by logical names.

Example:

```json
{
  "chrome": {
    "macos": "Google Chrome",
    "windows": "chrome.exe"
  },
  "vscode": {
    "macos": "Visual Studio Code",
    "windows": "Code.exe"
  },
  "spotify": {
    "macos": "Spotify",
    "windows": "Spotify.exe"
  }
}
```

If an application is not allowlisted:

```text
ACTION DENIED
```

The LLM may request:

```text
open_app("ALPHA", "chrome")
```

It may NOT provide executable paths or shell strings.

---

# 14. macOS Backend

Application launch:

```bash
open -a "Google Chrome"
```

URL:

```bash
open "https://example.com"
```

Speech:

```bash
say "Yes, sir."
```

Volume can use AppleScript:

```bash
osascript -e 'set volume output volume 60'
```

The Python platform backend should call these safely with argument arrays rather than shell interpolation.

---

# 15. Windows Backend

Applications can be started with Python `subprocess.Popen()` or PowerShell `Start-Process`.

Example logical behavior:

```text
open_app("chrome")
open_app("vscode")
```

Speech may use Windows SAPI through PowerShell or Python.

The Windows implementation does not need feature parity with macOS initially.

Each node advertises only the features it actually supports.

---

# 16. Fullscreen Takeover Mechanism

DO NOT attempt to manipulate or destroy the user's existing windows.

The JARVIS Agent launches a dedicated fullscreen browser window over the desktop.

Example overlay URL:

```text
http://10.42.0.1:3000/overlay?node=ALPHA
```

Recommended Chromium launch style:

```text
--app=<URL>
--start-fullscreen
--user-data-dir=<temporary dedicated Jarvis profile>
```

The agent stores the process handle/PID.

When `release` is received:

1. Terminate only the JARVIS overlay process.
2. Do NOT terminate the user's normal Chrome/Edge session.
3. The user's original desktop is revealed unchanged.

This behavior is a critical reliability requirement.

---

# 17. Takeover Animation

`takeover(ALL)` should not merely display a static JARVIS logo.

Use a cinematic sequence.

Suggested timeline:

```text
0 ms
BLACK SCREEN

250 ms
SIGNAL INTERRUPTED

700 ms
REMOTE CONTROL CHANNEL DETECTED

1200 ms
LINKING NODE...

1800 ms
██████████████ 100%

2300 ms
NODE ALPHA
CONTROL ESTABLISHED

3000 ms
J.A.R.V.I.S.
ONLINE
```

For multiple laptops, intentionally stagger activation.

Example:

```text
MAIN     t + 0ms
ALPHA    t + 180ms
BETA     t + 360ms
GAMMA    t + 540ms
```

This should look like JARVIS is propagating across the room.

---

# 18. Main Command Wall

Route:

```text
/wall
```

This page is displayed fullscreen on the Presenter Mac and therefore appears on:

- main screen
- teleprompter 1
- teleprompter 2

Main view after takeover:

```text
              J.A.R.V.I.S.

           ROOM CONTROL PLANE


              ● MAIN
                │
        ┌───────┼────────┐
        │       │        │
        ●       ●        ●
      ALPHA    BETA    GAMMA


        4 / 4 NODES ONLINE

            JARVIS-NET
```

Display:

- connected nodes
- OS
- latency/heartbeat
- current scene
- execution status
- recent commands

The UI should be visually cinematic but readable from a distance.

---

# 19. Controller Web App

Route:

```text
/control
```

Mobile-friendly.

It must work with no LLM and no internet.

Suggested UI:

```text
J.A.R.V.I.S.

NODES
MAIN        ●
ALPHA       ●
BETA        ●
GAMMA       ●


[ TAKE THE ROOM ]

[ RELEASE ROOM ]

[ IDENTIFY NODE ]

[ OPEN APP ]

[ OPEN URL ]

[ MOVE JARVIS ]

[ RED ALERT ]

[ REACTOR ]

[ BLACKOUT ]

[ RESTORE ]
```

Node selector:

```text
ALL
MAIN
ALPHA
BETA
GAMMA
```

This UI is the guaranteed fallback for the live demo.

---

# 20. Scenes

Scenes should be reusable cinematic states.

Required:

```text
normal
jarvis
identify
reactor
red_alert
blackout
network
gdg
terminal
```

Command:

```json
{
  "action": "show_scene",
  "args": {
    "scene": "reactor"
  }
}
```

Scenes are rendered by the overlay/browser layer.

---

# 21. Identify Function

Example:

```text
identify("BETA")
```

BETA should immediately show:

```text
BETA
BETA
BETA

IDENTIFIED
```

or flash/highlight strongly.

The Command Wall simultaneously highlights BETA.

This is essential because it proves the system controls laptops independently.

---

# 22. Move JARVIS

Implement:

```text
move_scene(source, destination)
```

Example:

```text
move_scene("MAIN", "ALPHA")
```

Behavior:

1. MAIN begins animation of JARVIS orb leaving.
2. At synchronized timestamp, MAIN hides JARVIS.
3. ALPHA displays incoming JARVIS animation.
4. ALPHA becomes active JARVIS node.

Commands:

```text
"Jarvis, move to Alpha."
"Go to Beta."
"Come back."
```

No actual process migration is implied.

This is visual choreography.

---

# 23. Split JARVIS

Implement:

```text
broadcast_scene("jarvis")
```

Stage command:

```text
"Jarvis, split yourself."
```

JARVIS simultaneously appears on every connected machine.

This should be visually dramatic.

---

# 24. Cascade Animation

Implement a synchronized cross-screen animation.

Physical order can be configured:

```json
[
  "ALPHA",
  "BETA",
  "GAMMA",
  "MAIN"
]
```

Example:

```text
cascade("arc_reactor")
```

A beam or object appears to travel:

```text
ALPHA → BETA → GAMMA → MAIN
```

Use a server-issued future timestamp:

```json
{
  "scene": "cascade",
  "startAt": 1234567890,
  "position": 2
}
```

Each client computes its animation relative to the shared start time.

Do not attempt millisecond-perfect synchronization; visually convincing synchronization is sufficient.

---

# 25. JARVIS MCP Server

Run MCP on the Presenter Mac.

It translates LLM tool calls into requests to JARVIS Core.

Required tools:

```text
list_nodes()

get_node(node)

takeover(target)

release(target)

identify(target)

open_app(target, app)

open_url(target, url)

show_scene(target, scene)

broadcast_scene(scene)

move_jarvis(destination)

speak(text)

set_volume(target, volume)
```

Example:

```python
@mcp.tool()
def takeover(target: str):
    """
    Take over one authorized JARVIS display or all displays.
    target may be a node ID or ALL.
    """
```

The MCP layer must contain NO operating-system-specific logic.

It talks only to JARVIS Core.

---

# 26. JARVIS Core REST API

Suggested endpoints:

```text
GET  /api/nodes
GET  /api/nodes/:id

POST /api/command
POST /api/takeover
POST /api/release
POST /api/scene
```

Example:

```http
POST /api/command
Authorization: Bearer <ADMIN_TOKEN>
Content-Type: application/json
```

```json
{
  "target": "ALPHA",
  "action": "open_app",
  "args": {
    "app": "chrome"
  }
}
```

---

# 27. Authentication

There are three trust levels.

## Device Agent

Per-device token.

```text
ALPHA_TOKEN
BETA_TOKEN
GAMMA_TOKEN
MAIN_TOKEN
```

## Controller

Admin token.

## MCP Server

Admin token.

The WebSocket registration handshake must validate the node token before accepting the client.

No anonymous remote control.

---

# 28. Security Requirements

This is a demonstration control platform for explicitly enrolled team devices.

Mandatory restrictions:

- Never scan or attempt to control unrelated devices.
- Only explicitly configured Node IDs may register.
- Each agent must have a secret token.
- No arbitrary shell execution.
- No arbitrary PowerShell.
- No arbitrary AppleScript from LLM input.
- Applications must be allowlisted.
- URLs must use `http://` or `https://`.
- Reject `file://`.
- Reject `javascript:`.
- Reject custom schemes unless explicitly allowlisted.
- Core should preferably listen only on the JARVIS private interface.
- Log every remote action.
- `release(ALL)` must always remain available.
- Ctrl+C on an agent must immediately stop remote control capability.

---

# 29. Internet / Antigravity Arrangement

The local JARVIS system does not require internet.

For the cloud LLM:

```text
JARVIS local traffic
Presenter Mac Wi-Fi
        │
        ▼
JARVIS-NET
        │
        ▼
Kali Core
```

Internet:

```text
Antigravity traffic
Presenter Mac
        │
      USB
        │
      iPhone
        │
     Cellular
        │
     Internet
```

The Mac is therefore dual-homed.

Verify:

```bash
route -n get 10.42.0.1
```

should use Wi-Fi.

Default internet route should use iPhone USB.

If internet fails:

```text
Controller Web App
→ still works.

Agents
→ still work.

Takeover
→ still works.

Scenes
→ still work.

Open local URLs
→ still works.

Antigravity
→ unavailable.
```

This separation is mandatory.

---

# 30. Voice/LLM Behavior

The LLM should behave as a thin natural-language orchestration layer.

System instructions:

```text
You are JARVIS, the control intelligence for an IoT demonstration.

Use the jarvis-room MCP tools to interact with authorized devices.

Keep spoken answers concise.

Never invent device names.

Always call list_nodes when the user references a device ambiguously.

Never request capabilities not advertised by a node.

"Take the room" means takeover target ALL.

"Release the room" means release target ALL.

"Move to X" means move_jarvis(X).

"Split yourself" means broadcast the jarvis scene.

Never perform an arbitrary shell command.

Address the presenter as "sir" occasionally, but do not overdo it.
```

Example interaction:

```text
Presenter:
Jarvis, you there?

JARVIS:
Yes, sir.
```

```text
Presenter:
How many systems do you have?

LLM:
→ list_nodes()

JARVIS:
Four authorized systems are online.
```

```text
Presenter:
Which one is running Windows?

LLM:
→ list_nodes()

JARVIS:
Beta.
```

```text
Presenter:
Take Beta and open Chrome.

LLM:
→ takeover("BETA")
→ open_app("BETA", "chrome")
```

---

# 31. Spoken Output

Preferred:

Presenter Mac performs JARVIS speech.

On macOS:

```bash
say "Yes, sir."
```

MCP:

```text
speak("Yes, sir.")
```

The LLM should not generate long speeches.

Responses should normally be under approximately 10 words during the live demonstration.

---

# 32. Recommended Demo Sequence

## Phase 1 — intentionally boring

Presenter explains:

```text
Sensors
Actuators
ESP32
MQTT
Gateways
IoT
```

Then:

> “Y'all bored yet?”

Presenter comes off stage.

---

## Phase 2 — takeover

Manual controller triggers:

```text
TAKEOVER ALL
```

All screens progressively switch into JARVIS mode.

Command Wall appears.

Then:

> “Jarvis, you there?”

Response:

> “Yes, sir.”

---

## Phase 3 — prove independence

> “How many systems are online?”

> “Four authorized systems.”

> “Which one is Windows?”

> “Beta.”

> “Identify Beta.”

Only Beta flashes.

---

## Phase 4 — OS control

> “Take Beta.”

Beta changes.

> “Open Chrome.”

Chrome launches.

> “Open our chapter site.”

Chrome opens the URL.

---

## Phase 5 — distributed control

> “Jarvis, move to Alpha.”

JARVIS appears on Alpha.

> “Now Gamma.”

Moves.

> “Come back.”

Returns to MAIN.

> “Split yourself.”

JARVIS appears everywhere.

---

## Phase 6 — cinematic sequence

> “Jarvis, reactor sequence.”

Run:

```text
ALPHA → BETA → GAMMA → MAIN
```

with synchronized visual animation.

---

## Phase 7 — reveal architecture

Command Wall switches to:

```text
VOICE
  ↓
LLM
  ↓
MCP
  ↓
JARVIS CORE
  ↓
DEVICE AGENTS
  ↓
OPERATING SYSTEM
```

Explain that all endpoints voluntarily enrolled in the environment.

---

## Phase 8 — release

> “Jarvis, release the room.”

Every overlay disappears.

Every teammate gets their original desktop back.

Presentation slides return.

Closing statement:

> “IoT isn't about connecting devices to the internet. It's about making an environment programmable.”

---

# 33. Failure-Safe Controls

The system must include a giant:

```text
RELEASE ALL
```

button.

Keyboard shortcut on Presenter Mac:

```text
Cmd/Ctrl + Shift + Escape
```

suggested to trigger:

```text
release(ALL)
```

Kali should also expose:

```bash
curl -X POST \
  -H "Authorization: Bearer <TOKEN>" \
  http://localhost:3000/api/release \
  -d '{"target":"ALL"}'
```

Each agent must also support local termination.

---

# 34. Logging

Core should log:

```text
timestamp
commandId
source
target
action
status
execution time
error
```

Example:

```text
17:01:04 MAIN registered
17:01:05 ALPHA registered
17:01:07 BETA registered
17:04:32 TAKEOVER → ALL
17:04:34 success MAIN
17:04:34 success ALPHA
17:04:34 success BETA
17:05:21 OPEN_APP chrome → BETA
17:05:22 success BETA
```

The Command Wall may optionally show this as a scrolling “system activity” panel.

---

# 35. Packaging

The final teammate experience should NOT require installing development dependencies during the event.

Preferred deliverables:

macOS:

```text
JarvisAgent-macOS
```

Windows:

```text
JarvisAgent.exe
```

Use PyInstaller or equivalent after development.

Example:

```bash
pyinstaller \
  --onefile \
  jarvis_agent.py
```

The agent should accept:

```text
--node
--token
--server
```

Example teammate instructions:

```text
1. Join Wi-Fi: JARVIS-NET

2. Run:

JarvisAgent.exe \
  --node BETA \
  --token <provided-token> \
  --server http://10.42.0.1:3000

3. Leave it running.

4. Use your laptop normally.
```

macOS equivalent:

```bash
./JarvisAgent \
  --node ALPHA \
  --token <provided-token> \
  --server http://10.42.0.1:3000
```

---

# 36. Nice-to-Have: Auto Discovery

Once the basic system is stable, optionally allow agents to discover JARVIS Core using mDNS:

```text
jarvis.local
```

Then the teammate command becomes:

```text
JarvisAgent --node ALPHA --token ...
```

instead of specifying `10.42.0.1`.

DO NOT make discovery mandatory for the first build.

IP configuration is more predictable.

---

# 37. Nice-to-Have: Latency Display

Core can ping/measure Socket.IO heartbeat latency.

Command Wall:

```text
MAIN       3 ms
ALPHA      5 ms
BETA       8 ms
GAMMA      4 ms
```

This makes the system feel more like a real control network.

---

# 38. Nice-to-Have: Fake “Acquisition” Visuals, Real Control

The theatrical text may say:

```text
NODE ACQUIRED
REMOTE CONTROL ESTABLISHED
```

But technical explanations must clarify:

```text
AUTHORIZED NODE
CONTROL CHANNEL ESTABLISHED
```

The system is orchestration, not unauthorized hacking.

---

# 39. Important Reliability Rule

The initial:

```text
TAKE THE ROOM
```

must be manually triggerable from `/control`.

Do NOT depend on Antigravity or voice recognition for the first major cinematic moment.

Recommended:

```text
Manual TAKEOVER
        ↓
JARVIS appears
        ↓
Then live LLM/MCP interaction begins
```

If the AI fails later, manual control remains available.

---

# 40. Required Acceptance Tests

The coding agent must not consider the project complete until these tests pass.

### Network

- Kali hotspot works without internet.
- Mac and Windows clients receive IPs.
- Clients reach `JARVIS Core`.
- Clients can communicate simultaneously.

### Enrollment

- Valid agent registers.
- Invalid token is rejected.
- Offline agent disappears after heartbeat timeout.

### Takeover

- `takeover(ALPHA)` affects only ALPHA.
- `takeover(ALL)` affects all authorized nodes.
- No browser page needs to be open beforehand.
- Existing user applications survive underneath the overlay.

### Release

- `release(ALPHA)` restores ALPHA.
- `release(ALL)` restores all systems.
- Normal browser sessions are not terminated.

### Application launch

- `open_app(ALPHA, chrome)` works on macOS.
- Windows equivalent works on BETA.
- Non-allowlisted application is rejected.

### URL

- `open_url()` opens HTTP/HTTPS URLs.
- `file://` is rejected.
- `javascript:` is rejected.

### Scenes

- Scenes can be changed individually.
- Scenes can broadcast globally.
- Identify works.
- Move JARVIS works.
- Cascade animation works acceptably.

### Controller

- `/control` works without internet.
- Emergency `RELEASE ALL` works.

### MCP

- `list_nodes()` returns live nodes.
- MCP can call takeover.
- MCP can call release.
- MCP can open an allowlisted application.
- MCP can show a scene.
- MCP cannot execute arbitrary OS commands.

### Internet separation

With internet disconnected:

- local control still functions.

With iPhone USB internet connected:

- Antigravity can access the internet.
- Presenter Mac can still reach JARVIS Core over Wi-Fi.

---

# 41. Development Priority

Implement in this order.

## Milestone 1

```text
Kali Core
+
one Mac agent
+
registration
+
takeover/release
```

Do not continue until this is reliable.

## Milestone 2

```text
Windows agent
+
multi-node registry
+
Command Wall
+
Controller
```

## Milestone 3

```text
open_app
open_url
identify
speak
```

## Milestone 4

```text
scenes
move JARVIS
split JARVIS
cascade
```

## Milestone 5

```text
MCP server
```

## Milestone 6

```text
Antigravity / voice integration
```

## Milestone 7

```text
packaged executables
rehearsal
failure handling
```

Do NOT begin by integrating the LLM.

The local orchestration platform is the product.

The LLM is merely one interface to it.

---

# 42. Final Deliverables Expected from Coding Agent

Provide:

```text
1. Complete source repository.

2. Kali JARVIS Core.

3. macOS JARVIS Agent.

4. Windows JARVIS Agent.

5. Mobile-friendly Controller UI.

6. JARVIS Command Wall.

7. Fullscreen overlay system.

8. Cinematic scenes.

9. MCP server.

10. Configuration templates.

11. Per-node token authentication.

12. Emergency release mechanism.

13. Packaged Mac/Windows client builds.

14. Setup instructions.

15. Rehearsal checklist.

16. Troubleshooting guide.
```

The repository README must allow a new operator to bring up the entire local environment from scratch.

---

# 43. Definition of Success

The final demonstration should allow the following interaction with no teammate touching their computer after running the agent:

```text
Presenter:
“Y'all bored yet?”
```

Presenter triggers takeover.

All displays switch to JARVIS.

```text
Presenter:
“Jarvis, you there?”
```

```text
JARVIS:
“Yes, sir.”
```

```text
Presenter:
“How many systems do you have?”
```

```text
JARVIS:
“Four authorized systems are online.”
```

```text
Presenter:
“Identify the Windows machine.”
```

BETA flashes.

```text
Presenter:
“Take it.”
```

BETA enters JARVIS mode.

```text
Presenter:
“Open Chrome.”
```

Chrome launches.

```text
Presenter:
“Move to Alpha.”
```

JARVIS visually moves to ALPHA.

```text
Presenter:
“Split yourself.”
```

JARVIS appears across every laptop and the Command Wall.

```text
Presenter:
“Release the room.”
```

All overlays disappear and the computers return to exactly what their users were doing beforehand.

That is the target experience.

---

# 44. Final Design Philosophy

The demo should look like unauthorized science-fiction-level control while technically being a clean, authorized distributed IoT control plane.

The audience experiences:

```text
JARVIS took over the room.
```

The engineering underneath is:

```text
private network
+
authenticated device enrollment
+
persistent command channels
+
capability discovery
+
event-driven orchestration
+
native OS agents
+
distributed web interfaces
+
MCP
+
LLM tool calling
```

The spectacle gets their attention.

The architecture is what makes it a legitimate IoT demonstration.