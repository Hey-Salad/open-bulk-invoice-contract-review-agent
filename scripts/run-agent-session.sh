#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
AGENT_FILE="${AGENT_FILE:-$ROOT_DIR/config/agent-definition.json}"
INPUT_FILE="${INPUT_FILE:-$ROOT_DIR/config/session-input.txt}"
OUT_DIR="${OUT_DIR:-$ROOT_DIR/.agents-api-runs}"
PROJECT_ID="${OPENAI_PROJECT:-proj_mRsQVx3NjOamxeXH6UrLowoC}"
BASE_URL="${OPENAI_BASE_URL:-https://api.openai.com/v1}"
ENVIRONMENT_TYPE="${AGENTS_ENVIRONMENT_TYPE:-openai_hosted}"
VALID_ENVIRONMENTS="openai_hosted none"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 127
  fi
}

json_get() {
  python3 - "$1" "$2" <<'PY'
import json
import sys

path = sys.argv[1].split(".")
with open(sys.argv[2], "r", encoding="utf-8") as f:
    data = json.load(f)
for part in path:
    if isinstance(data, dict):
        data = data.get(part)
    else:
        data = None
        break
print("" if data is None else data)
PY
}

create_session_payload() {
  python3 - "$AGENT_ID" "$INPUT_FILE" "$ENVIRONMENT_TYPE" <<'PY'
import json
import sys

agent_id, input_path, environment_type = sys.argv[1:4]
with open(input_path, "r", encoding="utf-8") as f:
    initial_input = f.read().strip()

if not initial_input:
    raise SystemExit(f"Initial input file is empty: {input_path}")

print(json.dumps({
    "agent_id": agent_id,
    "environment": {"type": environment_type},
    "input": initial_input,
    "stream": True,
}))
PY
}

scan_stream() {
  python3 - "$1" <<'PY'
import json
import sys

path = sys.argv[1]
interesting = {
    "agent.session.created",
    "agent.session.in_progress",
    "agent.session.started",
    "agent.session.idle",
    "agent.session.environment.ready",
    "agent.session.environment.connected",
    "agent.session.environment.failed",
    "agent.session.turn.created",
    "agent.session.turn.in_progress",
    "agent.session.turn.completed",
    "agent.session.turn.failed",
    "agent.session.turn.cancelled",
    "agent.session.failed",
    "agent.session.requires_action",
    "agent.tool_call.created",
    "agent.tool_call.completed",
    "agent.tool_call.failed",
    "agent.session.turn.item.added",
    "agent.session.turn.item.done",
    "agent.session.item.created",
    "agent.session.item.updated",
    "agent.session.item.completed",
}
seen = []
session_id = None
assistant_text = []
tool_calls = []
commands = []
errors = []
requires_action = []

with open(path, "r", encoding="utf-8", errors="replace") as f:
    for raw in f:
        line = raw.strip()
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if payload == "[DONE]":
            continue
        try:
            event = json.loads(payload)
        except json.JSONDecodeError:
            continue
        event_type = event.get("type") or event.get("event")
        if event_type == "agent.session.turn.output_text.delta":
            assistant_text.append(event.get("delta", ""))
        if event.get("session_id"):
            session_id = event["session_id"]
        if isinstance(event.get("session"), dict) and event["session"].get("id"):
            session_id = event["session"]["id"]
        if event_type in interesting:
            seen.append(event_type)
        if event_type == "agent.session.requires_action":
            requires_action.append(event)
        item_type = event.get("item", {}).get("type", "") if isinstance(event.get("item"), dict) else ""
        if item_type == "command_execution" and event_type == "agent.session.turn.item.done":
            commands.append(event["item"])
        if "tool" in str(event_type or "") or event.get("tool_call") or item_type.endswith("_call") or item_type in {"web_search_call", "command_execution"}:
            tool_calls.append(event)
        if event.get("error"):
            errors.append(event["error"])

print(f"Session id: {session_id or 'not found in stream'}")
if assistant_text:
    print("\nAssistant text:")
    print("".join(assistant_text).strip())
if seen:
    print("\nImportant events:")
    for event_type in seen:
        print(f"- {event_type}")
else:
    print("No terminal or tool-call events were recognized. Inspect the raw stream log.")

if commands:
    print("\nCommand executions:")
    for command in commands[:20]:
        print(f"- {command.get('status', 'unknown')} exit={command.get('exit_code')}: {command.get('command')}")
    if len(commands) > 20:
        print(f"- ... {len(commands) - 20} more command executions")

if tool_calls:
    print("\nTool-call related events observed:")
    for event in tool_calls[:20]:
        event_type = event.get("type") or event.get("event") or "unknown"
        name = (
            event.get("name")
            or event.get("tool_name")
            or event.get("tool_call", {}).get("name")
            or event.get("item", {}).get("name")
            or event.get("item", {}).get("type")
            or "unnamed"
        )
        print(f"- {event_type}: {name}")
    if len(tool_calls) > 20:
        print(f"- ... {len(tool_calls) - 20} more tool-call events")

if errors:
    print("\nErrors reported in stream:")
    for error in errors:
        if isinstance(error, dict):
            print(f"- {error.get('message') or error}")
        else:
            print(f"- {error}")

if requires_action:
    print("\nThe session requested external tool results. This sample has no custom callback tools configured, so inspect the raw stream and add a tool-result handler before using tools that require application callbacks.")

terminal_failures = [event for event in seen if event.endswith(".failed") or event.endswith(".cancelled")]
if terminal_failures or requires_action:
    raise SystemExit(1)
PY
}

require_command curl
require_command python3

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  echo "Set OPENAI_API_KEY before running this script." >&2
  exit 2
fi

if [[ " $VALID_ENVIRONMENTS " != *" $ENVIRONMENT_TYPE "* ]]; then
  echo "Unsupported AGENTS_ENVIRONMENT_TYPE: $ENVIRONMENT_TYPE" >&2
  echo "Supported values: $VALID_ENVIRONMENTS" >&2
  exit 2
fi

if [[ ! -f "$AGENT_FILE" ]]; then
  echo "Agent definition not found: $AGENT_FILE" >&2
  exit 2
fi

if [[ ! -f "$INPUT_FILE" ]]; then
  echo "Initial input file not found: $INPUT_FILE" >&2
  exit 2
fi

mkdir -p "$OUT_DIR"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
AGENT_RESPONSE="$OUT_DIR/$RUN_ID-agent.json"
STREAM_LOG="$OUT_DIR/$RUN_ID-session.sse"

echo "Creating reusable agent from $AGENT_FILE"
curl --silent --show-error --fail-with-body \
  --request POST "$BASE_URL/agents" \
  --header "OpenAI-Beta: agents=v1" \
  --header "Authorization: Bearer $OPENAI_API_KEY" \
  --header "OpenAI-Project: $PROJECT_ID" \
  --header "Content-Type: application/json" \
  --data-binary "@$AGENT_FILE" \
  > "$AGENT_RESPONSE"

AGENT_ID="$(json_get id "$AGENT_RESPONSE")"
if [[ -z "$AGENT_ID" ]]; then
  echo "The create-agent response did not include an id. Response saved to $AGENT_RESPONSE" >&2
  exit 1
fi

echo "Created agent: $AGENT_ID"
echo "Starting streamed session in environment: $ENVIRONMENT_TYPE"

SESSION_PAYLOAD="$(create_session_payload)"
printf '%s' "$SESSION_PAYLOAD" | curl --no-buffer --show-error --fail-with-body \
  --request POST "$BASE_URL/agents/sessions" \
  --header "OpenAI-Beta: agents=v1" \
  --header "Authorization: Bearer $OPENAI_API_KEY" \
  --header "OpenAI-Project: $PROJECT_ID" \
  --header "Content-Type: application/json" \
  --data-binary @- \
  | tee "$STREAM_LOG"

echo
echo "Stream saved to $STREAM_LOG"
scan_stream "$STREAM_LOG"
