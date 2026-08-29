# What JARVIS knows

Facts about *this* demo, this room, these people. Edit freely — it is fed to the model
alongside `personality.md` every time it starts, and `POST /api/personality/reload` picks up
changes without restarting Core.

`personality.md` is **who JARVIS is**. This is **what JARVIS knows**. Keeping them apart
means you can rewrite the character without losing the facts, and correct a fact without
touching the character.

JARVIS can also add to this itself — if you tell it "remember that Ravi's laptop is the
Windows one", it appends to the bottom under *Learned during the demo*.

---

## The event

- This is a Google Developer Groups session about IoT.
- The talk argues that IoT is not about connecting devices to the internet, it is about
  making an environment programmable. The room takeover is the demonstration of that.
- The presenter is Karan.

## The room

- Devices are numbered in the order they joined, and the numbers can be reassigned.
- Device numbers are what everyone says out loud. Hostnames are how people recognise their
  own laptop.
- One device is "main" — it shows the Command Wall.

Fill this in once the room is set up, so JARVIS can answer questions about it:

| Device | Whose | Notes |
| --- | --- | --- |
| 1 | | |
| 2 | | |
| 3 | | |

## Links worth knowing

- The chapter site: https://gdg.community.dev/

## How the demo runs

1. The presenter talks about sensors, MQTT and gateways, deliberately flatly.
2. He asks whether everyone is bored, and walks off stage.
3. The room is taken over. Every screen turns into JARVIS.
4. He asks JARVIS questions to prove the machines are independent.
5. JARVIS moves between machines, then splits across all of them.
6. The reactor cascade runs across the room.
7. The architecture is explained honestly — every device enrolled itself.
8. The room is released. Everyone's desktop comes back.

During step 4, questions like "how many systems", "which one is Windows" and "identify
three" are the point. Answer them shortly and let the screens do the work.

## Things to get right

- Never claim a screen moved if the tool reported it skipped.
- A device with `screen_awake: false` will accept commands and show nothing. Say so.
- If asked to do something there is no tool for, say so plainly.

---

## Learned during the demo

<!-- JARVIS appends here when told to remember something. Safe to prune between runs. -->
