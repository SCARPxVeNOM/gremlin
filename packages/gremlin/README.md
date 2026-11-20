# gremlin-qa

Every bug report becomes a failing test, a fix and a regression test. Your own coding agent does the work, and
[Kane CLI](https://www.npmjs.com/package/@testmuai/kane-cli) referees every step in a real browser.

- **Capture:** a support email or GitHub issue counts as a bug only once Kane has watched it fail.
- **Fixer:** your agent (Claude Code, Codex, Cursor, Gemini or any CLI) gets Kane's evidence and fixes the product. A
  fix counts only once Kane has watched the same flow pass.
- **Guard:** Kane replays the flows a change touches on every agent "done" and every pull request. Recorded steps
  replay for 0 credits.
- **Breaker:** attacks your app like a hostile user and files only what Kane confirms.
- **Issue autopilot:** label an issue `gremlin`, get a pull request with Kane's before and after.

```bash
npm install -g @testmuai/kane-cli && kane-cli login
npm install -g gremlin-qa

cd ~/your-app
gremlin init      # detects your stack, writes gremlin.config.yaml, drafts and runs your first flows
gremlin break     # hunt for bugs
gremlin dash      # watch it all at http://127.0.0.1:4777
```

Needs Node 20+ and Chrome. Full documentation, the live runs and the evidence behind every claim:
[github.com/SCARPxVeNOM/gremlin](https://github.com/SCARPxVeNOM/gremlin).

MIT licensed.
