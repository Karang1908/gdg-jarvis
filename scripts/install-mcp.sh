#!/usr/bin/env bash
#
# Register the JARVIS MCP server with Antigravity.
#
#   scripts/install-mcp.sh                              # global, for the CLI and the IDE
#   scripts/install-mcp.sh --server http://10.42.0.1:3000
#   scripts/install-mcp.sh --workspace /path/to/project # project-local instead
#   scripts/install-mcp.sh --print                      # show the JSON, write nothing
#
# Antigravity 2.x shares one config across the IDE, the `agy` CLI, and the SDK:
#
#   global      ~/.gemini/config/mcp_config.json
#   workspace   <project>/.agents/mcp_config.json
#
# This merges into whichever file applies rather than overwriting it. That matters — the
# file very likely already has other MCP servers in it, and replacing it to add one entry
# would silently remove the rest.

set -uo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

SERVER_NAME="jarvis-room"
CORE_URL=""
TARGET=""
WORKSPACE=""
PRINT_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --server) CORE_URL="${2:-}"; shift 2 ;;
    --workspace) WORKSPACE="${2:-}"; shift 2 ;;
    --name) SERVER_NAME="${2:-jarvis-room}"; shift 2 ;;
    --print) PRINT_ONLY=1; shift ;;
    --help|-h) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }

if [ -n "$WORKSPACE" ]; then
  TARGET="${WORKSPACE%/}/.agents/mcp_config.json"
else
  TARGET="$HOME/.gemini/config/mcp_config.json"
fi

# ---------------------------------------------------------------------------------------
# What to register
# ---------------------------------------------------------------------------------------

bold ""
bold "JARVIS → Antigravity"
bold ""

CONFIG="$REPO_ROOT/core/config/core.json"
if [ ! -f "$CONFIG" ]; then
  bad "no core/config/core.json — run scripts/setup-kali.sh --secrets-only first"
  exit 1
fi

ADMIN_TOKEN=$(node -e "process.stdout.write(require('$CONFIG').admin.token)" 2>/dev/null)
if [ -z "$ADMIN_TOKEN" ]; then
  bad "could not read admin.token from core.json"
  exit 1
fi

# Default to whatever this machine can actually reach. On the Core machine that is its own
# LAN address; the presenter's Mac in a real room points at the Kali box instead.
if [ -z "$CORE_URL" ]; then
  LAN=$(ipconfig getifaddr en0 2>/dev/null || true)
  [ -n "$LAN" ] || LAN="127.0.0.1"
  CORE_URL="http://$LAN:3000"
  warn "no --server given; using $CORE_URL"
fi

# Prefer a virtualenv interpreter if one exists, because that is where the MCP SDK will be.
PYTHON="$REPO_ROOT/.venv/bin/python"
[ -x "$PYTHON" ] || PYTHON=$(command -v python3)
if [ -z "$PYTHON" ]; then
  bad "no python3 found"
  exit 1
fi

if ! "$PYTHON" -c "import mcp" >/dev/null 2>&1; then
  warn "the MCP SDK is not installed for $PYTHON"
  warn "  python3 -m venv .venv && .venv/bin/pip install -r mcp/requirements.txt"
fi

ok "core      $CORE_URL"
ok "python    $PYTHON"
ok "server    $REPO_ROOT/mcp/server.py"
ok "config    $TARGET"

# ---------------------------------------------------------------------------------------
# Merge
# ---------------------------------------------------------------------------------------

MERGED=$(node -e '
const fs = require("fs");
const path = require("path");

const [target, name, python, script, coreUrl, token, cwd] = process.argv.slice(1);

// Read whatever is already there. A malformed file is a stop, not something to overwrite:
// the user has other servers in it and losing them to fix ours is not a trade to make on
// their behalf.
let config = {};
if (fs.existsSync(target)) {
  const raw = fs.readFileSync(target, "utf8").trim();
  if (raw) {
    try {
      config = JSON.parse(raw);
    } catch (err) {
      console.error("EPARSE " + err.message);
      process.exit(3);
    }
  }
}

if (!config.mcpServers || typeof config.mcpServers !== "object") config.mcpServers = {};

const existing = Object.keys(config.mcpServers).filter((k) => k !== name);

config.mcpServers[name] = {
  command: python,
  args: [script],
  env: {
    JARVIS_CORE_URL: coreUrl,
    JARVIS_ADMIN_TOKEN: token,
  },
  cwd,
};

process.stdout.write(JSON.stringify(config, null, 2) + "\n");
process.stderr.write("KEPT " + existing.length + (existing.length ? " (" + existing.join(", ") + ")" : "") + "\n");
' "$TARGET" "$SERVER_NAME" "$PYTHON" "$REPO_ROOT/mcp/server.py" "$CORE_URL" "$ADMIN_TOKEN" "$REPO_ROOT" 2>"$REPO_ROOT/.mcp-merge-note")

STATUS=$?
NOTE=$(cat "$REPO_ROOT/.mcp-merge-note" 2>/dev/null)
rm -f "$REPO_ROOT/.mcp-merge-note"

if [ $STATUS -eq 3 ]; then
  bad "$TARGET is not valid JSON — fix or move it, then run this again"
  bad "${NOTE#EPARSE }"
  exit 1
fi
if [ $STATUS -ne 0 ]; then
  bad "could not build the configuration"
  exit 1
fi

case "$NOTE" in
  KEPT\ 0*) ok "no other MCP servers were configured" ;;
  KEPT*) ok "kept ${NOTE#KEPT }" ;;
esac

if [ "$PRINT_ONLY" -eq 1 ]; then
  bold ""
  printf '%s\n' "$MERGED"
  exit 0
fi

# The admin token is going into this file, so it is created inside a directory only the
# user can read and written 600.
mkdir -p "$(dirname "$TARGET")"
chmod 700 "$(dirname "$TARGET")" 2>/dev/null

if [ -f "$TARGET" ]; then
  cp "$TARGET" "$TARGET.jarvis-backup"
  ok "backed up to $(basename "$TARGET").jarvis-backup"
fi

printf '%s' "$MERGED" > "$TARGET"
chmod 600 "$TARGET"
ok "wrote $TARGET (mode 600)"

# ---------------------------------------------------------------------------------------

bold ""
bold "Next"
printf '\n'
printf '  1. Start Core, if it is not already running.\n'
printf '  2. Restart Antigravity so it re-reads the config.\n'
printf '  3. Ask it:  "how many devices are online?"\n'
printf '\n'
printf '  It has 14 tools. It cannot run a shell command through any of them.\n'
printf '\n'
warn "this file now contains the admin token — it is the key to every enrolled device"
printf '\n'
