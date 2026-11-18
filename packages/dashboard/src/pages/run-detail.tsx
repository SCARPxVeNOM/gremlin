import { Link, useParams } from 'react-router-dom'
import { Archive, Clock, Coins, Repeat, Sparkles } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Page, PageHeader } from '@/components/page'
import { ConsoleNetwork, KaneVerdictCard, StepTimeline } from '@/components/evidence'
import { StatusBadge, TypeBadge } from '@/components/status'
import { useQuery } from '@/lib/live'
import type { Run } from '@/lib/api'
import { credits, duration, purposeLabel, timeAgo } from '@/lib/format'
import NotFound from './not-found'

function Fact({ icon: Icon, label, value }: { icon: typeof Clock; label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border px-4 py-3">
      <Icon className="text-muted-foreground size-4" />
      <div>
        <p className="text-muted-foreground text-xs">{label}</p>
        <p className="text-sm font-medium tabular-nums">{value}</p>
      </div>
    </div>
  )
}

export default function RunDetail() {
  const { id = '' } = useParams()
  const { data: run, error } = useQuery<Run>(`runs/${id}`)
  if (error) return <NotFound what="run" />
  if (!run) {
    return (
      <Page>
        <Skeleton className="mb-6 h-12 w-2/3" />
        <Skeleton className="h-96 rounded-xl" />
      </Page>
    )
  }
  const k = run.kane

  return (
    <Page>
      <PageHeader
        title={run.flowTitle}
        actions={
          <>
            {run.bugId && (
              <Button variant="outline" asChild>
                <Link to={`/bugs/${run.bugId}`}>{run.bugId}</Link>
              </Button>
            )}
            <Button variant="outline" asChild>
              <Link to={`/flows/${run.flowId}`}>Open flow</Link>
            </Button>
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-2 pt-1 text-sm">
          <StatusBadge status={run.status} />
          <TypeBadge type={run.flowType} />
          <span className="text-muted-foreground">
            {purposeLabel[run.purpose] ?? run.purpose}
            {run.attempt ? ` · attempt ${run.attempt}` : ''} · {timeAgo(run.startedAt)} · <span className="font-mono text-xs">{run.id}</span>
          </span>
        </div>
      </PageHeader>

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Fact icon={Clock} label="Kane time" value={duration(k?.durationS)} />
        <Fact icon={Repeat} label="Steps replayed from cache" value={k ? `${k.replayed} of ${k.steps.length}` : '–'} />
        <Fact icon={Sparkles} label="Steps authored by AI" value={k ? k.authored : '–'} />
        <Fact icon={Coins} label="Credits" value={credits(run.credits)} />
      </div>

      {run.status === 'error' && k?.errors?.length ? (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Kane couldn't run this flow</CardTitle>
            <CardDescription>This is an infrastructure problem, not a verdict on the product.</CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="bg-muted/40 overflow-auto rounded-md border p-3 font-mono text-xs whitespace-pre-wrap">{k.errors.join('\n')}</pre>
          </CardContent>
        </Card>
      ) : null}

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Steps</CardTitle>
            <CardDescription>
              {k?.failedStep ? `Failed at “${k.failedStep.heading}”: ${k.reason ?? ''}` : (k?.summary ?? `Run ${run.status}.`)}
              {run.retry && ` The automatic retry ${run.retry.status}.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <StepTimeline run={run} />
          </CardContent>
        </Card>
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <KaneVerdictCard run={run} />
          <ConsoleNetwork run={run} />
          {run.evidence?.pack && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Archive className="size-4" /> Evidence pack
                </CardTitle>
                <CardDescription>Kane's full pack: failure.yaml, console, network HAR and step screenshots.</CardDescription>
              </CardHeader>
              <CardContent>
                <code className="bg-muted block rounded px-2 py-1.5 font-mono text-xs break-all">{run.evidence.pack.split('/').slice(-3).join('/')}</code>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </Page>
  )
}
