import { Link, useParams } from 'react-router-dom'
import { Ban, Bot, ChevronDown, FileCode2, History, Microscope, Quote, RotateCw, Scale, ShieldAlert, ShieldCheck, Swords, Trophy, Wrench } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Page, PageHeader, Code } from '@/components/page'
import { FlowDoc } from '@/components/flow-doc'
import { LiveFeed } from '@/components/live-feed'
import { ConsoleNetwork, KaneVerdictCard, StepTimeline } from '@/components/evidence'
import { Confidence, SeverityBadge, StatusBadge, StatusIcon } from '@/components/status'
import { useQuery } from '@/lib/live'
import { post, type ArenaEntry, type Bug, type FlowView, type Run } from '@/lib/api'
import { credits, duration, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import NotFound from './not-found'

interface BugDetailData {
  bug: Bug
  flow?: FlowView
  runs: Run[]
  packages: string[]
}

const ORIGIN: Record<string, string> = { breaker: 'Found by Breaker', capture: 'Reported by a user', guard: 'Caught by Guard' }

/** The closed loop for one bug, as four stages: found, reproduced by Kane, fixed by the agent, proven by Kane. */
function LoopStepper({ bug, runs }: { bug: Bug; runs: Run[] }) {
  const reproductions = runs.filter((r) => r.status === 'failed' && r.purpose !== 'fix' && r.purpose !== 'verify').length
  const reproduced = reproductions > 0
  const tried = bug.attempts.length > 0
  const fixing = bug.status === 'fixing'
  const proven = bug.status === 'fixed'
  const escalated = bug.status === 'escalated'
  const regressed = Boolean(bug.regressedAt) && !proven && !fixing
  const rejected = bug.status === 'rejected'
  const stages = [
    { label: ORIGIN[bug.origin], detail: timeAgo(bug.createdAt), state: 'done' },
    {
      label: 'Reproduced by Kane',
      detail: reproductions > 1 ? `failed first, reproduced ${reproductions} times` : reproduced ? 'failed first, as it should' : 'not yet',
      state: reproduced ? 'done' : 'todo',
    },
    {
      label: 'Agent fix',
      detail: tried ? `${bug.attempts.length} attempt${bug.attempts.length === 1 ? '' : 's'}` : rejected ? 'not needed' : 'not started',
      state: fixing ? 'active' : tried ? (escalated ? 'bad' : 'done') : 'todo',
    },
    {
      label: proven ? 'Proven by Kane' : escalated ? 'Escalated to a human' : regressed ? 'Regressed' : rejected ? 'Closed: not a bug' : 'Kane re-run',
      detail: proven ? timeAgo(bug.fixedAt) : escalated ? 'out of attempts' : regressed ? `Guard caught it coming back ${timeAgo(bug.regressedAt)}` : rejected ? 'a human rejected it' : 'pending',
      state: proven || rejected ? 'done' : escalated || regressed ? 'bad' : 'todo',
    },
  ]
  return (
    <ol className="grid gap-px overflow-hidden rounded-xl border sm:grid-cols-4">
      {stages.map((s, i) => (
        <li key={i} className={cn('bg-card flex items-start gap-3 p-4', s.state === 'todo' && 'opacity-60')}>
          <span
            className={cn(
              'flex size-7 shrink-0 items-center justify-center rounded-full border font-mono text-xs',
              s.state === 'done' && 'border-good text-good',
              s.state === 'active' && 'border-series-1 text-series-1',
              s.state === 'bad' && 'border-critical text-critical',
            )}
          >
            {s.state === 'active' ? <RotateCw className="size-3.5 animate-spin" /> : i + 1}
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-medium">{s.label}</span>
            <span className="text-muted-foreground block text-xs">{s.detail}</span>
          </span>
        </li>
      ))}
    </ol>
  )
}

function Attempt({ a, pkg }: { a: Bug['attempts'][number]; pkg?: string }) {
  return (
    <li className="rounded-lg border">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <StatusIcon status={a.result} />
        <span className="font-medium">Attempt {a.n}</span>
        <span className="text-muted-foreground text-sm">by {a.agent}</span>
        <StatusBadge status={a.result} className="ml-auto" />
        <span className="text-muted-foreground text-xs tabular-nums">{duration(a.durationS)}</span>
      </div>
      <div className="space-y-3 border-t px-4 py-3 text-sm">
        {a.agentSummary && (
          <p className="leading-relaxed">
            <Bot className="text-muted-foreground mr-1.5 inline size-4 align-text-bottom" />
            {a.agentSummary}
          </p>
        )}
        {a.changedFiles.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-muted-foreground text-xs">Changed</span>
            {a.changedFiles.map((f) => (
              <Badge key={f} variant="outline" className={cn('font-mono font-normal', a.outsideArea.includes(f) && 'border-warning')}>
                {f}
              </Badge>
            ))}
          </div>
        )}
        {a.outsideArea.length > 0 && <p className="text-muted-foreground text-xs">Outside the bug's area, flagged for review: {a.outsideArea.join(', ')}</p>}
        {a.blocked.length > 0 && (
          <p className="text-critical flex items-center gap-1.5 text-xs">
            <ShieldAlert className="size-3.5" /> Tried to edit protected files, reverted: {a.blocked.join(', ')}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {a.runId && (
            <Button variant="outline" size="sm" asChild>
              <Link to={`/runs/${a.runId}`}>
                <ShieldCheck /> Kane's re-run
              </Link>
            </Button>
          )}
          {a.relatedRuns?.map((r, i) => (
            <Button key={r} variant="ghost" size="sm" asChild>
              <Link to={`/runs/${r}`}>Related flow {i + 1}</Link>
            </Button>
          ))}
          {pkg && (
            <Collapsible className="w-full">
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="group -ml-2">
                  <FileCode2 /> What the agent was given
                  <ChevronDown className="transition-transform group-data-[state=open]:rotate-180" />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="bg-muted/40 mt-2 max-h-96 overflow-auto rounded-md border p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">{pkg}</pre>
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      </div>
    </li>
  )
}

const ARENA_RESULT: Record<ArenaEntry['result'], string> = {
  won: 'Winner',
  passed: 'Passed, larger fix',
  flaky: 'Flaky under Kane',
  failed: 'Kane failed it',
  'broke-related': 'Broke a related flow',
  'broke-startup': "App wouldn't start",
  'no-change': 'Changed nothing',
  'agent-error': 'Agent error',
}

function ArenaCard({ entries }: { entries: ArenaEntry[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Swords className="size-4" /> Agent arena
        </CardTitle>
        <CardDescription>
          {entries.length} agents fixed this at the same time. Kane judged every fix in a real browser; the smallest that passed won.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead className="text-right">Time</TableHead>
              <TableHead className="text-right">Lines</TableHead>
              <TableHead>Kane</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((e) => (
              <TableRow key={e.contender}>
                <TableCell className="font-medium">
                  <span className="inline-flex items-center gap-1.5">
                    {e.result === 'won' && <Trophy className="text-good size-3.5" />}
                    {e.label}
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground text-right tabular-nums">{e.durationS !== undefined ? duration(e.durationS) : '–'}</TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">{e.changedFiles.length ? `+${e.added} −${e.removed}` : '–'}</TableCell>
                <TableCell className="whitespace-normal">
                  {e.runId ? (
                    <Link to={`/runs/${e.runId}`} className={cn('underline-offset-4 hover:underline', e.result === 'won' || e.result === 'passed' ? 'text-good' : e.result === 'flaky' ? 'text-serious' : 'text-critical')}>
                      {ARENA_RESULT[e.result]}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">{ARENA_RESULT[e.result]}</span>
                  )}
                  {e.note && (
                    <div className="text-muted-foreground mt-0.5 line-clamp-2 text-xs" title={e.note}>
                      {e.note}
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

export default function BugDetail() {
  const { id = '' } = useParams()
  const { data, error } = useQuery<BugDetailData>(`bugs/${id}`)
  if (error) return <NotFound what="bug" />
  if (!data) {
    return (
      <Page>
        <Skeleton className="mb-6 h-12 w-2/3" />
        <Skeleton className="h-96 rounded-xl" />
      </Page>
    )
  }
  const { bug, flow, runs, packages } = data
  const evidenceRun = [...runs].reverse().find((r) => r.status === 'failed' && r.kane) ?? runs.at(-1)
  const failingIndex = evidenceRun?.kane?.steps.findIndex((s) => s.status === 'failed')
  const canFix = ['candidate', 'confirmed', 'escalated'].includes(bug.status)

  const act = async (action: 'fix' | 'verify' | 'reject', label: string) => {
    try {
      await post(`bugs/${bug.id}/${action}`)
      toast.success(label)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <Page>
      <PageHeader
        title={bug.title}
        actions={
          <>
            {bug.status !== 'rejected' && bug.status !== 'fixed' && (
              <Button variant="ghost" onClick={() => act('reject', `${bug.id} rejected`)}>
                <Ban /> Not a bug
              </Button>
            )}
            <Button variant="outline" onClick={() => act('verify', 'Kane is re-running the flow')}>
              <ShieldCheck /> Verify with Kane
            </Button>
            {canFix && (
              <Button onClick={() => act('fix', 'Handed to your coding agent. Kane will check the fix.')}>
                <Wrench /> Fix with agent
              </Button>
            )}
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-3 pt-1 text-sm">
          <span className="text-muted-foreground font-mono">{bug.id}</span>
          <StatusBadge status={bug.status} />
          {bug.regressedAt && bug.status !== 'fixed' && (
            <Badge variant="outline" className="gap-1 font-normal">
              <History className="text-serious" />
              Regressed
            </Badge>
          )}
          <SeverityBadge severity={bug.severity} />
          <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
            confidence <Confidence value={bug.confidence} />
          </span>
          <span className="text-muted-foreground text-xs">{credits(bug.credits)} credits</span>
        </div>
      </PageHeader>

      <LoopStepper bug={bug} runs={runs} />

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0 space-y-6">
          {bug.status === 'rejected' && bug.rejectedBecause && (
            <Card>
              <CardHeader>
                <CardTitle>Not a bug</CardTitle>
                <CardDescription>Kane saw the failure, and a human decided the product does what it promises.</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm">{bug.rejectedBecause}</p>
              </CardContent>
            </Card>
          )}
          {bug.contract && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Scale className="size-4" /> Broke a product rule
                </CardTitle>
                <CardDescription>The flow's own steps passed. Kane failed it on a behaviour contract from gremlin.config.yaml.</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm font-medium">{bug.contract}</p>
              </CardContent>
            </Card>
          )}

          {bug.arena && <ArenaCard entries={bug.arena.entries} />}

          {bug.report && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Quote className="size-4" /> The report
                </CardTitle>
                <CardDescription>
                  {bug.report.ref ?? bug.report.source} · personal details stripped before anything else saw it
                </CardDescription>
              </CardHeader>
              <CardContent>
                <blockquote className="border-l-2 pl-4 text-sm leading-relaxed whitespace-pre-wrap italic">{bug.report.text}</blockquote>
              </CardContent>
            </Card>
          )}

          {evidenceRun && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Microscope className="size-4" /> What Kane saw
                </CardTitle>
                <CardDescription>
                  {evidenceRun.kane?.failedStep ? (
                    <>
                      Failed at “{evidenceRun.kane.failedStep.heading}”{evidenceRun.retry ? `, and ${evidenceRun.retry.status} on the automatic retry` : ''}.
                    </>
                  ) : (
                    `Run ${evidenceRun.status}.`
                  )}
                </CardDescription>
                <CardAction>
                  <Button variant="ghost" size="sm" asChild>
                    <Link to={`/runs/${evidenceRun.id}`}>Full run</Link>
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent>
                <StepTimeline run={evidenceRun} />
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Wrench className="size-4" /> Fix attempts
              </CardTitle>
              <CardDescription>Each attempt is judged by Kane re-running the flow, plus related flows to catch side effects.</CardDescription>
            </CardHeader>
            <CardContent>
              {bug.attempts.length ? (
                <ol className="space-y-3">
                  {bug.attempts.map((a, i) => (
                    <Attempt key={a.n} a={a} pkg={packages[i]} />
                  ))}
                </ol>
              ) : (
                <p className="text-muted-foreground text-sm">
                  No attempts yet. <strong>Fix with agent</strong> hands the evidence to your coding agent, or run <Code>gremlin fix {bug.id}</Code>.
                </p>
              )}
            </CardContent>
          </Card>

          {evidenceRun && <ConsoleNetwork run={evidenceRun} />}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Live</CardTitle>
              <CardDescription>The latest Gremlin job for {bug.id}.</CardDescription>
            </CardHeader>
            <CardContent className="max-h-[32rem] overflow-auto">
              <LiveFeed filter={(e) => e.data?.bugId === bug.id || (e.kind === 'job-start' && e.msg.includes(bug.id))} empty="Nothing running for this bug." />
            </CardContent>
          </Card>
          {evidenceRun && <KaneVerdictCard run={evidenceRun} />}
          {flow && (
            <Card>
              <CardHeader>
                <CardTitle>Repro flow</CardTitle>
                <CardAction>
                  <Button variant="ghost" size="sm" asChild>
                    <Link to={`/flows/${flow.id}`}>Open</Link>
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent>
                <FlowDoc flow={flow} failingIndex={failingIndex !== undefined && failingIndex >= 0 ? failingIndex + 1 : undefined} />
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </Page>
  )
}
