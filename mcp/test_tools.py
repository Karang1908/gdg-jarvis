#!/usr/bin/env python3
"""End-to-end MCP test.

Calls every tool the server registers against a live Core with real devices attached.

As with the API suite, the tool list is read from the server rather than written here: a
tool nobody adds a case for fails the run. The bugs worth catching are the ones where a
tool kept its name while the thing underneath it was renamed, which a hand-written list
would never notice.

    JARVIS_CORE_URL=... JARVIS_ADMIN_TOKEN=... python3 mcp/test_tools.py

Expects Core already running with three devices enrolled; core/test/mcp.test.js sets that
up and invokes this.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import sys

GREEN, RED, DIM, RESET = "\x1b[32m", "\x1b[31m", "\x1b[90m", "\x1b[0m"

failures = 0
checks = 0
called: set[str] = set()


def check(name: str, ok: bool, detail: str = "") -> None:
    global failures, checks
    checks += 1
    if ok:
        print(f"  {GREEN}✓{RESET} {name}")
    else:
        failures += 1
        print(f"  {RED}✗{RESET} {name}")
        if detail:
            print(f"      {detail[:300]}")


def load_server():
    here = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location("jarvis_mcp", os.path.join(here, "server.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def call(module, name: str, **kwargs):
    """Invoke a tool by name, recording that it was covered."""
    called.add(name)
    return getattr(module, name)(**kwargs)


async def main() -> int:
    mod = load_server()

    print("\nJARVIS — MCP tools\n")

    print("Server")
    tools = sorted(t.name for t in await mod.mcp.list_tools())
    check(f"{len(tools)} tools registered", len(tools) > 0, ", ".join(tools))

    forbidden = {"run_shell", "run_powershell", "run_command", "execute_code", "eval"}
    check("no shell-execution tool exposed", not (forbidden & set(tools)))

    prompts = [p.name for p in await mod.mcp.list_prompts()]
    check("personality exposed as a prompt", "jarvis" in prompts, str(prompts))
    check(
        f"instructions carry the personality ({len(mod.PERSONALITY.split())} words)",
        len(mod.PERSONALITY.split()) > 50,
        f"source={mod.PERSONALITY_SOURCE}",
    )

    print("\nReading")
    room = call(mod, "list_devices")
    check("list_devices returns the room", room.get("ok") and room["online"] == 3, json.dumps(room)[:200])
    check("devices carry number, hostname and os",
          all({"device", "hostname", "os"} <= set(d) for d in room["devices"]),
          json.dumps(room["devices"][:1]))

    check("get_device by number", call(mod, "get_device", device="2").get("ok"))
    check("get_device by hostname", call(mod, "get_device", device="ravi").get("ok"))

    unknown = call(mod, "get_device", device="nope")
    check("get_device refuses an unknown one and lists the real ones",
          unknown.get("error") == "device_unknown" and unknown.get("known_devices"),
          json.dumps(unknown)[:200])

    voice = call(mod, "voice_status")
    check("voice_status reports the provider", voice.get("ok") and "provider" in voice, json.dumps(voice)[:200])

    # The microphone belongs to Core, so the model can ask about it and close it. Reading
    # the state is asserted; whether this machine has recording hardware is not the test's
    # business, so `listening` is only required to agree with `available`.
    mic = call(mod, "microphone")
    check("microphone reports its own state",
          mic.get("ok") and mic.get("listening") == mic.get("available"), json.dumps(mic)[:200])
    check("microphone can be closed",
          call(mod, "microphone", on=False).get("listening") is False, json.dumps(mic)[:200])

    print("\nCommanding")

    def reached(name: str, result: dict, wanted: int) -> None:
        check(f"{name} reached {wanted}", result.get("count") == wanted, json.dumps(result)[:220])

    reached("takeover ALL", call(mod, "takeover", target="ALL"), 3)
    reached("identify", call(mod, "identify", target="2"), 1)
    reached("show_scene", call(mod, "show_scene", target="1", scene="reactor"), 1)
    reached("broadcast_scene", call(mod, "broadcast_scene", scene="jarvis"), 3)
    reached("cascade", call(mod, "cascade"), 3)
    reached("open_app", call(mod, "open_app", target="1", app="chrome"), 1)
    reached("open_url", call(mod, "open_url", target="1", url="https://example.com"), 1)
    reached("set_volume", call(mod, "set_volume", target="1", volume=40), 1)

    move = call(mod, "move_jarvis", destination="3")
    check("move_jarvis works", move.get("ok"), json.dumps(move)[:200])

    spoken = call(mod, "speak", text="Integration test.")
    check("speak uses JARVIS's own voice", spoken.get("ok") and "spoken" in spoken, json.dumps(spoken)[:200])

    reached("release ALL", call(mod, "release", target="ALL"), 3)

    print("\nManaging")
    check("mute", call(mod, "mute", target="ALL", muted=True).get("ok"))
    check("unmute", call(mod, "mute", target="ALL", muted=False).get("ok"))
    check("set_main", call(mod, "set_main", device="2").get("main") == 2)

    renumbered = call(mod, "renumber_device", device="3", to=1)
    check("renumber_device swaps and reports it",
          renumbered.get("ok") and renumbered.get("swapped_with"), json.dumps(renumbered)[:200])

    check("overlay_url mints a link", "ticket=" in str(call(mod, "overlay_url", device="1").get("url")))
    check("reload_personality", call(mod, "reload_personality").get("ok"))

    noted = call(mod, "remember", fact="integration test note")
    check("remember writes a fact", noted.get("ok"), json.dumps(noted)[:200])
    check("forget_device", call(mod, "forget_device", device="2").get("ok"))

    print("\nRefusals")
    bad_app = call(mod, "open_app", target="1", app="hacktool")
    check("non-allowlisted app refused with a reason",
          not bad_app.get("ok") and "app_not_allowlisted" in json.dumps(bad_app), json.dumps(bad_app)[:200])

    bad_url = call(mod, "open_url", target="1", url="file:///etc/passwd")
    check("file:// refused with a reason",
          not bad_url.get("ok") and "scheme_not_allowed" in json.dumps(bad_url), json.dumps(bad_url)[:200])

    print("\nCore unreachable")
    original = mod.CORE_URL
    mod.CORE_URL = "http://127.0.0.1:59999"
    down = call(mod, "list_devices")
    check("an unreachable Core is data, not an exception",
          down.get("error") == "core_unreachable", json.dumps(down)[:200])
    mod.CORE_URL = original

    print("\nCoverage")
    missed = sorted(set(tools) - called)
    check(f"all {len(tools)} tools exercised", not missed, f"never called: {', '.join(missed)}")

    print("")
    if failures == 0:
        print(f"{GREEN}PASS{RESET}  {checks} checks\n")
    else:
        print(f"{RED}FAIL{RESET}  {failures} of {checks} checks\n")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
