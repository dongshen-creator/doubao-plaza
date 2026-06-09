#!/usr/bin/env python3
"""
Matrix Room Monitor with Qwen3-8B Bug Detection
Periodically checks a Matrix room for new messages,
analyzes them for bugs using Qwen3-8B, and triggers
opencode for auto-fixing if bugs are found.
"""

import requests
import json
import time
import os
import subprocess
import sys
from datetime import datetime

MATRIX_HS = os.environ.get("MATRIX_HOMESERVER", "https://chat.freserafim.com")
MATRIX_EMAIL = os.environ.get("MATRIX_BOT_EMAIL", "")
MATRIX_PASSWORD = os.environ.get("MATRIX_BOT_PASSWORD", "")
TARGET_ROOM_ID = "22dcbb7c-3e1f-460b-b5aa-d54ded7ee9a8"

QWEN_API_KEY = os.environ.get("QWEN_API_KEY", "sk-zDO94v33boke27kgx5hj5WgcDczcIPa7lz5W54RyuzPqVIfT")
QWEN_API_URL = os.environ.get("QWEN_API_URL", "https://chat-api4.087654.xyz/v1/chat/completions")
QWEN_MODEL = os.environ.get("QWEN_MODEL", "Qwen3/Qwen3-8B")

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_FILE = os.path.join(PROJECT_DIR, "scripts", "monitor_state.json")
CHECK_INTERVAL = int(os.environ.get("CHECK_INTERVAL", "300"))

def log(msg):
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)

def matrix_login():
    if not MATRIX_EMAIL or not MATRIX_PASSWORD:
        raise ValueError("Set MATRIX_BOT_EMAIL and MATRIX_BOT_PASSWORD env vars")
    resp = requests.post(f"{MATRIX_HS}/_matrix/client/v3/login", json={
        "type": "m.login.password",
        "identifier": {"type": "m.id.thirdparty", "medium": "email", "address": MATRIX_EMAIL},
        "password": MATRIX_PASSWORD
    }, timeout=30)
    data = resp.json()
    if "access_token" not in data:
        raise RuntimeError(f"Matrix login failed: {data}")
    log(f"Matrix login OK as {data.get('user_id', '?')}")
    return data["access_token"]

def sync_messages(token, since=None):
    params = {"timeout": 5000}
    if since:
        params["since"] = since
    flt = json.dumps({"room": {"timeline": {"limit": 50}}})
    params["filter"] = flt
    resp = requests.get(
        f"{MATRIX_HS}/_matrix/client/v3/sync",
        headers={"Authorization": f"Bearer {token}"},
        params=params,
        timeout=30
    )
    return resp.json()

def resolve_room_id(token, room_id_or_alias):
    if room_id_or_alias.startswith("!"):
        return room_id_or_alias
    resp = requests.get(
        f"{MATRIX_HS}/_matrix/client/v3/resolve/room/{room_id_or_alias}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=15
    )
    data = resp.json()
    return data.get("room_id", room_id_or_alias)

def analyze_with_qwen(content_batch):
    messages = [
        {
            "role": "system",
            "content": "You are a code bug detector for a web project called Doubao User Plaza. The project uses Cloudflare Pages + D1 database + Matrix chat. Analyze the following chat messages from the project's Matrix feedback room. Look for: 1. Bug reports or error descriptions 2. Code snippets with potential issues 3. Regression reports 4. Deployment failures 5. Configuration problems 6. Feature requests that indicate broken functionality. If you find bugs, respond with ONLY a JSON object (no markdown): {\"bugs_found\": true, \"bugs\": [{\"description\": \"bug description\", \"severity\": \"high|medium|low\", \"file\": \"suggested file path\", \"fix_suggestion\": \"how to fix\"}]}. If no bugs found: {\"bugs_found\": false}. Be concise. Only report real actionable bugs, not general feedback."
        },
        {
            "role": "user",
            "content": f"Analyze these messages for bugs:\n\n{content_batch}"
        }
    ]
    resp = requests.post(
        QWEN_API_URL,
        headers={
            "Authorization": f"Bearer {QWEN_API_KEY}",
            "Content-Type": "application/json"
        },
        json={
            "model": QWEN_MODEL,
            "messages": messages,
            "temperature": 0.3,
            "max_tokens": 2000
        },
        timeout=60
    )
    data = resp.json()
    return data["choices"][0]["message"]["content"]

def trigger_opencode_fix(bug_description, file_path=None):
    prompt = f"[Auto-detected bug from Matrix monitor]\n\n{bug_description}"
    if file_path:
        prompt += f"\n\nSuggested file: {file_path}"
    prompt += "\n\nPlease analyze and fix this bug in the doubao-plaza project."
    log(f"Triggering opencode: {bug_description[:80]}")
    try:
        subprocess.run(
            ["opencode", "--prompt", prompt],
            cwd=PROJECT_DIR,
            timeout=300,
            capture_output=True
        )
        log("opencode completed")
    except FileNotFoundError:
        log("WARN: opencode CLI not found, writing to pending_fixes.jsonl")
        with open(os.path.join(PROJECT_DIR, "scripts", "pending_fixes.jsonl"), "a") as f:
            f.write(json.dumps({"bug": bug_description, "file": file_path, "timestamp": time.time()}) + "\n")
    except Exception as e:
        log(f"ERROR triggering opencode: {e}")

def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {}

def save_state(state):
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)

def main():
    log("Starting Matrix room monitor...")
    log(f"Target: {MATRIX_HS} room {TARGET_ROOM_ID}")
    log(f"Check interval: {CHECK_INTERVAL}s")

    state = load_state()
    token = matrix_login()
    actual_room_id = resolve_room_id(token, TARGET_ROOM_ID)
    log(f"Resolved room ID: {actual_room_id}")

    while True:
        try:
            sync = sync_messages(token, state.get("next_batch"))
            next_batch = sync.get("next_batch", "")

            room_data = sync.get("rooms", {}).get("join", {}).get(actual_room_id, {})
            events = room_data.get("timeline", {}).get("events", [])

            messages = []
            for ev in events:
                if ev.get("type") == "m.room.message":
                    content = ev.get("content", {})
                    sender = content.get("com.doubao.sender_name", content.get("sender", "unknown"))
                    body = content.get("body", "")
                    if body and not body.startswith("img:") and not body.startswith("file:"):
                        messages.append({"sender": sender, "body": body, "ts": ev.get("origin_server_ts", 0)})

            if messages:
                log(f"Found {len(messages)} new text messages")
                batch_text = "\n".join(f"[{m['sender']}]: {m['body']}" for m in messages)
                try:
                    result = analyze_with_qwen(batch_text)
                    log(f"Qwen analysis: {result[:200]}")
                    try:
                        analysis = json.loads(result)
                        if analysis.get("bugs_found"):
                            for bug in analysis.get("bugs", []):
                                log(f"BUG DETECTED: {bug.get('description', 'unknown')}")
                                trigger_opencode_fix(bug.get("description", ""), bug.get("file"))
                    except json.JSONDecodeError:
                        log("Could not parse Qwen response as JSON")
                except Exception as e:
                    log(f"Qwen API error: {e}")
            else:
                log(f"No new text messages (next_batch updated)")

            state["next_batch"] = next_batch
            state["last_check"] = datetime.now().isoformat()
            state["messages_processed"] = state.get("messages_processed", 0) + len(messages)
            save_state(state)

        except requests.exceptions.ConnectionError:
            log("Connection error, retrying login...")
            try:
                token = matrix_login()
            except Exception as e:
                log(f"Re-login failed: {e}")
        except Exception as e:
            log(f"Error: {e}")

        time.sleep(CHECK_INTERVAL)

if __name__ == "__main__":
    main()
