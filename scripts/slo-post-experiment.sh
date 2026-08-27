#!/usr/bin/env bash
# Generates the real transcripts behind the SLO blog post.
#
# Answerer: claude-haiku-4-5, no runbooks, no retrieval, no cluster access.
# Judge:    claude-opus-5, sees the question and the answer, never the ground truth.
#
# Three passes:
#   1. Two candidate answers (A, B) per question.
#   2. Absolute pass/fail grade on each of the 12 answers. This feeds the SLI.
#   3. Pairwise A-vs-B, run twice with the order swapped, to test position bias.
#
# --safe-mode is required: without it the CLI loads the operator's CLAUDE.md and
# the bot inherits house rules it was never given.
set -euo pipefail

OUT="${1:-blog/content/posts/error-budgets-for-things-that-lie/transcripts.json}"
ANSWERER="claude-haiku-4-5"
JUDGE="claude-opus-5"
# Deliberately not a mktemp: each call costs real money, so a run that dies
# halfway must be resumable. Delete the directory to force a fresh run.
WORK="${WORK:-.slo-experiment-work}"
mkdir -p "$WORK"

BOT_PROMPT="You are an internal SRE assistant bot for a Kubernetes platform team. Answer the on-call engineer's question directly and concretely. Give exact commands where relevant. Be brief: under 150 words. You have no access to runbooks, dashboards, or the cluster."

JUDGE_PROMPT="You grade answers from an internal SRE assistant bot. The bot answers on-call questions about Kubernetes. Grade against one standard: would a senior SRE, paged at 3am, call this answer correct and safe to act on? An answer fails if it states something false, invents a flag or command that does not exist, or sends the engineer down a path that will not find the cause. Partial credit does not exist. Reply with JSON only."

QUESTIONS=(
  "Pod is CrashLoopBackOff with exit code 137. What now?"
  "How do I find which container in the pod got OOMKilled?"
  "Our HPA is not scaling up even though CPU is at 95%. Why?"
  "What kubectl command shows me why a pod is Pending?"
  "A cert-manager Order is stuck. How do I read the ACME challenge state?"
  "Traefik is returning 404 for a route that exists. Where do I look?"
)

# ask <dest-file> <model> <system-prompt> <user-prompt> [json-schema]
# Writes the CLI's JSON result to dest-file. Skips work already on disk, and
# retries a failed call twice before giving up: a single transient API error
# should not throw away every call made before it.
ask() {
  local dest="$1" model="$2" sys="$3" user="$4" schema="${5:-}"
  if [ -s "$dest" ] && python3 -c 'import json,sys;json.load(open(sys.argv[1]))' "$dest" 2>/dev/null; then
    echo "    cached" >&2
    return 0
  fi
  local -a args=(
    -p --safe-mode --model "$model"
    --system-prompt "$sys"
    --exclude-dynamic-system-prompt-sections
    --disallowed-tools Bash Read Write Edit Glob Grep WebFetch WebSearch Task
    --max-turns 1 --output-format json
  )
  if [ -n "$schema" ]; then args+=(--json-schema "$schema"); fi
  local attempt
  for attempt in 1 2 3; do
    if claude "${args[@]}" "$user" > "$dest.tmp" 2>/dev/null &&
       python3 -c 'import json,sys;json.load(open(sys.argv[1]))' "$dest.tmp" 2>/dev/null; then
      mv "$dest.tmp" "$dest"
      return 0
    fi
    echo "    attempt $attempt failed, retrying" >&2
    sleep 5
  done
  rm -f "$dest.tmp"
  echo "    giving up on $dest" >&2
  return 1
}

GRADE_SCHEMA='{"type":"object","properties":{"verdict":{"type":"string","enum":["pass","fail"]},"reason":{"type":"string"}},"required":["verdict","reason"],"additionalProperties":false}'
PICK_SCHEMA='{"type":"object","properties":{"winner":{"type":"string","enum":["first","second"]},"reason":{"type":"string"}},"required":["winner","reason"],"additionalProperties":false}'

echo "pass 1: generating answers ($ANSWERER)" >&2
for i in "${!QUESTIONS[@]}"; do
  for v in a b; do
    echo "  q$i/$v" >&2
    ask "$WORK/ans-$i-$v.json" "$ANSWERER" "$BOT_PROMPT" "${QUESTIONS[$i]}"
  done
done

echo "pass 2: absolute grading ($JUDGE)" >&2
for i in "${!QUESTIONS[@]}"; do
  for v in a b; do
    echo "  q$i/$v" >&2
    answer="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["result"])' "$WORK/ans-$i-$v.json")"
    ask "$WORK/grade-$i-$v.json" "$JUDGE" "$JUDGE_PROMPT" "QUESTION:
${QUESTIONS[$i]}

ANSWER:
$answer" "$GRADE_SCHEMA"
  done
done

echo "pass 3: pairwise, both orders ($JUDGE)" >&2
for i in "${!QUESTIONS[@]}"; do
  A="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["result"])' "$WORK/ans-$i-a.json")"
  B="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["result"])' "$WORK/ans-$i-b.json")"
  for order in ab ba; do
    echo "  q$i/$order" >&2
    if [ "$order" = ab ]; then first="$A"; second="$B"; else first="$B"; second="$A"; fi
    ask "$WORK/pair-$i-$order.json" "$JUDGE" "$JUDGE_PROMPT Pick the better of two answers." "QUESTION:
${QUESTIONS[$i]}

FIRST ANSWER:
$first

SECOND ANSWER:
$second" "$PICK_SCHEMA"
  done
done

echo "collecting into $OUT" >&2
WORK="$WORK" OUT="$OUT" ANSWERER="$ANSWERER" JUDGE="$JUDGE" \
QUESTIONS_JSON="$(printf '%s\n' "${QUESTIONS[@]}" | python3 -c 'import json,sys;print(json.dumps([l.rstrip("\n") for l in sys.stdin]))')" \
python3 "$(dirname "$0")/collect-transcripts.py"
