#!/usr/bin/env python3
"""JARVIS MCP server.

Translates tool calls from an AI client into requests to JARVIS Core, and nothing else.

SPEC.md §25 is emphatic that this layer contains no operating-system-specific logic, and
it does not: there is no subprocess call, no platform check, and no path anywhere in this
file. It speaks HTTP to Core and Core decides what any of it means. That boundary is what
keeps the LLM unable to reach a shell no matter what it is asked to do — the set of things
it can express is exactly the set of tools below.

Runs on the Presenter Mac beside the AI client:

    JARVIS_CORE_URL=http://10.42.0.1:3000 \\
    JARVIS_ADMIN_TOKEN=<admin token> \\
    python3 mcp/server.py

Every tool returns what actually happened, including the nodes it could not reach and
why. That matters more here than in the controller UI: an LLM told only "ok" will report
success to a room where half the screens did not move.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any

from mcp.server.mcpserver import MCPServer

CORE_URL = os.environ.get("JARVIS_CORE_URL", "http://10.42.0.1:3000").rstrip("/")
ADMIN_TOKEN = os.environ.get("JARVIS_ADMIN_TOKEN", "")
TIMEOUT_SECONDS = 8

# MCP SDK 2.x. FastMCP was renamed to MCPServer in 2.0; requirements.txt pins >=2 so this
# stays in step with the SDK an AI client will actually have installed.
mcp = MCPServer("jarvis-room")


# ---------------------------------------------------------------------------------------
# Core transport
# ---------------------------------------------------------------------------------------


def _call(path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """Call Core. Never raises — every failure comes back as data.

    An exception here would surface to the AI client as a tool error, which tends to make
    a model retry or invent an explanation. A structured failure lets it say the true
    thing: that Core did not answer.
    """
    url = f"{CORE_URL}{path}"
    data = None
    headers = {"Authorization": f"Bearer {ADMIN_TOKEN}"}

    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = urllib.request.Request(
        url, data=data, headers=headers, method="POST" if payload is not None else "GET"
    )

    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        if err.code == 401:
            return {
                "ok": False,
                "error": "unauthorized",
                "detail": "JARVIS_ADMIN_TOKEN is missing or wrong.",
            }
        return {"ok": False, "error": f"http_{err.code}"}
    except urllib.error.URLError as err:
        return {
            "ok": False,
            "error": "core_unreachable",
            "detail": f"No answer from {CORE_URL} ({err.reason}). Is Core running, and is "
            "this machine on JARVIS-NET?",
        }
    except Exception as err:  # noqa: BLE001 - a tool must never take the server down
        return {"ok": False, "error": "unexpected", "detail": str(err)}


def _summarise(result: dict[str, Any], action: str) -> dict[str, Any]:
    """Reduce a dispatch result to what is worth saying out loud.

    Keeps `skipped` intact rather than collapsing to a boolean. "Three of four" is a
    materially different sentence from "done", and only the node list can distinguish them.
    """
    if not result.get("ok") and result.get("error"):
        return {"ok": False, "action": action, "error": result["error"], **(
            {"detail": result["detail"]} if "detail" in result else {}
        )}

    dispatched = [entry["node"] for entry in result.get("dispatched", [])]
    skipped = result.get("skipped", [])

    summary: dict[str, Any] = {
        "ok": bool(dispatched),
        "action": action,
        "reached": dispatched,
        "count": len(dispatched),
    }
    if skipped:
        summary["skipped"] = [
            {"node": entry["node"], "reason": entry["reason"]} for entry in skipped
        ]
    return summary


# ---------------------------------------------------------------------------------------
# Inspection
# ---------------------------------------------------------------------------------------


@mcp.tool()
def list_devices() -> dict[str, Any]:
    """List every enrolled device and its live state.

    Devices are numbered 1, 2, 3 ... in the order they joined, and that number is how the
    presenter and the audience refer to them. Each also reports its hostname, which is how
    a person recognises their own laptop.

    Call this whenever the user refers to a machine ambiguously — "the Windows one", "the
    other laptop", "Ravi's". Never invent a device; the room is whoever actually joined,
    and this is the only place that list comes from.

    Watch `screen_awake`: a device that is online with a locked screen accepts commands and
    displays nothing. Say so rather than reporting it as ready. `muted` means it will not
    speak.
    """
    room = _call("/api/devices")
    if not room.get("ok", True) and room.get("error"):
        return room

    return {
        "ok": True,
        "online": room.get("summary", {}).get("online", 0),
        "known": room.get("summary", {}).get("known", 0),
        "wall": room.get("wall"),
        "devices": [
            {
                "device": device["number"],
                "hostname": device["hostname"],
                "os": device["os"],
                "online": device["online"],
                "showing": device["scene"] if device["hasOverlay"] else None,
                "screen_awake": device["displayAwake"],
                "muted": device["muted"],
                "is_wall": device["isWall"],
                "latency_ms": device["rttMs"],
                "can": device["capabilities"],
            }
            for device in room.get("devices", [])
        ],
        "apps_available": room.get("apps", []),
    }


@mcp.tool()
def get_device(device: str) -> dict[str, Any]:
    """Report one device's state in detail. Accepts a number or a hostname."""
    room = _call("/api/devices")
    if not room.get("ok", True) and room.get("error"):
        return room

    wanted = str(device).strip().lower()
    entries = room.get("devices", [])

    for entry in entries:
        if str(entry["number"]) == wanted:
            return {"ok": True, "device": entry}

    matches = [e for e in entries if wanted in (e.get("hostname") or "").lower()]
    if len(matches) == 1:
        return {"ok": True, "device": matches[0]}
    if len(matches) > 1:
        # Refusing beats guessing: taking over the wrong screen because two laptops share a
        # word in their name is not recoverable in front of an audience.
        return {
            "ok": False,
            "error": "device_ambiguous",
            "matches": [{"device": m["number"], "hostname": m["hostname"]} for m in matches],
        }

    return {
        "ok": False,
        "error": "device_unknown",
        "known_devices": [{"device": e["number"], "hostname": e["hostname"]} for e in entries],
    }


# ---------------------------------------------------------------------------------------
# Presence
# ---------------------------------------------------------------------------------------


@mcp.tool()
def takeover(target: str = "ALL") -> dict[str, Any]:
    """Take over one enrolled device, or the whole room.

    `target` is a device number or "ALL". "Take the room" means ALL.

    Each machine puts a fullscreen JARVIS surface over whatever its user was doing. Their
    work is untouched underneath and comes back on release — nothing is closed, moved, or
    minimised.
    """
    return _summarise(_call("/api/takeover", {"target": target}), "takeover")


@mcp.tool()
def release(target: str = "ALL") -> dict[str, Any]:
    """Give the screens back. `target` is a device number or "ALL".

    "Release the room" means ALL. Every overlay closes and each user's desktop returns
    exactly as they left it.

    This is the failure-safe action. If anything at all seems wrong, this is always the
    right thing to call, and calling it when it was not needed costs nothing.
    """
    return _summarise(_call("/api/release", {"target": target}), "release")


@mcp.tool()
def identify(target: str) -> dict[str, Any]:
    """Make one device announce itself.

    That device fills its screen with its own number and highlights on the Command Wall.
    Nothing else in the room reacts.

    This is how the audience is shown that the machines are addressed independently, so it
    is worth using whenever someone asks which machine is which.
    """
    return _summarise(_call("/api/identify", {"target": target}), "identify")


# ---------------------------------------------------------------------------------------
# Applications and URLs
# ---------------------------------------------------------------------------------------


@mcp.tool()
def open_app(target: str, app: str) -> dict[str, Any]:
    """Open an allowlisted application on a device.

    `app` is a logical name — "chrome", "vscode", "spotify" — never a path, a filename, or
    a command. list_devices() returns the names that exist under `apps_available`; anything
    else is refused, and the refusal comes back as a skipped node with a reason.

    The same logical name works on macOS and Windows; each device resolves it locally.
    """
    return _summarise(
        _call("/api/command", {"target": target, "action": "open_app", "args": {"app": app}}),
        "open_app",
    )


@mcp.tool()
def open_url(target: str, url: str) -> dict[str, Any]:
    """Open a web page on a device.

    Only http:// and https:// are accepted. Anything else — a file path, a custom scheme —
    is refused by Core before it reaches the machine.
    """
    return _summarise(
        _call("/api/command", {"target": target, "action": "open_url", "args": {"url": url}}),
        "open_url",
    )


# ---------------------------------------------------------------------------------------
# Scenes and choreography
# ---------------------------------------------------------------------------------------


@mcp.tool()
def show_scene(target: str, scene: str) -> dict[str, Any]:
    """Change what a device is displaying.

    Scenes: jarvis, reactor, identify, red_alert, blackout, network, gdg, terminal, wall,
    normal.

    `network` draws the architecture of this system, and is the right scene when the
    presenter starts explaining how the demo works. `gdg` is the closing scene.

    The device must already have been taken over.
    """
    return _summarise(_call("/api/scene", {"target": target, "scene": scene}), "show_scene")


@mcp.tool()
def broadcast_scene(scene: str = "jarvis") -> dict[str, Any]:
    """Show the same scene on every screen at once.

    "Split yourself" means broadcast_scene("jarvis"). The screens light up near
    simultaneously, which is the intended effect — it should read as one event, not as a
    sequence.
    """
    return _summarise(_call("/api/broadcast", {"scene": scene}), "broadcast_scene")


@mcp.tool()
def move_jarvis(destination: str) -> dict[str, Any]:
    """Move JARVIS from wherever it is to one device.

    "Move to two", "go to Ravi's", "come back". The orb animates off one screen and onto
    the next.

    Purely visual. Nothing migrates between machines; every node keeps running its own
    agent throughout.
    """
    return _summarise(_call("/api/move", {"to": destination}), "move_jarvis")


@mcp.tool()
def cascade(effect: str = "arc_reactor", reverse: bool = False) -> dict[str, Any]:
    """Run a beam across every screen in the room, in physical order.

    "Reactor sequence", "cascade". Each machine animates on a short delay from the one
    before it, so the effect appears to travel along the row of laptops.
    """
    return _summarise(_call("/api/cascade", {"effect": effect, "reverse": reverse}), "cascade")


# ---------------------------------------------------------------------------------------
# Voice and audio
# ---------------------------------------------------------------------------------------


@mcp.tool()
def speak(text: str, target: str = "ALL") -> dict[str, Any]:
    """Say something out loud. Defaults to every device.

    Keep it under about ten words. This is a live demonstration in front of an audience,
    and a long spoken answer stops being JARVIS and starts being a screen reader.
    """
    return _summarise(_call("/api/speak", {"target": target, "text": text}), "speak")


@mcp.tool()
def set_volume(target: str, volume: int) -> dict[str, Any]:
    """Set a device's output volume, 0 to 100."""
    return _summarise(
        _call(
            "/api/command",
            {"target": target, "action": "set_volume", "args": {"level": volume}},
        ),
        "set_volume",
    )


@mcp.tool()
def mute(target: str = "ALL", muted: bool = True) -> dict[str, Any]:
    """Stop or resume JARVIS speaking on a device, or across the room.

    A muted device still executes everything — it just makes no sound. Use this when the
    presenter says "be quiet", "stop talking", or "mute yourself", and unmute with
    muted=False.
    """
    result = _call("/api/mute", {"target": target, "muted": muted})
    if result.get("error"):
        return {"ok": False, "action": "mute", "error": result["error"]}
    return {
        "ok": True,
        "action": "mute" if muted else "unmute",
        "changed": result.get("changed", []),
    }


# ---------------------------------------------------------------------------------------


if __name__ == "__main__":
    if not ADMIN_TOKEN:
        # Fail at startup rather than on the first tool call. A model that receives an
        # authorization error mid-conversation tends to retry rather than report it, and
        # the presenter would see silence instead of a cause.
        raise SystemExit(
            "JARVIS_ADMIN_TOKEN is not set.\n"
            "  It is the `admin.token` value in core/config/core.json on the Core machine."
        )

    mcp.run()
