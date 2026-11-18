# A real Gremlin session on Kiln

This is the `.gremlin/` state from one session against [`examples/kiln`](../../examples/kiln), copied as it was. Every
pass and fail in it is a Kane CLI run in a real browser, and every fix was made by Claude Code.

```bash
cd docs/demo-run
gremlin dash          # http://127.0.0.1:4777
```

It's a record, not a working project: the shop's code isn't here, so *Run Guard* or *Hunt for bugs* will fail to start
it. To run the loop yourself, use `examples/kiln`.

What's in it:

- `flows/`: the 3 happy flows, 6 adversarial flows from the Breaker hunt, and 3 regression flows locked by the Fixer.
- `bugs/`: 5 bugs. `bugs/<id>/attempt-N.md` is the exact package the agent was given.
- `runs/` and `evidence/`: all 43 Kane runs, with the screenshots Kane took (downscaled to keep the repo small).
- `reports/`: the Breaker report.
- `events.jsonl`: everything the dashboard's live feed showed, in order.

Local paths were rewritten relative to the project, and the one customer complaint was redacted by Gremlin before
it was saved.
