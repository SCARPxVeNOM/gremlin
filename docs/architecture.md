# How Gremlin is built

Gremlin is one CLI package, [`packages/gremlin`](../packages/gremlin) (published as `gremlin-qa`), plus a dashboard in
[`packages/dashboard`](../packages/dashboard). It has no browser automation and no model of its own. Kane CLI runs
every flow in a real browser and decides whether it passed. Your own coding agent drafts the flows and writes the
fixes. Gremlin runs the loop between the two and keeps the records.

The three diagrams below are drawn in Excalidraw. Each `.svg` in [`diagrams/`](diagrams) was exported by Excalidraw
from the `.excalidraw` file next to it. To change one, open that file at [excalidraw.com](https://excalidraw.com)
(menu, then Open), edit it, and export the SVG again with the background switched on.

- [The pieces](#the-pieces)
- [One bug, end to end](#one-bug-end-to-end)
- [Guard](#guard)

## The pieces

![Diagram of Gremlin's parts. On the left are five inputs: a pasted report or email, a bug hunt with no report, an agent saying "done", a pull request, and a GitHub issue labelled gremlin. Each one enters one module of the Gremlin core: Capture, Breaker, Guard (which takes both "done" and pull requests) and the issue autopilot. Above the core are its five surfaces: the CLI, the dashboard, the MCP server, the GitHub Action and the Claude Code hooks. On the right, the core sends fix packages to coding agents (Claude Code, Codex, Cursor, Gemini or a custom command) and compiled tests to Kane CLI, which drives your app in a real browser and sends back verdicts, triage and evidence. Below is the .gremlin folder: flows, bugs, locks and Kane's recordings are committed, while runs, evidence, the event feed, the credit ledger and session state stay local. Gremlin writes back to GitHub with comments, labels and pull requests.](diagrams/architecture.svg)

**Inputs.** Each input enters at one module:

- A pasted report or email goes to Capture: `gremlin capture`, the dashboard's Capture page, or the `gremlin_capture`
  MCP tool.
- With no report, the Breaker hunts for bugs: `gremlin break`.
- An agent's "done" and a pull request both go to Guard. The first comes through the Claude Code Stop hook (or
  `gremlin_guard` over MCP), the second through the GitHub Action.
- A GitHub issue labelled `gremlin` goes to the issue autopilot, run by the Action or by `gremlin watch`.

**Surfaces.** The CLI ([`cli.ts`](../packages/gremlin/src/cli.ts)), the dashboard server
([`server/index.ts`](../packages/gremlin/src/server/index.ts)), the MCP server
([`mcp/server.ts`](../packages/gremlin/src/mcp/server.ts), 8 tools), the GitHub Action ([`action.yml`](../action.yml))
and the Claude Code hooks ([`hooks/claude.ts`](../packages/gremlin/src/hooks/claude.ts)) are thin. They call the same
functions in `src/core`, so a capture started from the dashboard runs the same code as one started from the CLI. Every
process appends to `.gremlin/events.jsonl`, and the dashboard follows that file live.

**The core** ([`packages/gremlin/src/core`](../packages/gremlin/src/core)):

| Module | Files | What it does |
| --- | --- | --- |
| Capture | [`capture.ts`](../packages/gremlin/src/core/capture.ts), [`revise.ts`](../packages/gremlin/src/core/revise.ts) | Redacts the report, has the agent draft a flow, and files a bug only after Kane watches the flow fail |
| Issue autopilot | [`issues.ts`](../packages/gremlin/src/core/issues.ts) | Labels and comments on the issue, runs Capture and the Fixer, opens the pull request |
| Breaker | [`breaker.ts`](../packages/gremlin/src/core/breaker.ts), [`attacks.ts`](../packages/gremlin/src/core/attacks.ts), [`discover.ts`](../packages/gremlin/src/core/discover.ts) | Maps routes and forms, picks attacks from a catalog and from your agent, files what Kane confirms |
| Fixer | [`fixer.ts`](../packages/gremlin/src/core/fixer.ts) | Hands a fix package to the agent, puts back protected files, restarts the app, has Kane re-run the flow and related flows |
| Agent arena | [`arena.ts`](../packages/gremlin/src/core/arena.ts) | Several agents fix the same bug, each in its own git worktree. Kane judges every fix; the smallest passing one wins |
| Guard | [`guard.ts`](../packages/gremlin/src/core/guard.ts) | Picks the flows a change touches, checks their locks, has Kane replay them, reopens or files bugs |
| Flows + contracts | [`flow.ts`](../packages/gremlin/src/core/flow.ts) | Parses the markdown flows, hashes them, compiles each to a Kane `_test.md`: one `## Step` per line, the expectations, then one step per behaviour contract |
| Kane runner | [`kane.ts`](../packages/gremlin/src/core/kane.ts), [`runner.ts`](../packages/gremlin/src/core/runner.ts) | Runs `kane-cli testmd run … --agent --headless`, reads its event stream, retries a failure once, records credits |
| Fix package | [`brief.ts`](../packages/gremlin/src/core/brief.ts), [`codemap.ts`](../packages/gremlin/src/core/codemap.ts) | Turns Kane's evidence into the text an agent gets, with the likely code and the rules |
| Agent connectors | [`agent.ts`](../packages/gremlin/src/core/agent.ts) | Runs Claude Code, Codex, Cursor, Gemini or a custom command headless |
| Anti-cheat | [`guardrails.ts`](../packages/gremlin/src/core/guardrails.ts), [`snapshot.ts`](../packages/gremlin/src/core/snapshot.ts) | Protected paths, the production, unsafe-flow and budget checks, and a snapshot of the tree around every fix attempt |
| App control | [`target.ts`](../packages/gremlin/src/core/target.ts) | Starts the app, restarts it after a change, resets test data before each run |
| Redaction | [`redact.ts`](../packages/gremlin/src/core/redact.ts), [`evidence.ts`](../packages/gremlin/src/core/evidence.ts) | Strips emails, phone numbers, card numbers and tokens from reports and from Kane's evidence |
| Severity + dedupe | [`severity.ts`](../packages/gremlin/src/core/severity.ts), [`dedupe.ts`](../packages/gremlin/src/core/dedupe.ts) | Scores a bug from Kane's triage, and adds a repeat failure to the open bug it matches instead of filing it twice |

**Kane CLI.** Every verdict comes from one function, `runFlow` in [`runner.ts`](../packages/gremlin/src/core/runner.ts).
It checks the guardrails, resets test data, then runs Kane on the compiled `_test.md` with `.gremlin/kane/` as the
working folder. [`kane.ts`](../packages/gremlin/src/core/kane.ts) reads Kane's NDJSON events: each step's result, Kane's
triage of a failure (a product bug, or a fault in the test or the automation, with a category and a confidence), the
credits used and the evidence pack. A failure is re-run once. A pass on the retry is recorded as flaky, and when both
attempts fail, the more confident triage stands. [`evidence.ts`](../packages/gremlin/src/core/evidence.ts) unzips the
evidence pack, copies the screenshots to `.gremlin/evidence/<run>/` and redacts the text.

Kane replays steps it has already recorded instead of working them out again, and a passing replay costs 0 credits.
`compileFlow` only rewrites a `_test.md` when its content changes, so the recordings of unchanged steps stay valid.
Only one Kane run happens at a time on a machine: `kaneTurn` in `kane.ts` holds a lock file in the temp folder. In CI,
Kane signs in with `LT_USERNAME` and `LT_ACCESS_KEY`.

**Coding agents.** [`agent.ts`](../packages/gremlin/src/core/agent.ts) drives each agent through its own CLI:
`claude -p`, `codex exec`, `cursor-agent`, `gemini`, or the command you set in `agent.command`. A connector has two
calls: `ask`, used to draft flows and attacks (Claude Code gets read-only tools for it), and `fix`, which edits the
working tree. Agents run with `GREMLIN_AGENT_RUN=1`, so Claude Code's Stop hook stays out of the Fixer's way.

**The `.gremlin/` folder** ([`store.ts`](../packages/gremlin/src/core/store.ts),
[`paths.ts`](../packages/gremlin/src/core/paths.ts)). `gremlin init` writes a `.gremlin/.gitignore` that splits it in
two:

- Committed: `flows/{happy,adversarial,regression}/`, `bugs/` (bug records, fix packages, Kane's before and after
  screenshots), `locks/<type>/<flow>.json` (one hash per approved flow, so pull requests that lock different flows never
  touch the same file) and `kane/` (the compiled tests and Kane's recordings).
- Local: `runs/`, `evidence/`, `reports/`, `events.jsonl` (the live feed), `ledger.jsonl` (credits), `stats.json` (pass,
  fail and flake history) and `state.json` (Claude Code hook sessions).

**GitHub.** Gremlin talks to GitHub through the `gh` CLI, pointed at the repo that `origin` names, so a pull request
from a fork's clone lands on the fork. The issue autopilot labels and comments on the issue and opens fix pull requests
on branches named `gremlin/bug-NNN-issue-N`. Gremlin never pushes to the default branch.

## One bug, end to end

![Flowchart of the closed loop. A bug report is redacted, then the agent drafts a plain-English flow, and Kane runs it: it must fail first. If Kane fails it and blames the product, the bug is filed and the repro is locked. If Kane blames the test, the agent rewrites the flow once and Kane runs it again; if Kane still blames the test and the agent cites code, the flow is marked disputed, nothing is filed, and a human can add the gremlin:confirmed label so Kane re-runs that exact repro and files it on the human's word if it fails at the same step. A pass, a pass on retry, or a second test-blamed failure is not filed. Once filed, a fix package goes to the agent, the agent fixes the app, Gremlin restarts the app, and Kane re-runs the flow and up to 4 related flows. If all pass, the flow moves to regression and is locked. If not, Kane's new evidence goes into the next fix package, and after loop.attempts tries a human takes over. Red dashed notes mark the guardrails: retries and flaky runs, protected paths, and the lock hash.](diagrams/closed-loop.svg)

1. **Report and redaction.** The text comes from a paste, a file or `gh issue view`. `runCapture` in
   [`capture.ts`](../packages/gremlin/src/core/capture.ts) passes it through `redact()` before anything else sees it.
2. **Draft.** The agent gets the report as untrusted data, the product map from
   [`discover.ts`](../packages/gremlin/src/core/discover.ts) and the persona names, and answers with JSON: steps and
   the expectations that hold once the bug is fixed. A draft that asks for real money or real messages is rejected. A
   report with too little detail gets questions back instead of a flow.
3. **Fail first.** Kane runs the draft. What happens next depends on what Kane saw:
   - Failed, and Kane blames the product: the bug is filed (or added to the open bug it matches), the flow records the
     run that failed it as `fail_first`, and the flow is locked.
   - Failed, and Kane blames the test: `reviseFlow` in [`revise.ts`](../packages/gremlin/src/core/revise.ts) gives the
     agent Kane's triage and one chance to rewrite the flow, and Kane runs it again.
   - Passed: no bug is filed. Gremlin records it as *can't reproduce*, with Kane's evidence and a question for the
     reporter. A pass on the automatic retry is held as a low-confidence candidate instead.
4. **When the agent disagrees.** While rewriting, the agent may argue, citing `file:line`, that Kane misjudged a real
   product bug. If Kane still blames the test, nothing is filed: Kane's verdict stands, and the dashboard marks the
   flow *Disputed*. On a GitHub issue, Gremlin comments both cases (`commentOnIssue`) and labels the issue
   `gremlin:needs-human`. A maintainer who sides with the agent adds `gremlin:confirmed`. `disputedRepro` in
   [`issues.ts`](../packages/gremlin/src/core/issues.ts) reads the repro back from Gremlin's own comment (never from
   someone without write access), and Kane runs that exact repro again, with no rewrite. If it fails at the same step,
   the bug is filed on that person's word, and the fix still has to pass Kane.
5. **Fix package.** `fixPackage` in [`brief.ts`](../packages/gremlin/src/core/brief.ts) writes
   `.gremlin/bugs/BUG-NNN/attempt-N.md`: the report, the flow, the failing step, Kane's triage (as a lead, not an
   instruction), console and network errors, the screenshot path, earlier attempts, the likely code and the rules.
6. **Fix.** `runFixer` in [`fixer.ts`](../packages/gremlin/src/core/fixer.ts) snapshots the tree, runs the agent
   headless, then compares. Changes to protected paths are put back and recorded. Changes outside the bug's
   `guard.areas` are flagged for review.
7. **Verify.** `restartApp` in [`target.ts`](../packages/gremlin/src/core/target.ts) restarts an app Gremlin started,
   so Kane tests the new code. If it won't start, its stderr becomes that attempt's evidence. Kane re-runs the flow,
   then up to four related flows: other repros of the same bug first, then active flows with the same tags.
8. **Locked, or round again.** If everything passes, `acceptFix` moves the flow to `regression/`, marks it active and
   locks it, and Guard replays it from then on. The issue autopilot then opens a pull request with the fix, the locked
   flow and Kane's before and after. If anything fails, Kane's new evidence goes into the next fix package. After
   `loop.attempts` tries (3 by default) the bug is escalated to a human, with `escalation.md` listing every attempt.

The Breaker uses the same machinery with a different start: its attacks are flows that Kane runs, Kane's triage decides
which failures are bugs, and a bug it files goes through the same Fixer.

**The anti-cheat guardrails on the diagram:**

- **Retry and flaky runs** ([`runner.ts`](../packages/gremlin/src/core/runner.ts)). Every failure is re-run once. A pass
  on the retry is flaky: Capture holds it as a candidate instead of a bug, Guard doesn't block on it, and the Fixer
  doesn't count it as a pass.
  Three flakes in a flow's last ten runs quarantine it.
- **Protected paths** ([`guardrails.ts`](../packages/gremlin/src/core/guardrails.ts)). `.gremlin/flows/**`,
  `.gremlin/locks/**`, `gremlin.config.yaml` and your `protected_paths` are off limits. Claude Code's `PreToolUse` hook
  denies the edit up front, and the Fixer puts back any change after every attempt, whichever agent made it.
- **The lock hash** ([`store.ts`](../packages/gremlin/src/core/store.ts), [`flow.ts`](../packages/gremlin/src/core/flow.ts)).
  `semanticHash` covers a flow's title, start page, account, steps and expectations. Capture locks the repro when it
  files the bug, and the Fixer locks the regression flow when the fix passes. Guard blocks any locked flow whose hash
  has changed, until a human runs `gremlin flows approve`.
- **Before every Kane run**, `runFlow` refuses production targets, flows that would move real money or send real
  messages, and runs over the daily or per-bug credit budget.

## Guard

![Flowchart of Guard. In a Claude Code session, the SessionStart hook saves a baseline, Claude edits the app (a PreToolUse hook denies edits to .gremlin/flows, .gremlin/locks and gremlin.config.yaml), and when Claude says done, the Stop hook runs Guard. On a pull request, the gremlin-guard.yml workflow runs the GitHub Action, which runs gremlin guard --ci against the base branch. Both enter the same Guard: it lists the changed files, uses guard.areas to map them to tags and active flows, blocks if a locked flow was edited without a human, and has Kane replay each flow in a real browser, for 0 credits when the steps are recorded. If all pass, Claude may finish. If a flow fails, the Stop hook returns decision block with Kane's evidence as Claude's next prompt, and Claude fixes the app and says done again; after loop.attempts blocks, done goes through and a human is flagged. On a pull request, a verdict table is posted on the PR, the evidence packs are uploaded, and a failure fails the check.](diagrams/guard.svg)

**In a Claude Code session** ([`hooks/claude.ts`](../packages/gremlin/src/hooks/claude.ts), installed into
`.claude/settings.json` by `gremlin install claude`):

1. `SessionStart` saves a baseline (`git stash create`, or `HEAD`) and the untracked files, and adds Gremlin's rules
   to Claude's context.
2. `PreToolUse` denies `Edit`, `Write`, `MultiEdit` and `NotebookEdit` on protected paths. It also denies shell commands
   that would write to flows, locks or the config, and `gremlin flows approve`, `retire` or `edit`, which are a human's
   call.
3. `Stop` diffs the session against its baseline. It does nothing when no code changed, when nothing changed since the
   last pass, when `guard.trigger` leaves out `agent-finish`, or when the agent is Gremlin's own Fixer (that loop
   verifies itself). If Kane isn't installed or signed
   in, it says so and lets Claude finish.
4. Otherwise it runs Guard on the changed files. If a flow fails, it returns
   `{"decision": "block", "reason": …}`, and the reason, built by `guardBrief` in
   [`guard.ts`](../packages/gremlin/src/core/guard.ts), is Kane's evidence. Claude keeps working with it as its next
   prompt. After `loop.attempts` blocks in one session, the hook stops blocking, lets Claude finish and flags the bugs
   for a human.

**Inside Guard** (`runGuard` in [`guard.ts`](../packages/gremlin/src/core/guard.ts)):

1. `selectFlows` drops changes under `.gremlin/`, matches the rest against the globs in `guard.areas`, and picks the
   active flows tagged with an area that was hit. If the change touches no mapped area, `guard.fallback` decides:
   replay everything (the default) or nothing.
2. `tamperedFlows` compares every flow in the library with its lock. A locked flow edited without a human is a
   blocking result even if the change didn't touch its area: changing what is tested is never a fix.
3. Kane replays the selected flows, one at a time when `app.reset` is set (they share the test data), otherwise
   `guard.concurrency` at a time.
4. A failure reopens the bug its flow guards and marks it a regression, or files a new bug. A passing regression flow
   marks its reopened bug fixed again. A flow that fails only because its bug's fix is on a pull request this checkout
   doesn't have yet is reported as waiting, not as a regression, and doesn't block. Flaky results don't block either.

**On a pull request.** `gremlin install ci` writes `.github/workflows/gremlin-guard.yml`. It runs this repo's
[`action.yml`](../action.yml) with `base: origin/<base branch>`. The Action builds Gremlin, installs Kane CLI and runs
`gremlin guard --ci --base …`, which diffs `base...HEAD` and runs the same Guard. `--ci` writes a verdict table to
`.gremlin/guard-comment.md` and the job summary, and a blocked run exits 1, so the check fails. The workflow then posts
the table on the pull request with `gh pr comment` (editing its earlier comment when there is one) and uploads Kane's
evidence packs as an artifact.

Other agents get the same verdict over MCP: `gremlin_guard` runs Guard and returns the same brief as text, with one
line per flow.
