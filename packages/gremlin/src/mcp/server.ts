import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { failureBrief } from '../core/brief.ts';
import { runBreaker } from '../core/breaker.ts';
import { runCapture } from '../core/capture.ts';
import { loadProject, type Project } from '../core/config.ts';
import { verifyBug } from '../core/fixer.ts';
import { getFlow, lintFlow, saveFlow } from '../core/flow.ts';
import { flowSafetyIssues } from '../core/guardrails.ts';
import { guardBrief, runGuard } from '../core/guard.ts';
import { getBug, getRun, listBugs } from '../core/store.ts';
import { flowViews, summarize } from '../core/summary.ts';
import { describeRun } from '../core/runner.ts';

/**
 * Gremlin as MCP tools, so any agent (Claude Code, Cursor, Windsurf, Kiro, your own)
 * can run flows, read Kane's evidence, capture bugs and verify fixes mid-task.
 * Agents can draft flows but never approve, edit or retire them.
 */

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

function project(): Project {
  return loadProject(process.env.GREMLIN_ROOT ?? process.cwd());
}

export async function startMcp(): Promise<void> {
  const server = new McpServer({ name: 'gremlin', version: '0.1.0' });

  server.registerTool(
    'gremlin_status',
    {
      title: 'Gremlin status',
      description: 'Summary of the flow library, open bugs and Kane credit use for this project.',
      inputSchema: {},
    },
    async () => {
      const p = project();
      const s = summarize(p);
      const open = listBugs(p.paths).filter((b) => ['candidate', 'confirmed', 'fixing', 'escalated'].includes(b.status));
      return text(
        [
          `${s.app.name} at ${s.app.url}`,
          `Flows: ${s.counts.flows.happy} happy, ${s.counts.flows.adversarial} adversarial, ${s.counts.flows.regression} regression`,
          `Bugs: ${s.counts.bugsFound} found, ${s.counts.bugsFixed} fixed, ${s.counts.open} open`,
          `Kane credits today: ${s.credits.today} of ${s.credits.budget.per_day}`,
          ...open.map((b) => `- ${b.id} [${b.severity}, ${b.status}] ${b.title}`),
        ].join('\n'),
      );
    },
  );

  server.registerTool(
    'gremlin_list_flows',
    {
      title: 'List flows',
      description: 'List the plain-English user flows Gremlin guards, with their status and last Kane result.',
      inputSchema: { type: z.enum(['happy', 'adversarial', 'regression']).optional(), tag: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ type, tag }) => {
      const flows = flowViews(project()).filter((f) => (!type || f.type === type) && (!tag || f.tags.includes(tag.toLowerCase())));
      return text(flows.map((f) => `${f.id} [${f.status}${f.last ? `, last ${f.last}` : ''}] ${f.title}  tags: ${f.tags.join(', ')}`).join('\n') || 'No flows yet.');
    },
  );

  server.registerTool(
    'gremlin_guard',
    {
      title: 'Verify with Kane',
      description:
        'Replay the flows affected by your current changes in a real browser with Kane CLI. Call this before saying a task is done. Returns pass, or the evidence you need to fix the app.',
      inputSchema: {
        all: z.boolean().optional().describe('Replay every active flow instead of only those your changes touch'),
        flows: z.array(z.string()).optional().describe('Specific flow ids to run'),
        tags: z.array(z.string()).optional(),
      },
    },
    async ({ all, flows, tags }) => {
      const p = project();
      const report = await runGuard(p, { all, flowIds: flows, tags });
      return text(`${guardBrief(p, report)}\n\n${report.results.map((r) => `- ${r.flow.id}: ${r.run ? describeRun(r.run) : r.status}`).join('\n')}`);
    },
  );

  server.registerTool(
    'gremlin_get_evidence',
    {
      title: 'Get Kane evidence',
      description: "Kane's evidence for a run or a bug: failing step, verdict, console and network errors, and the failing screenshot.",
      inputSchema: { id: z.string().describe('A run id (RUN-…) or bug id (BUG-…)') },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const p = project();
      let run = id.toUpperCase().startsWith('RUN') ? getRun(p.paths, id) : undefined;
      if (!run) {
        const bug = getBug(p.paths, id);
        if (bug) run = getRun(p.paths, bug.runs[bug.runs.length - 1]);
      }
      if (!run) return text(`No run or bug ${id}.`);
      const flow = getFlow(p.paths, run.flowId);
      const content: any[] = [{ type: 'text', text: flow ? failureBrief(p, flow, run) : describeRun(run) }];
      const shot = run.evidence?.failure?.screenshot ?? run.evidence?.screenshots.at(-1);
      if (shot) {
        const file = join(p.paths.evidence, run.id, shot);
        if (existsSync(file)) {
          content.push({ type: 'image', data: readFileSync(file).toString('base64'), mimeType: shot.endsWith('.png') ? 'image/png' : 'image/jpeg' });
        }
      }
      return { content };
    },
  );

  server.registerTool(
    'gremlin_capture',
    {
      title: 'Capture a bug report',
      description:
        'Turn a bug report (support message, issue text) into a plain-English repro flow, then have Kane run it. The repro is only accepted if Kane watches it fail first.',
      inputSchema: { report: z.string(), ref: z.string().optional().describe('Where the report came from, e.g. an issue number') },
    },
    async ({ report, ref }) => {
      const p = project();
      const r = await runCapture(p, { text: report, source: 'mcp', ref });
      return text(
        [r.message, r.flow ? `Flow: ${r.flow.id}` : '', r.bug ? `Bug: ${r.bug.id}` : '', ...r.questions.map((q) => `Question: ${q}`)].filter(Boolean).join('\n'),
      );
    },
  );

  server.registerTool(
    'gremlin_break',
    {
      title: 'Run the Breaker',
      description: 'Attack the app like a hostile user (double-submits, emoji, back button, empty forms …) and report real bugs Kane confirms.',
      inputSchema: { areas: z.array(z.string()).optional(), max: z.number().int().min(1).max(12).optional() },
    },
    async ({ areas, max }) => {
      const p = project();
      const r = await runBreaker(p, { areas, max });
      const lines = r.findings.map((f) => `- ${f.outcome === 'bug' ? `${f.bug!.id} [${f.bug!.severity}]` : f.outcome}: ${f.flow.title}`);
      return text(`${r.findings.filter((f) => f.outcome === 'bug').length} bugs from ${r.findings.length} attacks (${Math.round(r.credits)} credits)\n${lines.join('\n')}`);
    },
  );

  server.registerTool(
    'gremlin_verify_fix',
    {
      title: 'Verify a fix',
      description: "Re-run a bug's flow with Kane after you changed the code. The bug is only marked fixed if Kane passes it.",
      inputSchema: { bug: z.string() },
    },
    async ({ bug }) => {
      const p = project();
      const { bug: b, run } = await verifyBug(p, bug);
      const flow = getFlow(p.paths, b.flowId);
      return text(run.status === 'passed' ? `${b.id} verified fixed by Kane: ${describeRun(run)}` : flow ? failureBrief(p, flow, run) : describeRun(run));
    },
  );

  server.registerTool(
    'gremlin_draft_flow',
    {
      title: 'Draft a flow',
      description: 'Propose a new plain-English flow. It is saved as a draft; only a human can approve it into the library.',
      inputSchema: {
        title: z.string(),
        type: z.enum(['happy', 'adversarial']).default('happy'),
        start: z.string().default('/'),
        steps: z.array(z.string()).min(1),
        expect: z.array(z.string()).min(1),
        tags: z.array(z.string()).default([]),
      },
    },
    async (args) => {
      const p = project();
      const issues = [...lintFlow(args).map((i) => i.message), ...flowSafetyIssues(args)];
      if (issues.some((i) => /no numbered|explicit expectations|title|real|card|money/.test(i))) return text(`Rejected: ${issues.join(' ')}`);
      const flow = saveFlow(p.paths, { ...args, source: 'agent', status: 'draft' });
      return text(`Saved draft ${flow.id}. A human approves it with \`gremlin flows approve ${flow.id}\`.${issues.length ? `\nNotes: ${issues.join(' ')}` : ''}`);
    },
  );

  await server.connect(new StdioServerTransport());
}
