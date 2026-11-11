"""Print one agent run of `amness run --json` as steps: tokens per model request, each tool call, and every guard action.

    python3 steps.py <trial>/agent/amness.jsonl            all steps
    python3 steps.py <amness.jsonl> --tail 12               the last 12 lines

Works with the plain Python 3 of any server (no packages, no f-string tricks).
"""
import json, sys

GUARD = ("nudge", "rejected", "loop", "repair", "denied", "budget", "takeover", "ladder", "rollover", "aborted", "policy")


def lines(path):
    for raw in open(path, errors="replace"):
        try:
            e = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(e, dict):
            continue
        k = e.get("kind")
        if k == "config":
            yield "config: version %s, model %s, guards off %s, maxTime %s, thinkingBudget %s, keepThinking %s" % (
                e.get("version"), e.get("model"), e.get("guardsOff"), e.get("maxTime"), e.get("thinkingBudget"), e.get("keepThinking"))
        elif k == "turn":
            yield "step %d: sent %s tokens (%s cached), wrote %s (thinking %s)" % (
                e.get("step", 0) + 1, e.get("prompt"), e.get("cached"), e.get("completion"), e.get("reasoning"))
        elif k == "toolstart":
            a = e.get("args")
            yield "   tool %s %s" % (e.get("name"), (a if isinstance(a, str) else json.dumps(a))[:120])
        elif k == "edit":
            yield "   edit %s (+%s -%s)" % (e.get("path"), e.get("added"), e.get("removed"))
        elif k in GUARD:
            detail = e.get("detail") or e.get("reason") or e.get("action") or ""
            yield "   GUARD %s: %s" % (k, str(detail)[:160])
        elif k == "finish":
            yield "   finish: %s" % str(e.get("summary", ""))[:160]
        elif k == "result":
            yield "result: finished %s, stopped %s, steps %s, tokens %s: %s" % (
                e.get("finished"), e.get("stopped"), e.get("steps"), e.get("tokens"), str(e.get("text", ""))[:200])


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(2)
    out = list(lines(sys.argv[1]))
    if "--tail" in sys.argv:
        out = out[-int(sys.argv[sys.argv.index("--tail") + 1]):]
    print("\n".join(out))
