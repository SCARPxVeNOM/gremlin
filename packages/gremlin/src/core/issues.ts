import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { CONNECTORS } from './agent.ts';
import { arenaMarkdown, runArena, type ArenaResult } from './arena.ts';
import { CONFIRM_LABEL, commentOnIssue, originRepo, reproFromComment, runCapture, runGh, type CaptureResult, type DraftedRepro } from './capture.ts';
import type { Project } from './config.ts';
import { runFixer, type FixResult } from './fixer.ts';
import { getFlow, type Flow } from './flow.ts';
import { kaneShareLink } from './kane.ts';
import { ensureDir } from './paths.ts';
import { redactText } from './redact.ts';
import { silentReporter, type Reporter } from './runner.ts';
import { uncommittedChanges } from './snapshot.ts';
import { emit, getBug, getRun, lockPath, reserveOpenFixBranches, saveBug, type BugRecord, type RunRecord } from './store.ts';
import { truncate } from './util.ts';

/**
 * Issue autopilot: a labeled GitHub issue goes in, a pull request Kane has proven comes out.
 * Capture reproduces the report, the Fixer hands it to the user's agent, and the fix is
 * opened as a PR, never pushed to the default branch, so a human review is still the gate.
 */

/** Labels Gremlin puts on an issue to show where it is in the loop. */
export const ISSUE_LABELS = {
  working: { name: 'gremlin:working', color: 'fbca04', description: 'Gremlin is reproducing or fixing this' },
  reproduced: { name: 'gremlin:reproduced', color: 'd73a4a', description: 'Kane CLI reproduced this bug' },
  'cant-reproduce': { name: 'gremlin:cant-reproduce', color: 'c5def5', description: 'Kane followed the report and the app behaved' },
  'needs-detail': { name: 'gremlin:needs-detail', color: 'c5def5', description: 'The report needs more detail to reproduce' },
  'fix-proposed': { name: 'gremlin:fix-proposed', color: '0e8a16', description: 'A fix Kane proved is open as a pull request' },
  'needs-human': { name: 'gremlin:needs-human', color: 'b60205', description: "The agent's fixes didn't pass Kane" },
} as const;
type LabelKey = keyof typeof ISSUE_LABELS;
const ALL_LABELS: string[] = Object.values(ISSUE_LABELS).map((l) => l.name);

export type IssueOutcome = 'pr-opened' | 'reproduced' | 'cant-reproduce' | 'needs-detail' | 'escalated' | 'inconclusive' | 'error' | 'skipped';

export interface IssueLoopOptions {
  reporter?: Reporter;
  /** Open a pull request with a proven fix. Default true; false stops after the fix and leaves it in the working tree. */
  pr?: boolean;
  attempts?: number;
  /** Run again on an issue Gremlin has already finished with. */
  force?: boolean;
  /** Let these agents compete for the fix instead of one agent trying in turn; Kane picks the winner. */
  arena?: string[];
}

export interface IssueLoopResult {
  issue: number;
  outcome: IssueOutcome;
  message: string;
  capture?: CaptureResult;
  fix?: FixResult | ArenaResult;
  bug?: BugRecord;
  prUrl?: string;
}

interface GhIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  labels: { name: string }[];
}

function gh(args: string[], cwd: string, input?: string): { ok: boolean; out: string; err: string } {
  const r = runGh(args, cwd, input);
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() || (r.error?.message ?? '') };
}

function git(cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

function mustGit(cwd: string, args: string[]): string {
  const r = git(cwd, args);
  if (!r.ok) throw new Error(`git ${args[0]} failed: ${r.err || r.out}`);
  return r.out;
}

export function readIssue(project: Project, n: number): GhIssue {
  const r = gh(['issue', 'view', String(n), '--json', 'number,title,body,url,state,labels'], project.root);
  if (!r.ok) throw new Error(`gh couldn't read issue #${n}: ${r.err || 'is gh installed and signed in?'}`);
  return JSON.parse(r.out);
}

function repoInfo(project: Project): { nameWithOwner: string; defaultBranch: string } {
  // `gh repo view` ignores GH_REPO and reads gh's default, which in a fork is upstream: name the repo
  const target = process.env.GH_REPO || originRepo(project.root);
  const r = gh(['repo', 'view', ...(target ? [target] : []), '--json', 'nameWithOwner,defaultBranchRef'], project.root);
  if (!r.ok) throw new Error(`gh couldn't read this repository: ${r.err}`);
  const j = JSON.parse(r.out);
  return { nameWithOwner: j.nameWithOwner, defaultBranch: j.defaultBranchRef?.name ?? 'main' };
}

/** Swap Gremlin's status label on an issue, creating labels the repo doesn't have yet. */
/**
 * The repro Kane and the agent disagreed on, read back from Gremlin's own comment, and who added CONFIRM_LABEL. Only
 * a comment Gremlin could have posted counts (the Actions bot, or someone with write access to the repo): anyone
 * else could post a look-alike to hand Kane their own steps.
 */
export function disputedRepro(project: Project, issue: Pick<GhIssue, 'number' | 'title'>): { draft: DraftedRepro; failedAt?: string; by: string } | undefined {
  const r = gh(['issue', 'view', String(issue.number), '--json', 'comments'], project.root);
  if (!r.ok) return undefined;
  const comments: { author?: { login?: string }; authorAssociation?: string; body?: string }[] = JSON.parse(r.out || '{}').comments ?? [];
  const trusted = (c: (typeof comments)[number]) => /^github-actions(\[bot\])?$/.test(c.author?.login ?? '') || ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(c.authorAssociation ?? '');
  const found = comments
    .filter(trusted)
    .map((c) => reproFromComment(c.body ?? '', issue.title))
    .filter((x) => x !== undefined)
    .at(-1);
  if (!found) return undefined;
  const labeled = gh(
    ['api', '--paginate', `repos/{owner}/{repo}/issues/${issue.number}/events`, '--jq', `[.[] | select(.event == "labeled" and .label.name == "${CONFIRM_LABEL.name}")] | last | .actor.login // empty`],
    project.root,
  );
  return { ...found, by: (labeled.ok && labeled.out.split('\n').filter(Boolean).at(-1)) || 'a maintainer' };
}

function setStatusLabel(project: Project, n: number, key: LabelKey | undefined): void {
  const want = key ? ISSUE_LABELS[key].name : undefined;
  if (key) {
    const l = ISSUE_LABELS[key];
    gh(['label', 'create', l.name, '--color', l.color, '--description', l.description, '--force'], project.root);
  }
  const current = gh(['issue', 'view', String(n), '--json', 'labels', '--jq', '.labels[].name'], project.root).out.split('\n');
  const remove = current.filter((name) => ALL_LABELS.includes(name) && name !== want);
  const args = ['issue', 'edit', String(n)];
  if (remove.length) args.push('--remove-label', remove.join(','));
  if (want && !current.includes(want)) args.push('--add-label', want);
  if (args.length > 3) gh(args, project.root);
}

function comment(project: Project, n: number, body: string): boolean {
  return gh(['issue', 'comment', String(n), '--body-file', '-'], project.root, body).ok;
}

// ---------------------------------------------------------------------------

export async function runIssueLoop(project: Project, n: number, opts: IssueLoopOptions = {}): Promise<IssueLoopResult> {
  const reporter = opts.reporter ?? silentReporter;
  const openPr = opts.pr !== false;
  const issue = readIssue(project, n);
  // a human settling a disagreement between Kane and the agent is the one way back into an issue handed to a human
  const confirmed = issue.labels.some((l) => l.name === CONFIRM_LABEL.name);
  const done = issue.labels.find((l) => l.name === ISSUE_LABELS['fix-proposed'].name || (l.name === ISSUE_LABELS['needs-human'].name && !confirmed));
  if (done && !opts.force) {
    return { issue: n, outcome: 'skipped', message: `#${n} is already labeled ${done.name}. Use --force to run it again.` };
  }
  if (issue.state !== 'OPEN' && !opts.force) return { issue: n, outcome: 'skipped', message: `#${n} is ${issue.state.toLowerCase()}.` };
  if (openPr) {
    const dirty = uncommittedChanges(project.root);
    if (dirty.length) {
      throw new Error(`Commit or stash your changes first (${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? ' …' : ''}): the fix is opened as a pull request from a clean tree.`);
    }
  }

  const disputed = confirmed ? disputedRepro(project, issue) : undefined;
  if (confirmed && !disputed) {
    const message = `#${n} is labeled ${CONFIRM_LABEL.name}, but Gremlin hasn't posted a repro here that Kane and the agent disagree on, so there is nothing to confirm.`;
    comment(project, n, `### 👹 Gremlin: nothing to confirm\n\n${message} Remove the label, and label the issue \`${project.config.sources.github?.label ?? 'gremlin'}\` to start from the report.`);
    return { issue: n, outcome: 'error', message };
  }

  emit(project.paths, 'info', `Issue #${n} picked up: ${issue.title}`, { issue: n, url: issue.url, confirmedBy: disputed?.by });
  setStatusLabel(project, n, 'working');
  const then = openPr ? 'the coding agent will fix it and Kane will have to watch the fix work before a pull request opens' : 'the coding agent will fix it';
  comment(
    project,
    n,
    disputed
      ? `### 👹 Gremlin: ${disputed.by} sided with the agent, so Kane runs the disputed repro again\n\nIf Kane fails it at “${disputed.failedAt ?? 'the same step'}” again, the bug is filed on ${disputed.by}'s word, ${then}.`
      : `### 👹 Gremlin is on it\n\nKane CLI is trying to reproduce this in a real browser. If it can, ${then}.`,
  );

  reserveOpenFixBranches(project.root); // the watcher runs for hours: branches opened since count too
  const capture = await runCapture(
    project,
    { text: `${issue.title}\n\n${issue.body ?? ''}`, source: 'github', ref: `#${n}`, url: issue.url },
    { reporter, draft: disputed?.draft, confirmed: disputed && { by: disputed.by, failedAt: disputed.failedAt } },
  );
  commentOnIssue(project, capture, `#${n}`);
  const base = { issue: n, capture, bug: capture.bug };

  if (capture.outcome !== 'confirmed' || !capture.bug) {
    // every ending gets a label, so the watcher never picks the same issue up again on its own
    const key: LabelKey = capture.outcome === 'cant-reproduce' || capture.outcome === 'needs-detail' ? capture.outcome : 'needs-human';
    setStatusLabel(project, n, key);
    return { ...base, outcome: capture.outcome === 'confirmed' ? 'error' : capture.outcome, message: capture.message };
  }
  setStatusLabel(project, n, 'reproduced');
  if (project.config.loop.mode === 'suggest') {
    return { ...base, outcome: 'reproduced', message: `${capture.message} Suggest mode: run \`gremlin fix ${capture.bug.id}\` to hand it to the agent.` };
  }

  // Labeling the issue is the go-ahead to attempt a fix; reviewing the PR is the approval.
  const fix = opts.arena?.length
    ? await runArena(project, capture.bug.id, opts.arena, { reporter })
    : await runFixer(project, capture.bug.id, { mode: 'autonomous', attempts: opts.attempts, reporter });
  const bug = getBug(project.paths, capture.bug.id) ?? fix.bug;

  if (fix.outcome !== 'fixed') {
    const attempts = bug.attempts.filter((a) => a.result !== 'pending');
    const tried =
      'entries' in fix
        ? [`Kane reproduced the bug (${bug.id}), but none of the ${fix.entries.length} agents' fixes passed Kane, so nothing was opened.`, '', arenaMarkdown(bug, fix.entries).split('\n').slice(4).join('\n')]
        : [
            `Kane reproduced the bug (${bug.id}), but none of the agent's ${attempts.length} attempt${attempts.length === 1 ? '' : 's'} passed Kane, so nothing was opened.`,
            '',
            ...attempts.map((a) => `- **Attempt ${a.n}** (${a.result}): changed ${a.changedFiles.map((f) => `\`${f}\``).join(', ') || 'nothing'}`),
          ];
    comment(
      project,
      n,
      [
        `### 👹 Gremlin: handing this to a human`,
        '',
        ...tried,
        '',
        `The repro flow, Kane's evidence and every fix package are in \`.gremlin/bugs/${bug.id}/\` on the machine that ran Gremlin.`,
      ].join('\n'),
    );
    setStatusLabel(project, n, 'needs-human');
    return { ...base, fix, bug, outcome: fix.outcome === 'escalated' ? 'escalated' : 'error', message: fix.message };
  }
  if (!openPr) return { ...base, fix, bug, outcome: 'reproduced', message: `${fix.message} The fix is in your working tree.` };

  const prUrl = openFixPr(project, issue, bug, capture.run);
  const after = lastPassingRun(project, bug);
  comment(
    project,
    n,
    [
      `### 👹 Gremlin: fix proven by Kane, ready for review → ${prUrl}`,
      '',
      `- 🔴 **Before:** Kane ${capture.run?.kane?.failedStep ? `failed at “${capture.run.kane.failedStep.heading}”` : 'reproduced the bug'}`,
      `- 🟢 **After:** Kane passed the same flow${after ? ` (${after.id})` : ''}${relatedCount(bug) ? ` and ${relatedCount(bug)} related flow${relatedCount(bug) === 1 ? '' : 's'}` : ''}`,
      '',
      'The repro is now a locked regression test, so this bug fails the build if it ever comes back. Merging the PR closes this issue.',
    ].join('\n'),
  );
  setStatusLabel(project, n, 'fix-proposed');
  emit(project.paths, 'bug', `${bug.id}: fix for #${n} opened as ${prUrl}`, { bugId: bug.id, issue: n, prUrl });
  return { ...base, fix, bug, prUrl, outcome: 'pr-opened', message: `${bug.id} fixed and proven by Kane. Pull request: ${prUrl}` };
}

function lastPassingRun(project: Project, bug: BugRecord): RunRecord | undefined {
  const attempt = [...bug.attempts].reverse().find((a) => a.result === 'passed');
  return attempt?.runId ? getRun(project.paths, attempt.runId) : undefined;
}

function relatedCount(bug: BugRecord): number {
  return [...bug.attempts].reverse().find((a) => a.result === 'passed')?.relatedRuns?.length ?? 0;
}

/** Kane's screenshot of the moment that matters: the failing step before, the last step after. */
function keyScreenshot(project: Project, run: RunRecord | undefined, which: 'failure' | 'last'): string | undefined {
  const ev = run?.evidence;
  if (!run || !ev) return undefined;
  const name = which === 'failure' ? (ev.failure?.screenshot ?? ev.screenshots.at(-1)) : ev.screenshots.at(-1);
  const path = name ? join(project.paths.evidence, run.id, name) : undefined;
  return path && existsSync(path) ? path : undefined;
}

/**
 * Commit the fix, the regression flow and Kane's before/after screenshots on a branch,
 * push it, and open a pull request (that closes the issue, when the bug came from one).
 * The working tree goes back to the branch it was on.
 */
export function openFixPr(project: Project, issue: Pick<GhIssue, 'number' | 'title' | 'url'> | undefined, bug: BugRecord, failFirst: RunRecord | undefined): string {
  const root = project.root;
  const { nameWithOwner, defaultBranch } = repoInfo(project);
  // where the project sits inside the repo; computed by git so symlinked paths (macOS /var → /private/var) can't skew it
  const prefix = mustGit(root, ['rev-parse', '--show-prefix']);
  const startBranch = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).out || mustGit(root, ['rev-parse', 'HEAD']);
  const branch = `gremlin/${bug.id.toLowerCase()}${issue ? `-issue-${issue.number}` : ''}`;
  // made on top of a branch that's pushed but not merged (another fix in the same code): stack on it
  const base = startBranch !== defaultBranch && git(root, ['ls-remote', '--exit-code', '--heads', 'origin', startBranch]).ok ? startBranch : defaultBranch;
  const title = issue ? `Fix #${issue.number}: ${bug.title}` : `Fix: ${bug.title}`;

  const before = keyScreenshot(project, failFirst, 'failure');
  const after = keyScreenshot(project, lastPassingRun(project, bug), 'last');
  const shotDir = ensureDir(join(project.paths.bugs, bug.id));
  const shots: { before?: string; after?: string } = {};
  if (before) copyFileSync(before, (shots.before = join(shotDir, `kane-before${extname(before)}`)));
  if (after) copyFileSync(after, (shots.after = join(shotDir, `kane-after${extname(after)}`)));

  mustGit(root, ['checkout', '-B', branch]);
  let committed = false;
  let opened: NonNullable<BugRecord['pr']>;
  try {
    mustGit(root, ['add', '-A', '--', '.']);
    const who = git(root, ['config', 'user.email']).out ? [] : ['-c', 'user.name=Gremlin', '-c', 'user.email=gremlin@users.noreply.github.com'];
    mustGit(root, [...who, 'commit', '-m', title, '-m', `Reproduced and verified by Kane CLI through Gremlin (${bug.id}).${issue ? `\n\nFixes #${issue.number}` : ''}`]);
    committed = true;
    const sha = mustGit(root, ['rev-parse', 'HEAD']);
    mustGit(root, ['push', '--force-with-lease', '-u', 'origin', branch]);

    const imageUrl = (file?: string) => (file ? `https://github.com/${nameWithOwner}/blob/${sha}/${prefix}${relative(root, file).split('\\').join('/')}?raw=true` : undefined);
    const stacked = base !== defaultBranch ? `> Stacked on \`${base}\`, which isn't merged yet, so this diff shows only this fix. Merge that one first.\n\n` : '';
    const body = stacked + prBody(project, issue, bug, failFirst, { before: imageUrl(shots.before), after: imageUrl(shots.after) });
    const pr = gh(['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body-file', '-'], root, body);
    let url = pr.out.split('\n').filter(Boolean).at(-1)!;
    if (!pr.ok) {
      // a second run on the same issue: the branch was force-pushed, so the open PR already shows the new fix
      const existing = gh(['pr', 'view', branch, '--json', 'url', '--jq', '.url'], root);
      if (!existing.ok || !existing.out) throw new Error(`gh couldn't open the pull request: ${pr.err}`);
      url = existing.out;
    }
    opened = { url, branch, sha };
  } finally {
    git(root, ['checkout', startBranch]);
    // Gremlin's records (bugs, flows, the lock) went into that commit, and leaving the branch takes them out of
    // the working tree: the bug list would empty and the next bug would reuse BUG-001. Put them back, uncommitted.
    if (committed) {
      git(root, ['checkout', branch, '--', '.gremlin']);
      git(root, ['reset', '-q', '--', '.gremlin']);
    }
  }
  // The commit can't hold its own sha or a PR that didn't exist yet, so the PR goes on the copy just put back. Here
  // the fix isn't merged, and Guard must not call its failing flow a regression; the copy that merges never has it.
  bug.pr = opened;
  saveBug(project.paths, { ...(getBug(project.paths, bug.id) ?? bug), pr: opened });
  return opened.url;
}

/**
 * `gremlin pr <bug>`: open the pull request for a bug the Fixer or the arena has fixed, with the fix still in
 * the working tree. Only the fix goes in: other uncommitted work stops it.
 */
export function openBugPr(project: Project, bugId: string): string {
  const bug = getBug(project.paths, bugId);
  if (!bug) throw new Error(`No bug ${bugId}`);
  if (bug.status !== 'fixed') throw new Error(`${bug.id} is ${bug.status}, not fixed: run \`gremlin fix ${bug.id}\` or \`gremlin arena ${bug.id}\` first.`);
  const passing = [...bug.attempts].reverse().find((a) => a.result === 'passed');
  const prefix = mustGit(project.root, ['rev-parse', '--show-prefix']);
  const fix = new Set((passing?.changedFiles ?? []).map((f) => prefix + f));
  const changed = uncommittedChanges(project.root);
  if (!changed.some((f) => fix.has(f))) throw new Error(`${bug.id}'s fix (${[...fix].join(', ') || 'no files'}) isn't in the working tree any more, so there is nothing to open a pull request for.`);
  const other = changed.filter((f) => !fix.has(f));
  if (other.length) throw new Error(`Other uncommitted changes would ride along with the fix: ${other.join(', ')}. Commit or stash them first.`);
  const failFirst = bug.runs.map((id) => getRun(project.paths, id)).find((r) => r?.status === 'failed');
  const issue = bug.report?.source === 'github' && bug.report.ref && bug.report.url ? { number: Number(bug.report.ref.replace('#', '')), title: bug.title, url: bug.report.url } : undefined;
  return openFixPr(project, issue, bug, failFirst);
}

/**
 * `gremlin pull`: after a fix's pull request merges, a plain `git pull` refuses, because the records Gremlin put
 * back after opening it are files the merge brings in too. A record that matches what's coming (apart from the pull
 * request it names and when it was saved) is dropped so the pull brings it in; the rest stay. If the pull fails
 * anyway, every dropped record is put back.
 */
export function pullMergedFixes(project: Project): { upstream: string; dropped: string[]; kept: string[] } {
  const { root } = project;
  const upstream = git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!upstream.ok) throw new Error("This branch doesn't track a remote branch, so there is nothing to pull.");
  mustGit(root, ['fetch', '--quiet']);
  const top = mustGit(root, ['rev-parse', '--show-toplevel']);
  // raw -z output, relative to the repo's top: trimming would eat the status column of the first entry
  const entries = (spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.gremlin'], { cwd: root, encoding: 'utf8' }).stdout ?? '').split('\0').filter(Boolean);
  const saved = new Map<string, Buffer>();
  const kept: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const [code, path] = [entries[i].slice(0, 2), entries[i].slice(3)];
    if (/^[RC]/.test(code)) i++; // a rename or copy is followed by its old path
    if (code.includes('D') || /^[RC]/.test(code)) continue;
    const coming = spawnSync('git', ['show', `${upstream.out}:${path}`], { cwd: top });
    const mine = readFileSync(join(top, path));
    if (coming.status !== 0 || !sameRecord(path, mine, coming.stdout)) {
      kept.push(path);
      continue;
    }
    saved.set(path, mine);
    if (code !== '??') git(top, ['reset', '-q', '--', path]);
    if (git(top, ['cat-file', '-e', `HEAD:${path}`]).ok) git(top, ['checkout', '--', path]);
    else rmSync(join(top, path), { force: true });
  }
  const pulled = git(root, ['pull', '--no-edit']);
  if (!pulled.ok) {
    for (const [path, content] of saved) {
      ensureDir(dirname(join(top, path)));
      writeFileSync(join(top, path), content);
    }
    throw new Error(`git pull failed, so Gremlin's records are back as they were: ${pulled.err || pulled.out}`);
  }
  return { upstream: upstream.out, dropped: [...saved.keys()], kept };
}

/** The same record on both sides; a bug only differs in the pull request this checkout noted and when it saved it. */
function sameRecord(path: string, mine: Buffer, coming: Buffer): boolean {
  if (mine.equals(coming)) return true;
  if (!/(^|\/)\.gremlin\/bugs\/[^/]+\.json$/.test(path)) return false;
  try {
    const strip = (b: Buffer) => {
      const bug = JSON.parse(b.toString('utf8'));
      delete bug.pr;
      delete bug.updatedAt;
      return JSON.stringify(bug);
    };
    return strip(mine) === strip(coming);
  } catch {
    return false;
  }
}

export function prBody(
  project: Project,
  issue: Pick<GhIssue, 'number' | 'url'> | undefined,
  bug: BugRecord,
  failFirst: RunRecord | undefined,
  images: { before?: string; after?: string } = {},
): string {
  const passing = [...bug.attempts].reverse().find((a) => a.result === 'passed');
  // the Fixer records an agent by name ("claude-code"), the arena by label ("Claude Code (sonnet)")
  const agent = passing ? (CONNECTORS[passing.agent]?.label ?? passing.agent) : 'the coding agent';
  const afterRun = passing?.runId ? getRun(project.paths, passing.runId) : undefined;
  const flow: Flow | undefined = getFlow(project.paths, bug.flowId);
  const tries = bug.attempts.filter((a) => a.result !== 'pending').length;
  const runLink = (run?: RunRecord) => {
    const link = kaneShareLink(run?.kane);
    return run ? (link ? `[${run.id}](${link})` : `\`${run.id}\``) : 'n/a';
  };
  const k = failFirst?.kane;
  const found = issue
    ? `Gremlin reproduced [#${issue.number}](${issue.url})`
    : bug.origin === 'breaker'
      ? `Gremlin's Breaker found this by attacking the app like a hostile user, Kane confirmed it${bug.verdict?.confidence ? ` (${Math.round(bug.verdict.confidence * 100)}% sure it's a product bug)` : ''},`
      : `Gremlin reproduced ${bug.report?.ref ? `the report ${bug.report.ref}` : 'the report'}`;
  const lines = [
    `### 👹 Fixes ${issue ? `#${issue.number}` : bug.id}: ${bug.title}`,
    '',
    `${found} and handed it to ${agent}. **Kane CLI watched the bug happen, then watched this fix work, in a real browser.** Nothing here rests on the agent's word.`,
    '',
    '| | Kane run | Verdict |',
    '| --- | --- | --- |',
    `| 🔴 Before | ${runLink(failFirst)} | Failed${k?.failedStep ? ` at “${k.failedStep.heading}”` : ''}${k?.reason ? `: ${truncate(k.reason, 200)}` : ''} |`,
    `| 🟢 After | ${runLink(afterRun)} | Passed on attempt ${passing?.n ?? '?'} of ${tries} |`,
  ];
  if (passing?.relatedRuns?.length) lines.push(`| Related flows | ${passing.relatedRuns.map((id) => `\`${id}\``).join(', ')} | All passed: no side effects |`);
  if (bug.confirmedBy) {
    lines.push(
      '',
      `**A human broke the tie.** Kane watched the flow fail but blamed the test (*${truncate(bug.confirmedBy.kane, 200)}*). The agent read the code and disagreed, and ${bug.confirmedBy.by} ruled it a product bug with the \`${CONFIRM_LABEL.name}\` label. Kane still had to watch the same flow pass with the fix.`,
    );
  }
  if (bug.arena?.winner) {
    const rest = bug.arena.entries.filter((e) => e.result !== 'won');
    lines.push('', `**Agent arena:** ${bug.arena.entries.length} agents fixed this at the same time and Kane judged every fix. ${agent}'s was the smallest that passed. ${rest.map((e) => `${e.label}: ${e.result.replace('-', ' ')}${e.changedFiles.length ? ` (+${e.added} −${e.removed})` : ''}`).join(' · ')}.`);
  }
  if (images.before || images.after) {
    lines.push(
      '',
      '<table><tr><th>Before the fix</th><th>After the fix</th></tr><tr>',
      `<td>${images.before ? `<img src="${images.before}" width="420" alt="Kane's screenshot of the failing step">` : ''}</td>`,
      `<td>${images.after ? `<img src="${images.after}" width="420" alt="Kane's screenshot after the fix">` : ''}</td>`,
      '</tr></table>',
    );
  }
  if (flow) {
    lines.push('', `**The test that now guards this bug** (\`${relative(project.root, flow.path)}\`, locked in \`${relative(project.root, lockPath(project.paths, flow.id))}\` so no agent can weaken it):`, '');
    flow.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    lines.push('', ...flow.expect.map((e) => `- ${e}`));
  }
  if (passing) {
    lines.push('', `**What ${agent} changed:** ${passing.changedFiles.map((f) => `\`${f}\``).join(', ')}`);
    if (passing.outsideArea.length) lines.push(`⚠️ Outside the bug's area, worth a closer look: ${passing.outsideArea.map((f) => `\`${f}\``).join(', ')}`);
    if (passing.agentSummary) lines.push('', '<details><summary>The agent’s explanation</summary>', '', redactText(truncate(passing.agentSummary, 1200)), '', '</details>');
  }
  lines.push('', `<sub>${bug.credits} Kane credits · ${bug.origin === 'breaker' ? 'found' : 'reproduced'}, fixed and verified by [Gremlin](https://github.com/SCARPxVeNOM/gremlin) with Kane CLI</sub>`);
  if (issue) lines.push('', `Fixes #${issue.number}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------

/** Open issues carrying the trigger label that Gremlin hasn't picked up yet. */
export function pendingIssues(project: Project, label: string): number[] {
  const r = gh(['issue', 'list', '--state', 'open', '--label', label, '--json', 'number,labels', '--limit', '50'], project.root);
  if (!r.ok) throw new Error(`gh couldn't list issues: ${r.err}`);
  const issues: { number: number; labels: { name: string }[] }[] = JSON.parse(r.out || '[]');
  return issues
    .filter((i) => !i.labels.some((l) => ALL_LABELS.includes(l.name)))
    .map((i) => i.number)
    .sort((a, b) => a - b);
}
