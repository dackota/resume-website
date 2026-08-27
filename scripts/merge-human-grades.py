"""Merges the hand-written human grades into transcripts.json.

The judge is graded against a human reference, so the reference has to come
from a person reading the answers with the ground truth in front of them, not
from another model. scripts/ground-truth.md holds the reasoning; this file
holds the verdicts, keyed "<question id><variant>", e.g. "0a".

Run after slo-post-experiment.sh. Idempotent: it overwrites the `human` key
rather than appending, so re-running after a corrected grade is safe.

    python3 scripts/merge-human-grades.py
"""
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
GRADES = ROOT / "scripts" / "human-grades.json"
TRANSCRIPTS = ROOT / "blog/content/posts/error-budgets-for-things-that-lie/transcripts.json"

grades = json.loads(GRADES.read_text())
data = json.loads(TRANSCRIPTS.read_text())

missing = []
for item in data["items"]:
    for variant, answer in item["answers"].items():
        key = f"{item['id']}{variant}"
        if key not in grades:
            missing.append(key)
            continue
        answer["human"] = grades[key]

if missing:
    sys.exit(f"no human grade for: {', '.join(missing)}")

data["human_reference"] = (
    "The `human` verdict on each answer was written by hand against "
    "scripts/ground-truth.md, without showing the judge's verdict first. The "
    "judge never saw either."
)
TRANSCRIPTS.write_text(json.dumps(data, indent=2) + "\n")

agree = sum(
    1
    for item in data["items"]
    for a in item["answers"].values()
    if a["human"]["verdict"] == a["judge"]["verdict"]
)
total = sum(len(item["answers"]) for item in data["items"])
print(f"merged {total} human grades; judge agrees on {agree}/{total}")
