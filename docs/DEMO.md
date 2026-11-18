# Demo script (about 3 minutes)

Everything below runs against [`examples/kiln`](../examples/kiln) with real Kane CLI runs. Keep `gremlin dash` open in a
browser next to the terminal; every step shows up there live.

```bash
cd examples/kiln
gremlin dash &            # http://127.0.0.1:4777
```

## 1. The problem (15s)

Open the Kiln shop at http://localhost:4000. "This shop was written quickly, partly by an agent. It looks fine. Its happy
paths pass." Show **Flows**: three happy flows, locked, 100% stable.

## 2. Breaker finds what users find (45s)

```bash
gremlin break --max 6
```

- Claude Code reads `server.js` and proposes attacks, each citing the line that made it suspicious.
- Kane runs each one in a real browser. Point at the live loop: steps, then Kane's triage.
- Kane rules some failures *automation* problems. Gremlin doesn't file them, and hands the triage back to the agent to
  rewrite the flow.
- Open **Bugs**: real bugs, each with Kane's screenshots, console and network evidence.

## 3. A complaint becomes a test (40s)

Open **Capture**, click *Use a sample complaint*, then *Reproduce with Kane*.

- Personal details are stripped first (email and phone).
- Claude Code drafts the repro: type `welcome10` at checkout.
- **Fail first:** Kane runs it and watches it fail. Only now is it a bug, and the flow is locked as a regression test.

## 4. The agent fixes it, Kane proves it (50s)

Open the coupon bug, click **Fix with agent** (or `gremlin fix BUG-…`).

- Show *What the agent was given*: Kane's evidence, the likely code, the rules (fix the product, never the test).
- Claude Code edits `server.js`. Kane re-runs the flow and the related checkout flows.
- The stepper turns green: **Proven by Kane**. The flow moves to `regression/`, locked forever.

## 5. The agent can't say "done" until Kane agrees (30s)

```bash
gremlin install claude
```

Ask Claude Code for any change in `server.js`. When it finishes, the Stop hook makes Kane replay the flows that file
touches. A failure blocks "done" and Kane's evidence becomes Claude's next prompt. Try editing a flow from Claude:
the PreToolUse hook denies it.

## 6. Close (10s)

Show **Overview**: bugs found, fixed and proven, credits per bug, and the replay that costs 0 credits.
"Every pass and fail you saw was a Kane run in a real browser."
