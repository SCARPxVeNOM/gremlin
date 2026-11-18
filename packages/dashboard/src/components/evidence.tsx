import { useState } from 'react'
import { ExternalLink, Globe, ImageOff, ScanSearch, Terminal } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { evidenceUrl, type Run } from '@/lib/api'
import { duration } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Confidence, StatusIcon } from './status'
import { Code } from './page'

/** What Kane saw: its step timeline next to the screenshot of whichever step is selected. */
export function StepTimeline({ run }: { run: Run }) {
  const steps = run.kane?.steps ?? []
  const shots = run.evidence?.steps ?? []
  const failedIdx = steps.findIndex((s) => s.status === 'failed')
  const [selected, setSelected] = useState<number>(failedIdx >= 0 ? failedIdx : Math.max(0, steps.length - 1))
  const failure = run.evidence?.failure

  // Evidence actions are numbered "<step>-<action>", with steps counted from zero.
  const actionsFor = (i: number) => shots.filter((a) => a.id.split('-')[0] === String(i))
  const shotFor = (i: number) => {
    if (i === failedIdx && failure?.screenshot) return failure.screenshot
    return actionsFor(i)
      .filter((a) => a.screenshot)
      .at(-1)?.screenshot
  }
  const shot = shotFor(selected)
  const actions = actionsFor(selected)

  if (!steps.length) return <p className="text-muted-foreground text-sm">Kane didn't report any steps for this run.</p>

  return (
    <div className="@container">
      <div className="grid gap-4 @2xl:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
        <ol className="space-y-1">
          {steps.map((s, i) => (
            <li key={i}>
              <button
                type="button"
                onClick={() => setSelected(i)}
                className={cn(
                  'hover:bg-muted/60 flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors',
                  selected === i && 'bg-muted',
                )}
              >
                <StatusIcon status={s.status} className="mt-0.5" />
                <span className="min-w-0 flex-1">
                  <span className="block">{s.heading}</span>
                  {s.status === 'failed' && s.reason && <span className="text-critical mt-0.5 block text-xs">{s.reason}</span>}
                  {s.status !== 'failed' && s.summary && <span className="text-muted-foreground mt-0.5 line-clamp-2 block text-xs">{s.summary}</span>}
                </span>
                <span className="text-muted-foreground flex shrink-0 flex-col items-end gap-1 text-xs tabular-nums">
                  {duration(s.durationS)}
                  {s.replayed && (
                    <Badge variant="outline" className="h-4 px-1 text-[10px] font-normal">
                      replay
                    </Badge>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ol>
        <div className="order-first space-y-3 self-start @2xl:sticky @2xl:top-20 @2xl:order-none">
          <div className="bg-muted/30 overflow-hidden rounded-lg border">
            {shot ? (
              <a href={evidenceUrl(run.id, shot)} target="_blank" rel="noreferrer" className="block">
                <img src={evidenceUrl(run.id, shot)} alt={`Screenshot after ${steps[selected]?.heading}`} className="w-full" />
              </a>
            ) : (
              <div className="text-muted-foreground flex min-h-48 flex-col items-center justify-center gap-2 p-8 text-center text-sm">
                <ImageOff className="size-5" />
                No screenshot for this step.
              </div>
            )}
          </div>
          {actions.length > 0 && (
            <ol className="space-y-1.5 text-xs">
              {actions.map((a) => (
                <li key={a.id} className="flex items-start gap-2">
                  <StatusIcon status={a.status} className="mt-px size-3.5" />
                  <span className="text-muted-foreground min-w-0">{a.summary?.replace(/^\w+: /, '')}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  )
}

export function KaneVerdictCard({ run }: { run: Run }) {
  const v = run.kane?.verdict
  const f = run.evidence?.failure
  if (!v && !f) return null
  const product = v?.family ? !/automation|test|flak/i.test(v.family) : undefined
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ScanSearch className="size-4" /> Kane's triage
        </CardTitle>
        <CardDescription>A lead, not a verdict on the code. Gremlin hands it to the agent as context, never as instructions.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {(v?.oneLiner || v?.title) && <p className="font-medium">{v.oneLiner ?? v.title}</p>}
        <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2">
          {product !== undefined && (
            <>
              <dt className="text-muted-foreground">Judged as</dt>
              <dd>{product ? 'Product bug' : 'Automation problem'}</dd>
            </>
          )}
          {(v?.category || f?.category) && (
            <>
              <dt className="text-muted-foreground">Category</dt>
              <dd className="capitalize">{(v?.category ?? f?.category)?.replace(/_/g, ' ')}</dd>
            </>
          )}
          {(v?.confidence ?? f?.confidence) !== undefined && (
            <>
              <dt className="text-muted-foreground">Confidence</dt>
              <dd>
                <Confidence value={(v?.confidence ?? f?.confidence)! > 1 ? (v?.confidence ?? f?.confidence)! / 100 : (v?.confidence ?? f?.confidence)!} />
              </dd>
            </>
          )}
          {f?.pageUrl && (
            <>
              <dt className="text-muted-foreground">Page</dt>
              <dd className="truncate">
                <Code>{f.pageUrl}</Code>
              </dd>
            </>
          )}
        </dl>
        {(v?.rootCause || f?.rootCause) && (
          <div>
            <p className="text-muted-foreground mb-1 text-xs font-medium tracking-wide uppercase">Likely root cause</p>
            <p className="leading-relaxed">{v?.rootCause ?? f?.rootCause}</p>
          </div>
        )}
        {(v?.suggestion || f?.suggestedFix) && (
          <div>
            <p className="text-muted-foreground mb-1 text-xs font-medium tracking-wide uppercase">Suggested fix</p>
            <p className="leading-relaxed">{v?.suggestion ?? f?.suggestedFix}</p>
          </div>
        )}
        {run.kane?.shareUrl && (
          <Button variant="outline" size="sm" asChild>
            <a href={run.kane.shareUrl} target="_blank" rel="noreferrer">
              Open the Kane session <ExternalLink />
            </a>
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

export function ConsoleNetwork({ run }: { run: Run }) {
  const consoleErrors = run.evidence?.consoleErrors ?? []
  const network = run.evidence?.networkFailures ?? []
  if (!consoleErrors.length && !network.length) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Terminal className="size-4" /> Console & network
        </CardTitle>
        <CardDescription>From Kane's evidence pack, with personal details redacted.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {network.length > 0 && (
          <ul className="divide-y rounded-md border">
            {network.slice(0, 12).map((n, i) => (
              <li key={i} className="flex items-center gap-3 px-3 py-2 font-mono text-xs">
                <Globe className="text-muted-foreground size-3.5 shrink-0" />
                <span className={cn('w-10 shrink-0 font-semibold tabular-nums', n.status >= 500 || n.status === 0 ? 'text-critical' : 'text-serious')}>
                  {n.status || 'ERR'}
                </span>
                <span className="text-muted-foreground w-12 shrink-0">{n.method}</span>
                <span className="truncate">{n.url}</span>
              </li>
            ))}
          </ul>
        )}
        {consoleErrors.length > 0 && (
          <pre className="bg-muted/50 max-h-64 overflow-auto rounded-md border p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
            {consoleErrors.slice(0, 20).join('\n')}
          </pre>
        )}
      </CardContent>
    </Card>
  )
}
