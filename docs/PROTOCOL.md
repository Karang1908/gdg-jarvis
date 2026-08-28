# JARVIS Wire Protocol

Two audiences read this file: the shell agents, which must parse the wire with nothing
but builtins, and the browser clients, which get ordinary JSON. The agent-facing half is
therefore deliberately primitive.

Transport is HTTP/1.1 on the JARVIS private interface. Server-Sent Events carry
Core→client push; plain POST carries client→Core. Nothing here needs a websocket.

---

## 1. Channels

| Channel | Direction | Endpoint | Payload |
| --- | --- | --- | --- |
| Agent command | Core → agent | `GET /api/agent/stream` | tab-separated line |
| Agent report | agent → Core | `POST /api/agent/*` | form-encoded |
| Overlay | Core → browser overlay | `GET /api/overlay/stream` | JSON |
| Observer | Core → wall / controller | `GET /api/events` | JSON |
| Control | controller / MCP → Core | `POST /api/*` | JSON + bearer token |

An agent and its overlay hold **separate** connections. Core routes each action to
whichever channel can execute it, so the shell never has to relay anything to the
browser.

| Action | Goes to |
| --- | --- |
| `takeover` `release` `open_app` `open_url` `speak` `set_volume` `ping` | agent |
| `show_scene` `cascade` `move` `blackout` `red_alert` | overlay |
| `identify` | overlay if one is connected, otherwise agent |

`identify` is the exception because §21 requires it to work on a node that has not been
taken over. With no overlay connected, the agent opens one, shows the identify scene, and
closes it again.

---

## 2. Line format, agent channel

One command is one SSE `data:` line. Fields are separated by a literal TAB:

```
data: <commandId>\t<action>\t<key>=<value>\t<key>=<value>
```

Keys are bare `[a-z_]+`. **Values are percent-encoded**: every byte outside
`A-Za-z0-9-_.~` is written `%XX`. That guarantees no value can contain a TAB, a newline,
a backslash, or a quote, which is what makes the shell parse safe.

Decoding needs no external binary and no `jq`:

```bash
decode() { printf '%b' "${1//%/\\x}"; }
```

This is why the encoder escapes backslash too — `printf %b` would otherwise interpret it.

Keep-alive comment lines are sent every 15 seconds and MUST be ignored by clients:

```
: ping
```

### Example

```
data: 4f1c9e2a\ttakeover\turl=http%3A%2F%2F10.42.0.1%3A3000%2Foverlay%2F%3Fnode%3DALPHA%26ticket%3Dc9f2\tdelay=180
data: 7b30d5f1\tspeak\ttext=Yes%2C%20sir.\tvoice=Daniel
data: 91a4c7e0\trelease
```

---

## 3. Enrollment

```
POST /api/agent/register
Content-Type: application/x-www-form-urlencoded

node=ALPHA&token=<node token>&os=macos&host=Alice-MacBook
&caps=takeover,release,open_url,open_app,identify,speak,set_volume
&agent=1.0.0
```

Response is a single line of `text/plain`:

```
OK <sessionId> <heartbeatMs> <offlineMs>
```

or

```
REJECT unknown_node
REJECT bad_token
REJECT node_disabled
```

Per §9 and §28, a rejected client is never attached to the command stream. Core does not
distinguish `unknown_node` from `bad_token` in its response body beyond these labels, and
both are logged with the source address.

The session ID is required on every subsequent agent call. It is invalidated when the
stream closes, so a stale agent cannot keep acknowledging commands.

---

## 4. Command stream

```
GET /api/agent/stream?node=ALPHA&session=<sessionId>
Accept: text/event-stream
```

Core replies `200` with `Content-Type: text/event-stream` and holds the connection open.
A `401` means the session expired and the agent must re-register.

Presence is derived from **this connection**, not from heartbeats. When the stream drops,
Core marks the node offline immediately rather than waiting out a timeout. Heartbeats
remain as a liveness backstop for the case where the socket is held open by a wedged
client.

---

## 5. Heartbeat

Every 5 seconds:

```
POST /api/agent/heartbeat
node=ALPHA&session=<sid>&state=ready&overlay=1&awake=1&seq=42&rtt=7
```

| Field | Meaning |
| --- | --- |
| `state` | `ready` `busy` `overlay` — the agent's own view of itself |
| `overlay` | `1` if the agent currently owns a live overlay process |
| `awake` | `1` if the display wake lock is held (D3) |
| `seq` | monotonic counter; lets Core detect a restarted agent |
| `rtt` | milliseconds, measured by the agent on its *previous* heartbeat POST |

`rtt` is measured locally with `curl -w %{time_total}`, so it is a real round trip
computed entirely from one machine's clock. Core never subtracts two machines' clocks —
see D2.

Core marks a node offline after `offlineMs` (default 15000) without a heartbeat, or
immediately on stream close, whichever comes first.

---

## 6. Acknowledgement

```
POST /api/agent/ack
node=ALPHA&session=<sid>&cid=<commandId>&status=success&msg=Chrome%20launched
```

`status` is one of the five states in §11:

```
received  executing  success  failed  unsupported
```

An agent that receives an action it did not advertise replies `unsupported` and does
nothing else. It never guesses.

---

## 7. Control API

All control endpoints require the admin token:

```
Authorization: Bearer <ADMIN_TOKEN>
```

| Method | Path | Body |
| --- | --- | --- |
| `GET` | `/api/nodes` | — |
| `GET` | `/api/nodes/:id` | — |
| `POST` | `/api/command` | `{target, action, args}` |
| `POST` | `/api/takeover` | `{target}` |
| `POST` | `/api/release` | `{target}` |
| `POST` | `/api/scene` | `{target, scene}` |
| `POST` | `/api/broadcast` | `{scene}` |
| `POST` | `/api/move` | `{from, to}` |
| `POST` | `/api/cascade` | `{effect}` |
| `POST` | `/api/auth/ticket` | — |

`target` accepts a node ID or `ALL`.

Responses are JSON. A dispatch returns the command IDs it created so the caller can
correlate acknowledgements:

```json
{
  "ok": true,
  "dispatched": [
    { "commandId": "4f1c9e2a", "node": "ALPHA", "channel": "agent" },
    { "commandId": "5a2d8b13", "node": "BETA",  "channel": "agent" }
  ],
  "skipped": [
    { "node": "GAMMA", "reason": "offline" }
  ]
}
```

`skipped` is never silent. A node that is offline, disabled, or lacks the capability
appears there with a reason, because during a live demo the operator needs to know that
three of four screens moved.

---

## 8. Tickets

Browsers cannot set an `Authorization` header on an `EventSource`, and putting the admin
token in a query string would write it into history and access logs (D7). So Core issues
short-lived scoped tickets.

```
POST /api/auth/ticket        Authorization: Bearer <ADMIN_TOKEN>
  → { "ticket": "c9f2...", "expiresIn": 60 }
```

```
GET /api/events?ticket=c9f2...
```

Tickets are single-use, expire in 60 seconds, and are scoped to one purpose:

| Scope | Issued to | Grants |
| --- | --- | --- |
| `observer` | wall, controller | read-only state + activity stream |
| `overlay` | one specific node | that node's overlay stream only |

An `overlay` ticket is minted by Core when it builds a takeover URL. It cannot be used to
read the observer stream, and it cannot issue commands. A teammate who copies the URL out
of their own browser gains nothing but their own screen.

---

## 9. Choreography

Staggered effects carry `delay` in **milliseconds after receipt**, never an absolute
timestamp (D2).

```
data: 3c8f1a90\tshow_scene\tscene=reactor\tdelay=360
```

Core computes each node's delay from `config/layout.json`, which gives the physical
left-to-right order of the machines in the room:

```json
{ "order": ["ALPHA", "BETA", "GAMMA", "MAIN"], "stepMs": 180 }
```

Position *n* in that array receives `delay = n * stepMs`. The cascade therefore appears
to travel across the room in the direction the audience is facing, and reordering the
laptops is a config edit rather than a code change.

---

## 10. Validation

Enforced in Core, and independently again in the agent.

**URLs** — scheme must be exactly `http` or `https`. Everything else is rejected,
including `file`, `javascript`, `data`, and any custom scheme. This is an allowlist, not
a denylist (D7).

**Applications** — referenced only by logical name from `config/apps.json`. Core rejects
an unlisted name before dispatch. The agent holds its own copy of the platform mapping
and rejects anything not in it, so Core can never hand a node an executable path or a
shell string. Per §12 there is no action that carries a command line at all.

**Speech** — text is passed to the platform speech API as a single argument, never
through a shell. Length is capped; §31 wants short lines anyway.

**Volume** — integer, clamped to 0–100.
