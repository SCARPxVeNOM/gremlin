# Demo script (about 3 minutes)

Everything below runs against [`examples/kiln`](../examples/kiln) with real Kane CLI runs. Keep `gremlin dash` open in a
browser next to the terminal; every step shows up there live. The story is one bug, from a customer's email to a fix
Kane proved, so lead with it.

```bash
cd examples/kiln
gremlin dash &            # http://127.0.0.1:4777
```

## 1. The complaint (15s)

Show the email: *"I typed welcome10 into the coupon box at checkout but it just says 'That coupon code is not valid'."*
"Normally this becomes a ticket, someone reproduces it by hand, and nothing stops it from coming back. Watch it become a
test instead."

## 2. The complaint becomes a failing test (40s)

Open **Capture**, click *Use a sample complaint*, then *Reproduce with Kane*.

- Personal details are stripped first (email and phone).
- Claude Code drafts the repro: type `welcome10` at checkout.
- **Red:** Kane runs it in a real browser and it fails, twice (the automatic retry rules out a flake). Only now is it a bug.
  Show Kane's screenshot: *"That coupon code is not valid."*, discount $0.00.

## 3. The agent fixes it, Kane proves it (50s)

Open the coupon bug, click **Fix with agent** (or `gremlin fix BUG-…`).

- Show *What the agent was given*: Kane's evidence, the likely code, the rules (fix the product, never the test).
- Claude Code edits `server.js`. Gremlin restarts the shop so Kane sees the new code, then Kane re-runs the flow and the
  related checkout flows.
- **Green:** the stepper turns to *Proven by Kane*. Show the same screenshot now: *"10% welcome discount applied."*,
  −$2.80. The flow moves to `regression/`, locked forever.

## 4. It stays fixed (30s)

```bash
gremlin install claude
```

Undo the fix by hand (as a bad merge would), then ask Claude Code for an unrelated change in `server.js`. When it
finishes, the Stop hook makes Kane replay the flows that file touches. The coupon flow fails, "done" is refused, and
Kane's evidence becomes Claude's next prompt. Try editing the flow from Claude: the PreToolUse hook denies it.

## 5. No report needed (30s)

```bash
gremlin break --max 6
```

- The same loop, started by a hostile user instead of a customer. Claude Code reads `server.js` and proposes attacks,
  each citing the line that made it suspicious; Kane runs each one.
- Kane rules some failures *automation* problems. Gremlin doesn't file them, and hands the triage back to the agent to
  rewrite the flow. If the agent still thinks the product is wrong, it says so with a file:line, and the flow is
  marked *Disputed* for a human.
- Two attacks that trip the same defect become one bug with two reproductions, not two bugs.

## 6. Close (15s)

Show **Overview**: bugs found, fixed and proven, credits per bug, and the replay that costs 0 credits.
"Every pass and fail you saw was a Kane run in a real browser. Every bug report becomes a test, a fix, and a regression
test." Then one honest limit: Kane can be wrong, so when the agent disagrees, a human decides.
