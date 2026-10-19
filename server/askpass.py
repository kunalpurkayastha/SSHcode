#!/usr/bin/python3
"""SSH_ASKPASS helper (same scheme as sshweb). ssh runs this once per prompt,
jump hosts included.

Answers come from a JSON file {prompt_text: answer} written by the server.
Each prompt is answered at most once per connection attempt, so a wrong
password fails fast; every prompt is logged so the UI can ask for what's
missing."""
import json
import os
import sys

prompt = (sys.argv[1] if len(sys.argv) > 1 else "").replace("\x00", "").strip()
log = os.environ.get("SSHCODE_PROMPT_FILE", os.devnull)


def record(status):
    with open(log, "a", encoding="utf-8") as f:
        f.write(json.dumps({"prompt": prompt, "status": status}) + "\n")


def history():
    try:
        with open(log, encoding="utf-8") as f:
            return [json.loads(l) for l in f if l.strip()]
    except (OSError, ValueError):
        return []


if "(yes/no" in prompt or "fingerprint" in prompt.lower():
    if os.environ.get("SSHCODE_ACCEPT_HOSTKEY") == "1":
        record("answered")
        print("yes")
        sys.exit(0)
    record("refused")
    sys.exit(1)

answers = {}
try:
    with open(os.environ.get("SSHCODE_SECRETS_FILE", ""), encoding="utf-8") as f:
        answers = json.load(f)
except (OSError, ValueError):
    pass

used = any(h["prompt"] == prompt and h["status"] == "answered" for h in history())
if prompt in answers and not used:
    record("answered")
    print(answers[prompt])
    sys.exit(0)
record("retry" if used else "refused")
sys.exit(1)
