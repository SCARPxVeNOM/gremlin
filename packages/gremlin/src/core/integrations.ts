import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CONFIRM_LABEL } from './capture.ts';
import { ensureDir } from './paths.ts';

/** How hooks and MCP configs should invoke Gremlin: the global binary if present, else this exact CLI. */
export function gremlinCommand(): string {
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['gremlin'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return 'gremlin';
  return `node ${JSON.stringify(process.argv[1])}`;
}

function readJsonFile(path: string): any {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path} is not valid JSON; fix it and run again.`);
  }
}

function writeJsonFile(path: string, data: unknown) {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

export interface Installed {
  file: string;
  what: string;
}

// ---------------------------------------------------------------------------
// Claude Code: hooks that close the loop, plus MCP

export function installClaudeHooks(root: string, cmd = gremlinCommand()): Installed[] {
  const path = join(root, '.claude', 'settings.json');
  const settings = readJsonFile(path);
  settings.hooks ??= {};
  const want: Record<string, { matcher?: string; command: string; timeout?: number }> = {
    SessionStart: { command: `${cmd} hook claude session-start` },
    PreToolUse: { matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash', command: `${cmd} hook claude pre-tool-use` },
    Stop: { command: `${cmd} hook claude stop`, timeout: 1800 },
  };
  for (const [event, spec] of Object.entries(want)) {
    const list: any[] = (settings.hooks[event] ??= []);
    // drop any older Gremlin entry, keep everyone else's hooks
    const others = list.filter((g) => !(g.hooks ?? []).some((h: any) => String(h.command ?? '').includes('hook claude')));
    const entry: any = { hooks: [{ type: 'command', command: spec.command, ...(spec.timeout ? { timeout: spec.timeout } : {}) }] };
    if (spec.matcher) entry.matcher = spec.matcher;
    settings.hooks[event] = [...others, entry];
  }
  writeJsonFile(path, settings);
  return [{ file: '.claude/settings.json', what: 'hooks: Stop runs Guard before Claude can finish; PreToolUse blocks edits to flows' }];
}

export function installMcp(root: string, file: '.mcp.json' | '.cursor/mcp.json', cmd = gremlinCommand()): Installed {
  const path = join(root, file);
  const cfg = readJsonFile(path);
  cfg.mcpServers ??= {};
  const [command, ...args] = cmd.startsWith('node ') ? ['node', JSON.parse(cmd.slice(5))] : [cmd];
  cfg.mcpServers.gremlin = { command, args: [...args, 'mcp'] };
  writeJsonFile(path, cfg);
  return { file, what: 'MCP server: run flows, read evidence, capture bugs, verify fixes' };
}

// ---------------------------------------------------------------------------
// Rules files: tell any agent to prove its work with Gremlin before finishing

export const RULES = `## Gremlin: prove it works before you say it's done

This project is guarded by Gremlin. User flows live in \`.gremlin/flows/\` as plain English, and Kane CLI runs them in a real browser.

- Before you report a task as done, run \`gremlin guard\` (or the \`gremlin_guard\` MCP tool). If it fails, read the evidence it prints, fix the application, and run it again.
- Only Kane's verdict counts as proof. Never claim a flow passes without a Kane run.
- Never edit, delete or add files under \`.gremlin/\`, and never edit \`gremlin.config.yaml\`. Changing what is tested is never a fix; Gremlin reverts it.
- To turn a bug report into a test: \`gremlin capture "<report>"\`. To see open bugs: \`gremlin bugs\`.
`;

const START = '<!-- gremlin:start -->';
const END = '<!-- gremlin:end -->';

export function installRules(root: string, file: string): Installed {
  const path = join(root, file);
  ensureDir(dirname(path));
  const block = `${START}\n${RULES}${END}`;
  let text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (file.endsWith('.mdc')) {
    text = `---\ndescription: Gremlin QA loop rules\nalwaysApply: true\n---\n\n${block}\n`;
  } else if (text.includes(START)) {
    text = text.replace(new RegExp(`${START}[\\s\\S]*?${END}`), block);
  } else {
    text = (text.trim() ? text.trimEnd() + '\n\n' : '') + block + '\n';
  }
  writeFileSync(path, text);
  return { file, what: 'rules: run Gremlin before finishing; never edit flows' };
}

// ---------------------------------------------------------------------------
// CI: Guard on every pull request

export function ciWorkflow(opts: { start?: string; url: string; installCmd: string }): string {
  return `name: Gremlin Guard

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  guard:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - uses: browser-actions/setup-chrome@v1

      - name: Install the app
        run: ${opts.installCmd}

      - name: Replay the flows this change touches
        uses: SCARPxVeNOM/gremlin@main
        with:
          base: origin/\${{ github.base_ref }}
          lt-username: \${{ secrets.LT_USERNAME }}
          lt-access-key: \${{ secrets.LT_ACCESS_KEY }}

      - name: Comment the verdict on the PR
        if: always() && hashFiles('.gremlin/guard-comment.md') != ''
        env:
          GH_TOKEN: \${{ github.token }}
        run: gh pr comment \${{ github.event.pull_request.number }} --body-file .gremlin/guard-comment.md --edit-last || gh pr comment \${{ github.event.pull_request.number }} --body-file .gremlin/guard-comment.md

      - name: Keep Kane's evidence packs
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: gremlin-evidence
          path: |
            .gremlin/evidence/
            .gremlin/kane/.testmuai/evidence/
          if-no-files-found: ignore
`;
}

function appInstallCommand(root: string): string {
  const lock = existsSync(join(root, 'package-lock.json'));
  const pnpm = existsSync(join(root, 'pnpm-lock.yaml'));
  // without a committed lockfile, npm install would write one, and the issue autopilot refuses to open a PR from a dirty tree
  return pnpm ? 'corepack enable && pnpm install --frozen-lockfile' : lock ? 'npm ci' : existsSync(join(root, 'package.json')) ? 'npm install --no-package-lock' : 'true';
}

export function installCi(root: string, opts: { start?: string; url: string }): Installed {
  const path = join(root, '.github', 'workflows', 'gremlin-guard.yml');
  ensureDir(dirname(path));
  writeFileSync(path, ciWorkflow({ ...opts, installCmd: appInstallCommand(root) }));
  return { file: '.github/workflows/gremlin-guard.yml', what: 'CI: Guard on every pull request, verdict commented on the PR' };
}

// ---------------------------------------------------------------------------
// CI: the issue autopilot, from a labeled issue to a pull request Kane has proven

export function issueWorkflow(opts: { label: string; installCmd: string; agent: string }): string {
  const agentNote =
    opts.agent === 'claude-code' ? '' : `\n      # Gremlin is configured for ${opts.agent}; install its CLI and give it credentials here. The action installs Claude Code only.\n`;
  return `name: Gremlin Issues

# Label an issue "${opts.label}": Kane CLI reproduces it in a real browser, your coding agent
# fixes it, Kane proves the fix, and a pull request opens with Kane's before and after.

on:
  issues:
    types: [labeled]

permissions:
  contents: write
  issues: write
  pull-requests: write

concurrency:
  group: gremlin-issues
  cancel-in-progress: false

jobs:
  autopilot:
    # ${CONFIRM_LABEL.name}: a human settles a disagreement between Kane and the agent
    if: github.event.label.name == '${opts.label}' || github.event.label.name == '${CONFIRM_LABEL.name}'
    runs-on: ubuntu-latest
    timeout-minutes: 90
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: \${{ secrets.GREMLIN_GITHUB_TOKEN || github.token }}

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - uses: browser-actions/setup-chrome@v1

      - name: Install the app
        run: ${opts.installCmd}
${agentNote}
      - name: Reproduce, fix and prove issue #\${{ github.event.issue.number }}
        uses: SCARPxVeNOM/gremlin@main
        with:
          issue: \${{ github.event.issue.number }}
          lt-username: \${{ secrets.LT_USERNAME }}
          lt-access-key: \${{ secrets.LT_ACCESS_KEY }}
          anthropic-api-key: \${{ secrets.ANTHROPIC_API_KEY }}
          claude-code-oauth-token: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          github-token: \${{ secrets.GREMLIN_GITHUB_TOKEN || github.token }}

      - name: Keep Kane's evidence packs
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: gremlin-issue-\${{ github.event.issue.number }}
          path: |
            .gremlin/evidence/
            .gremlin/bugs/
          if-no-files-found: ignore
`;
}

export function installIssueCi(root: string, opts: { label: string; agent: string }): Installed {
  const path = join(root, '.github', 'workflows', 'gremlin-issues.yml');
  ensureDir(dirname(path));
  writeFileSync(path, issueWorkflow({ ...opts, installCmd: appInstallCommand(root) }));
  return { file: '.github/workflows/gremlin-issues.yml', what: `CI: label an issue "${opts.label}" and Gremlin opens a pull request Kane has proven` };
}
