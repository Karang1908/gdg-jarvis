# Rehearsal

Two things live here: the acceptance tests from SPEC.md §40, and the run-of-show.

Tests are marked by what they need.

| | |
| --- | --- |
| **[sim]** | Passes with `scripts/sim-node.sh`. Run these at your desk, often. |
| **[hw]** | Needs real laptops. Nothing else can prove it. |
| **[net]** | Needs JARVIS-NET actually up on the Kali machine. |

A **[hw]** test that has only ever passed in simulation has not passed. The simulator
deliberately never opens a browser, so every claim about takeover rendering, release
restoring a desktop, or an overlay surviving a crash is untested until it runs on hardware.

---

## Before the day

### Network — [net]

- [ ] `sudo scripts/setup-kali.sh --check` reports AP mode supported.
- [ ] `JARVIS-NET` appears on a phone's Wi-Fi list.
- [ ] A Mac and a Windows laptop both get `10.42.0.x` addresses.
- [ ] Both reach `http://10.42.0.1:3000/healthz`.
- [ ] All of the above with the Kali machine's ethernet unplugged and no internet anywhere.

### Enrollment — [sim] then [hw]

- [ ] A valid agent registers and appears on the wall within a second.
- [ ] A wrong token is refused. Core logs `register refused … bad_token`.
- [ ] An unknown node ID is refused.
- [ ] Killing an agent removes it from the wall **immediately**, not after 15 seconds.
      Presence follows the stream, not the heartbeat.
- [ ] An agent restarted after a Wi-Fi drop comes back on its own, without being touched.

### Takeover and release — [hw]

This is the group that matters. Everything else is recoverable; these are not.

- [ ] `takeover(ALPHA)` affects **only** ALPHA.
- [ ] `takeover(ALL)` reaches every node, staggered — it should read as propagation
      across the room, not as four screens changing at once.
- [ ] No browser window needed to be open on any machine beforehand.
- [ ] **The teammate's own Chrome, with tabs open, is still running underneath.**
- [ ] `release(ALPHA)` restores ALPHA and leaves the rest taken.
- [ ] `release(ALL)` restores everything.
- [ ] **After release, the teammate's own browser session is intact — same tabs, same
      windows, nothing closed.** This is the test the whole design turns on. Do it with a
      teammate who has real work open, and let them confirm.
- [ ] Ctrl+C on an agent tears down its overlay and gives that desktop back.
- [ ] `kill -9` on an agent — the overlay closes on its own within 45 seconds.
- [ ] Holding Escape on an overlay closes it with the network unplugged.
- [ ] Ctrl+C on **Core** releases every node on the way out.

### Applications and URLs — [sim] for refusals, [hw] for launches

- [ ] `open_app(ALPHA, chrome)` launches Chrome on macOS.
- [ ] `open_app(BETA, chrome)` launches it on Windows.
- [ ] A non-allowlisted name is refused, and the wall shows `argument refused`.
- [ ] `open_url` opens an `https://` page.
- [ ] `file:///etc/passwd` is refused with `scheme_not_allowed:file`.
- [ ] `javascript:alert(1)` is refused.
- [ ] An action name that does not exist (`run_shell`) is refused with `action_unknown`.

### Scenes — [hw]

- [ ] Each scene renders on a single node.
- [ ] `broadcast_scene` puts the same scene everywhere near-simultaneously.
- [ ] `identify(BETA)` flashes **only** BETA, and highlights BETA on the wall.
- [ ] `move_jarvis` reads as one thing travelling, not two copies existing.
- [ ] `cascade` travels along the row **in the order the laptops physically sit**. If not,
      fix `core/config/layout.json` — not the code.
- [ ] Every scene is legible from the back of the room. Actually walk back there.

### Controller — [sim]

- [ ] `/control/` works with the internet unplugged.
- [ ] A wrong admin token is refused; an unreachable Core says so differently.
- [ ] Every dispatch reports the nodes it skipped and why.
- [ ] **RELEASE ALL works from every scroll position, with any target selected.**

### MCP — [sim]

- [ ] `list_nodes()` returns live state.
- [ ] The model can take over, release, open an allowlisted app, and show a scene.
- [ ] There is no tool that executes an OS command. Confirm by listing the tools.
- [ ] With Core stopped, tools return `core_unreachable` rather than erroring.

### Internet separation — [hw] + [net]

The most confusing part of the setup, so test it deliberately.

- [ ] With the iPhone unplugged: control, takeover, scenes, and release all still work.
- [ ] With the iPhone tethered: `scripts/health-check.sh` reports the route to Core and
      the default route on **different** interfaces.
- [ ] The AI client reaches the internet while Core stays reachable over Wi-Fi.

---

## The day itself

### Two hours before

- [ ] Kali on mains power. Sleep disabled.
- [ ] `JARVIS-NET` up; `scripts/health-check.sh` clean from the presenter's Mac.
- [ ] Every teammate has joined and run their line. `4 / 4 NODES ONLINE`.
- [ ] **Every teammate's screen is unlocked**, and they know not to lock it. The agent
      holds the display awake but cannot unlock an already-locked screen.
- [ ] Full dry run of the sequence below, on the real hardware, in the real room.

### Ten minutes before

- [ ] `scripts/health-check.sh` again. Laptops move, sleep, and roam between Wi-Fi bands.
- [ ] Wall fullscreen on the display. Controller open on the phone, unlocked, screen
      timeout off.
- [ ] `/control/` scrolled so **RELEASE ALL** is under your thumb.
- [ ] Slides in front of the wall on the presenter's machine.

### Run of show

Follows SPEC.md §32. Times are the shape of it, not a script.

| | Beat | Trigger | What the room sees |
| --- | --- | --- | --- |
| 1 | The boring part | — | Sensors, actuators, MQTT, gateways. Deliberately flat. |
| | | | *"Y'all bored yet?"* Walk off stage. |
| 2 | **Take the room** | **Tap TAKE THE ROOM** | Every screen turns over, staggered. Wall appears. |
| | | *"Jarvis, you there?"* | *"Yes, sir."* |
| 3 | Prove independence | ask, or tap | *"Four authorized systems are online."* |
| | | *"Which one is Windows?"* | *"Beta."* |
| | | *"Identify Beta."* | Only Beta flashes. The wall highlights Beta. |
| 4 | OS control | | *"Take Beta."* → *"Open Chrome."* Chrome launches. |
| | | | *"Open our chapter site."* |
| 5 | Distributed | | *"Move to Alpha."* → *"Now Gamma."* → *"Come back."* |
| | | | *"Split yourself."* JARVIS appears everywhere. |
| 6 | Cinematic | | *"Reactor sequence."* Beam crosses the room. |
| 7 | The reveal | scene `network` | The architecture, named honestly. |
| 8 | **Release** | **Tap RELEASE ALL** | Every desktop returns. Slides come back. |

> "IoT isn't about connecting devices to the internet. It's about making an environment
> programmable."

**Step 2 is manual.** Not voice, not the LLM. It is the one moment that cannot be allowed
to fail, and speech recognition in a loud room is the least reliable thing in the stack.
Live interaction starts at step 3, once JARVIS is already on screen.

---

## When it goes wrong on stage

Every scripted line in the demo exists as a button under **JARVIS SAYS** on `/control/`.
If the voice layer mishears, stalls, or the venue is too loud — tap the line instead. The
room cannot tell the difference.

If a node does not respond, keep going. The wall will show it as offline, which is honest,
and a four-node demo works fine with three. Do not stop to debug in front of an audience.

If something is genuinely wrong: **RELEASE ALL**, then talk about the architecture. The
slides are still there and the story does not depend on the screens.
