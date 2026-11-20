import { spawnSync } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';
import { tryLoadProject, type Project } from '../core/config.ts';
import { guardBrief, runGuard } from '../core/guard.ts';
import picomatch from 'picomatch';
import { ALWAYS_PROTECTED, protectedMatcher } from '../core/guardrails.ts';
import { RULES } from '../core/integrations.ts';
import { kaneStatus } from '../core/kane.ts';
import { isGitRepo } from '../core/snapshot.ts';
import { emit, readState, writeState, type HookSession } from '../core/store.ts';
import { nowIso, sha256 } from '../core/util.ts';

/**
 * Claude Code lifecycle hooks. This is the tightest version of the loop:
 * Claude cannot finish a task until Kane has replayed the flows its change touches,
 * and when Kane fails a flow, the evidence becomes Claude's next prompt.
 */

interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  stop_hook_active?: boolean;
  tool_name?: string;
  tool_input?: Record<string, any>;
}

async function readStdin(): Promise<HookInput> {
  if (process.stdin.isTTY) return {};
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}

const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n');

function git(root: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

function baseline(root: string): string | undefined {
  if (!isGitRepo(root)) return undefined;
  return git(root, ['stash', 'create']) || git(root, ['rev-parse', 'HEAD']) || undefined;
}

function untrackedFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const f of git(root, ['ls-files', '--others', '--exclude-standard']).split('\n')) if (f) files[f] = git(root, ['hash-object', f]);
  return files;
}

/** Files that differ from the session's baseline, and a fingerprint of their current content. */
function sessionChanges(root: string, base?: string, untrackedAtStart?: Record<string, string>): { files: string[]; fingerprint: string } {
  if (!isGitRepo(root)) return { files: [], fingerprint: '' };
  const files = new Set<string>();
  const ref = base ?? 'HEAD';
  for (const f of git(root, ['diff', '--name-only', '--relative', ref]).split('\n')) if (f) files.add(f);
  // the baseline stash only covers tracked files; an untracked file counts if the session created or changed it
  for (const [f, hash] of Object.entries(untrackedFiles(root))) if (untrackedAtStart?.[f] !== hash) files.add(f);
  const list = [...files].filter((f) => !f.startsWith('.gremlin/') && !f.startsWith('.claude/')).sort();
  const hashes = list.map((f) => `${f}:${git(root, ['hash-object', f])}`).join('\n');
  return { files: list, fingerprint: sha256(hashes) };
}

function session(project: Project, id: string): { state: ReturnType<typeof readState>; s: HookSession } {
  const state = readState(project.paths);
  const s = (state.sessions[id] ??= { attempts: 0, startedAt: nowIso() });
  return { state, s };
}

export async function sessionStart(): Promise<void> {
  const input = await readStdin();
  const project = tryLoadProject(input.cwd ?? process.cwd());
  if (!project) return;
  const { state, s } = session(project, input.session_id ?? 'default');
  if (!s.baseline) {
    s.baseline = baseline(project.root);
    if (isGitRepo(project.root)) s.untracked = untrackedFiles(project.root);
  }
  writeState(project.paths, state);
  out({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `${RULES}\nWhen you finish, Gremlin's Stop hook replays the relevant flows with Kane CLI. If any fail, you will get the evidence and must fix the app before you can finish.`,
    },
  });
}

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const DESTRUCTIVE = /(\brm\b|\bmv\b|\bcp\b|sed\s+-i|perl\s+-[a-z]*i|>\s*\S|\btee\b|\btruncate\b|\bunlink\b|writeFile|open\([^)]*['"]w)/;
const GUARDED_IN_SHELL = /\.gremlin\/(flows|locks?\b)|gremlin\.config\.yaml/; // locks/ and the older lock.json

export async function preToolUse(): Promise<void> {
  const input = await readStdin();
  const project = tryLoadProject(input.cwd ?? process.cwd());
  if (!project) return;
  const deny = (reason: string) => {
    emit(project.paths, 'warn', `Blocked the agent: ${reason}`, { tool: input.tool_name });
    out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
  };
  const tool = input.tool_name ?? '';
  if (WRITE_TOOLS.has(tool)) {
    const file = String(input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? '');
    if (!file) return;
    const abs = isAbsolute(file) ? file : resolve(project.root, file);
    const rel = relative(project.root, abs);
    if (rel.startsWith('..')) return;
    if (protectedMatcher(project)(rel)) {
      const isTest = picomatch(ALWAYS_PROTECTED, { dot: true })(rel);
      return deny(
        isTest
          ? `Gremlin: ${rel} is protected. Flows are the tests, and changing what is tested is never a fix. Fix the application instead; a human can change flows with \`gremlin flows\`.`
          : `Gremlin: ${rel} is in this project's protected_paths, so agents may not change it. Fix the problem somewhere else, or ask a human to change it.`,
      );
    }
    return;
  }
  if (tool === 'Bash') {
    const cmd = String(input.tool_input?.command ?? '');
    if (/\bgremlin\b.*\b(flows\s+(approve|retire|edit)|init\b)/.test(cmd)) {
      return deny('Gremlin: approving, retiring or editing flows is a human decision. Ask the user to do it.');
    }
    if (GUARDED_IN_SHELL.test(cmd) && DESTRUCTIVE.test(cmd) && !/git\s+(checkout|restore)\b/.test(cmd)) {
      return deny('Gremlin: that command would modify Gremlin flows or config. Fix the application instead.');
    }
  }
}

export async function stop(): Promise<void> {
  const input = await readStdin();
  const project = tryLoadProject(input.cwd ?? process.cwd());
  if (!project) return;
  // Gremlin's own Fixer launches the agent and verifies with Kane itself; don't nest the loop.
  if (process.env.GREMLIN_AGENT_RUN) return;
  if (!project.config.guard.trigger.includes('agent-finish')) return;

  const sid = input.session_id ?? 'default';
  const { state, s } = session(project, sid);
  const { files, fingerprint } = sessionChanges(project.root, s.baseline, s.untracked);
  if (isGitRepo(project.root) && !files.length) return; // no code changed this session: nothing to prove
  if (fingerprint && fingerprint === s.lastGuardAt && s.lastResult === 'passed') return; // already proven, unchanged since

  const kane = kaneStatus();
  if (!kane.installed || !kane.authenticated) {
    out({ systemMessage: `👹 Gremlin couldn't verify this change: Kane CLI is ${kane.installed ? 'not signed in (run `kane-cli login`)' : 'not installed'}.` });
    return;
  }

  emit(project.paths, 'agent', `Claude Code finished a task (${files.length} files changed); Guard is replaying the flows it touches`, { files });
  let report;
  try {
    report = await runGuard(project, { changed: isGitRepo(project.root) ? files : undefined, all: !isGitRepo(project.root), purpose: 'guard' });
  } catch (err) {
    out({ systemMessage: `👹 Gremlin Guard couldn't run: ${(err as Error).message}` });
    return;
  }
  s.lastGuardAt = fingerprint;

  if (!report.results.length) {
    s.lastResult = 'passed';
    writeState(project.paths, state);
    out({ systemMessage: `👹 Gremlin: no guarded flows cover this change (${report.reason}).` });
    return;
  }
  if (!report.blocking) {
    s.lastResult = 'passed';
    s.attempts = 0;
    s.escalated = false;
    writeState(project.paths, state);
    const waiting = report.results.filter((r) => r.status === 'unmerged').length; // failed, but only because a fix's PR isn't merged
    const verified = report.results.length - waiting;
    out({ systemMessage: `👹 Gremlin: ${verified} flow${verified === 1 ? '' : 's'} verified by Kane CLI in a real browser ✓ (${report.credits} credits)${waiting ? `; ${waiting} wait${waiting === 1 ? 's' : ''} on a fix that isn't merged yet` : ''}` });
    return;
  }

  s.lastResult = 'failed';
  s.attempts++;
  const limit = project.config.loop.attempts;
  if (s.attempts > limit) {
    s.escalated = true;
    writeState(project.paths, state);
    const bugs = [...new Set(report.results.map((r) => r.bug?.id).filter(Boolean))].join(', ');
    emit(project.paths, 'warn', `Claude Code could not get the flows green in ${limit} attempts; escalated to a human`, { bugs });
    out({ systemMessage: `👹 Gremlin: flows still failing after ${limit} attempts. Escalated to a human${bugs ? ` (${bugs})` : ''}. Run \`gremlin dash\` to see the evidence.` });
    return;
  }
  writeState(project.paths, state);
  emit(project.paths, 'agent', `Blocked "done": sent Kane's evidence back to Claude Code (attempt ${s.attempts} of ${limit})`, {});
  out({
    decision: 'block',
    reason: `${guardBrief(project, report)}\n\n(Gremlin attempt ${s.attempts} of ${limit}. When you've fixed the app, finish again and Gremlin will re-verify with Kane.)`,
  });
}

export async function runClaudeHook(event: string): Promise<void> {
  switch (event) {
    case 'session-start':
      return sessionStart();
    case 'pre-tool-use':
      return preToolUse();
    case 'stop':
      return stop();
    default:
      throw new Error(`Unknown hook event: ${event}`);
  }
}
