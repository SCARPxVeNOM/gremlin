# Gremlin — Product Spec

Nov 18, 2026 · @aryan

**One line:** Gremlin is a drop-in QA loop for any product. One agent attacks your app like a hostile user, every real bug report becomes a reproducible test, your own coding agent fixes what breaks, and Kane CLI proves each fix in a real browser or simulator.

**Status:** Concept spec. No timeline, no implementation. This document defines what Gremlin is, how it behaves, and the rules it follows.

## 1. Problem

AI coding agents now write most of the code in many teams, but they still declare work "done" without proof that a real user can complete the flow. Three gaps follow from that:

- **Nobody tests like a bad user.** Agents and developers test the happy path. Real users double-click, hit back mid-checkout, paste emoji into phone fields and lose network halfway through.
- **Bug reports die as text.** A support message or GitHub issue describes a failure in plain words, but turning it into a reproducible test is manual, slow and usually skipped. The same bug returns months later.
- **Testing tools stop at the report.** A failing test tells a human something is wrong. It doesn't hand the evidence back to the agent that can fix it, and it doesn't confirm the fix.

## 2. Vision

Every product should have a tireless adversarial user and a perfect memory of every bug it has ever had, wired straight into whatever agent builds it. Gremlin makes "the app works for real users" something the agent must prove, not assert.

## 3. Goals and non-goals

**Goals**

- Work in any repo, any stack, with any coding agent, on web, iOS and Android.
- Be useful within minutes of setup, with no test framework to learn.
- Keep every test as plain English a non-engineer can read, write and review.
- Close the loop: evidence from a failure flows back to the agent automatically, and the fix is verified before it counts.
- Grow a regression library that only ever gets stronger.

**Non-goals**

- Replacing unit tests, load testing or security penetration testing.
- Being a coding agent. Gremlin orchestrates the user's existing agent; it does not ship its own.
- Testing production with real user data or real money.
- Hosting the user's app.

## 4. Who it's for

| Persona | What they want | How Gremlin helps |
| --- | --- | --- |
| Solo builder / indie hacker | Ship fast without a QA team | Breaker acts as a free, always-on QA tester |
| Product team using AI agents | Trust what the agent ships | Agent can't mark work done until Kane passes |
| PM / support lead | Bugs they report stay fixed | Paste a complaint, get a permanent regression test |
| QA engineer | Less brittle script maintenance | Plain-English flows instead of selectors and scripts |
| Open-source maintainer | Triage issues faster | Issues auto-convert into confirmed repros |
| Hackathon / Web3 dev | Demo flows that never break on stage | Guard replays the demo flows before every push |

## 5. Core concepts

| Concept | Meaning |
| --- | --- |
| **Flow** | A plain-English description of one user journey and what must be true at the end. Stored as a readable markdown file. Kane executes it. |
| **Breaker** | The adversarial agent. Reads the product and invents hostile flows. |
| **Capture** | Turns an outside bug report into a flow that reproduces it. |
| **Fixer** | The user's own coding agent, handed the failure and its evidence. |
| **Guard** | Replays the saved flow library on every change. |
| **Evidence pack** | Everything Kane saw on a run: verdict, failing step, screenshots, recording, console and network errors. |
| **Library** | All saved flows, split into happy-path, adversarial and regression. |
| **Run** | One execution of one or more flows against one target. |
| **Target** | Where the app runs: a local URL, a preview deployment, or a simulator/emulator build. |

## 6. The loop

Gremlin runs four stages. Each can be used alone, but the value comes from them feeding each other.

### 6.1 Breaker — find bugs nobody asked for

1. Reads what the product is: README, routes, page structure, forms and any existing flows.
2. Builds a map of key journeys (sign up, log in, search, checkout, settings).
3. For each journey, invents hostile variants from a fixed attack catalog (below) plus product-specific ideas.
4. Sends each variant to Kane as a plain-English flow.
5. Any failure becomes a **candidate bug** with its evidence pack.
6. Learns which attacks found real bugs and favors them next time.

**Attack catalog (starting set)**

| Category | Examples |
| --- | --- |
| Input abuse | Empty fields, very long text, emoji, RTL scripts, leading spaces, pasted formatting |
| Timing | Double-submit, rapid clicks, slow network, timeout mid-action |
| Navigation | Back button mid-flow, refresh on a form, deep-linking into a later step, opening two tabs |
| State | Expired session, logged out in another tab, stale cart, item deleted elsewhere |
| Environment | Small screens, rotated device, dark mode, other locale and currency, zoomed text |
| Accessibility | Keyboard-only navigation, missing labels, focus traps |
| Permission | Denied camera, location or notification prompts on mobile |

### 6.2 Capture — turn every bug report into a test

1. A report arrives from any source: pasted text, a GitHub issue, an error tracker event, a support ticket or a chat message.
2. Gremlin rewrites it as a plain-English repro flow with a clear expected outcome.
3. **Kane must fail it first.** A repro that passes is not a confirmed bug; Gremlin asks for more detail or marks it "can't reproduce" with evidence.
4. A confirmed failure becomes a candidate bug, linked back to its original report.

The "fail first" rule is what makes Capture trustworthy: every regression test in the library has been proven to catch the bug it guards.

### 6.3 Fixer — let the user's agent fix it

1. Gremlin packages the candidate bug: the flow, the failing step, the evidence pack and the likely area of code.
2. It hands that package to the user's agent through whichever surface the agent supports (see section 9).
3. The agent proposes a change.
4. Kane re-runs the failing flow. If it passes, Kane re-runs the related library flows to catch side effects.
5. Pass: the fix is accepted and the flow is saved. Fail: new evidence goes back to the agent for another attempt, up to a set limit.
6. After the limit, Gremlin stops and hands the bug to a human with the full attempt history.

### 6.4 Guard — never regress

1. Every confirmed and fixed bug's flow is saved to the regression library.
2. On each change (agent edit, commit or pull request, as configured), Guard replays the relevant flows.
3. A failure blocks the change and goes back into the Fixer stage.
4. The library only grows; flows are retired only by an explicit human decision.

## 7. User journeys

### 7.1 First run

1. User runs Gremlin's setup command in their project.
2. Gremlin detects the stack and asks four things: how to start the app (or its URL), which platforms to test, test login details, and which coding agent they use.
3. It writes a config file and an empty flow library, and installs the right connector for their agent.
4. It generates three to five happy-path flows and runs them once, so the user sees Kane working immediately.
5. It offers a first Breaker pass.

### 7.2 Everyday development

- The user works with their agent as normal.
- After the agent finishes a task, Guard runs the relevant flows before the agent can report "done".
- Failures are fixed in the same session, usually without the user stepping in.

### 7.3 A bug comes in

- A PM pastes a customer complaint into Gremlin, or labels a GitHub issue.
- Capture produces a failing repro, Fixer fixes it, Guard saves it.
- The issue is updated with the repro flow, the fix and Kane's passing evidence.

### 7.4 Scheduled hunting

- Breaker runs on a schedule against a staging or preview environment.
- Findings are batched into a report, ranked by severity and confidence, for the team to approve before any fix is attempted.

## 8. The flow format

Flows are human documents first. Each flow is one markdown file with a short header and a body written as numbered steps in plain English.

**Header fields**

| Field | Purpose |
| --- | --- |
| Title | What the flow proves, in one line |
| Type | Happy path, adversarial or regression |
| Platforms | Web, iOS, Android, or a mix |
| Starting point | The page or screen the flow begins on |
| Account | Which test persona to use, by name, never the actual credentials |
| Source | Where it came from: Breaker, a linked bug report, or a human |
| Status | Draft, confirmed, active or retired |
| Tags | Area of the product, for picking related flows |

**Body rules**

- Steps are written as a user would say them: "Add two items to the cart, then press back twice."
- Every flow ends with explicit expectations: "The order total shows both items and no error message is visible."
- No selectors, IDs or code. If a step needs one to be reliable, the product needs a better label, and Gremlin says so.
- One flow tests one thing.

## 9. Integrations

### 9.1 How Gremlin talks to coding agents

| Surface | Who it's for | Behavior |
| --- | --- | --- |
| Command line | Any agent or human | Clear pass/fail outcome and a readable summary any agent can parse |
| MCP server | Claude Code, Cursor, Windsurf, Kiro, custom agents | Exposes tools to run flows, fetch evidence and save flows |
| Agent hooks | Agents that support lifecycle hooks | Blocks "done" until relevant flows pass; feeds failures back as the next prompt |
| Rules files | Agents configured by rules or instructions files | Tells the agent to run Gremlin before finishing any task |
| CI action | GitHub and other CI | Runs Guard on pull requests and comments with results and evidence |

### 9.2 Where bug reports come from

| Source | Trigger |
| --- | --- |
| Paste | User pastes text into the CLI or dashboard |
| GitHub Issues | A chosen label, such as "gremlin" |
| Error tracker | New error groups above a threshold |
| Support inbox / helpdesk | Tickets tagged as bugs |
| Team chat | A message forwarded to Gremlin |

### 9.3 Execution

Kane CLI is the only execution engine: it runs every flow in a real browser, iOS simulator or Android emulator and returns the verdict and evidence. Gremlin never claims a pass that Kane did not observe.

## 10. Configuration

One config file lives in the project root, readable by humans and agents.

| Setting | What it controls |
| --- | --- |
| App start / target URL | How to launch or reach the app |
| Platforms | Web, iOS, Android |
| Test personas | Named accounts, with secrets pulled from environment variables |
| Agent connector | Which coding agent and surface to use |
| Loop mode | Suggest-only, fix with approval, or fully autonomous |
| Fix attempt limit | How many tries before handing to a human |
| Breaker scope | Which areas to attack and which to leave alone |
| Bug sources | Which intake channels are on |
| Budget | Maximum Kane credits per run, per day and per bug |
| Guard trigger | On agent finish, on commit, on pull request |
| Protected paths | Files the Fixer may never change |

## 11. Guardrails

These rules are not optional and cannot be turned off by the agent.

- **The agent may not edit a flow to make it pass.** Flows can only be changed by a human or by Capture before confirmation. Changing what is tested is never a fix.
- **No pass without Kane.** Only Kane's real run counts as proof.
- **Fail first for regressions.** A regression flow must have failed against the bug before it is saved.
- **Bounded attempts.** The Fixer stops after the configured limit and escalates.
- **Scoped changes.** Fixes stay out of protected paths; changes outside the bug's area are flagged for review.
- **Never against production.** Gremlin refuses targets marked as production and refuses flows that would send real money, real messages or real emails.
- **Human approval modes.** Teams choose how much autonomy the loop gets; the default asks before applying a fix.

## 12. Reliability and flakiness

Plain-English flows are only useful if they're stable.

- Every failure is re-run once before being reported; a pass on retry is logged as "flaky", not as a bug.
- Flows that flake repeatedly are quarantined, shown on the dashboard and excluded from blocking Guard until a human reviews them.
- Gremlin tracks a stability score per flow and per product area.
- Breaker findings are ranked by confidence, so a single odd failure doesn't trigger a fix.
- Test data is reset before each run where the target allows it, so flows don't depend on each other.

## 13. Security and privacy

- Credentials live only in environment variables or the user's secret store; flows reference personas by name.
- Evidence packs are scanned and redacted for emails, tokens, card-like numbers and personal data before storage or sharing.
- Bug reports imported from users are stripped of personal details before becoming flows.
- Evidence stays in the user's project or their own storage by default; nothing is shared publicly.
- Text from bug reports and app pages is treated as data, never as instructions to the agent, to block prompt injection through issues or page content.

## 14. Cost control

- Hard credit budgets per run, per day and per bug.
- Guard runs only flows tagged to the area that changed, with a full replay on a schedule.
- Breaker runs are sized by the user and stop when the budget is reached.
- The dashboard shows credits spent per bug found and per bug fixed.

## 15. Dashboard and reporting

A local or hosted view showing:

- Live loop status: what is running, what failed, what the agent is fixing.
- Bugs found vs fixed, split by Breaker and Capture.
- The flow library with status, stability and last result.
- Evidence viewer: steps, screenshots and recordings for each run.
- Weekly summary for the team: new bugs, fixes, regressions caught, flaky flows, credits used.

## 16. Success metrics

| Metric | What good looks like |
| --- | --- |
| Time to first green flow after setup | Minutes, not hours |
| Bugs found by Breaker that humans confirm as real | High share; low false alarms |
| Bug reports converted to confirmed repros | Most reports with enough detail |
| Fixes accepted without human edits | Grows over time |
| Regressions caught by Guard before merge | Every one that the library covers |
| Flaky rate | Low and falling |
| Teams still using it after a month | The real test of value |

## 17. Risks and open questions

**Risks**

- Plain-English flows may be ambiguous; Kane and the Breaker may read a step differently.
- Breaker could generate noise that wears out the team's trust.
- Agents may make shallow fixes that pass the flow but don't fix the root cause.
- Auth flows with one-time codes, captchas and wallets are hard to automate.
- Credit costs could surprise teams on large apps.

**Open questions**

- How should severity be scored for Breaker findings?
- Should Gremlin suggest product changes (better labels, clearer errors) alongside bug fixes?
- How are flows shared across platforms when web and mobile UIs differ?
- What's the right default autonomy level for teams new to the loop?
- How should Web3 flows handle wallets — mock wallets, testnet fixtures, or both?

## 18. Future directions

- **Shared attack packs:** community-contributed attack catalogs for common product types (e-commerce, SaaS onboarding, dApps).
- **Cross-platform parity:** one flow run on web, iOS and Android, with a diff of where they behave differently.
- **Production signal to flows:** anonymized real session patterns suggest new flows to add.
- **Multi-agent arena:** several coding agents compete to fix the same bug; Kane picks the winner.
- **Behavior contracts:** product-wide rules ("never show a price without currency") checked on every flow.
- **Accessibility mode:** a Breaker profile focused only on accessibility failures.
