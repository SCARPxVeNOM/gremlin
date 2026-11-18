import { Link } from 'react-router-dom'
import { Bot, Bug, CircleAlert, Info, Play, Sparkles, TriangleAlert, type LucideIcon } from 'lucide-react'
import type { GEvent } from '@/lib/api'
import { useJobEvents } from '@/lib/live'
import { duration, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import { StatusIcon } from './status'

const KIND_ICON: Partial<Record<GEvent['kind'], { icon: LucideIcon; className: string }>> = {
  agent: { icon: Bot, className: 'text-series-1' },
  bug: { icon: Bug, className: 'text-critical' },
  info: { icon: Info, className: 'text-muted-foreground' },
  warn: { icon: TriangleAlert, className: 'text-warning' },
  error: { icon: CircleAlert, className: 'text-critical' },
}

interface FlowBlock {
  start: GEvent
  steps: Map<number, GEvent>
  actions: GEvent[]
  end?: GEvent
  notes: GEvent[]
}

/** Folds a job's raw events into readable blocks: one per Kane flow run, with loose notes in between. */
function fold(events: GEvent[]) {
  const items: ({ type: 'flow'; block: FlowBlock } | { type: 'note'; event: GEvent })[] = []
  let current: FlowBlock | undefined
  for (const e of events) {
    if (e.kind === 'job-start') continue
    if (e.kind === 'flow-start') {
      current = { start: e, steps: new Map(), actions: [], notes: [] }
      items.push({ type: 'flow', block: current })
    } else if (e.kind === 'kane-step' && current && e.data?.runId === current.start.data?.runId) {
      current.steps.set(Number(e.data?.index), e)
    } else if (e.kind === 'kane-action' && current && e.data?.runId === current.start.data?.runId) {
      current.actions.push(e)
    } else if (e.kind === 'flow-end' && current) {
      current.end = e
      current = undefined
    } else if (e.kind === 'info' && current && e.data?.runId === current.start.data?.runId) {
      current.notes.push(e)
    } else {
      items.push({ type: 'note', event: e })
    }
  }
  return items
}

function FlowRun({ block, live }: { block: FlowBlock; live: boolean }) {
  const status = block.end ? String(block.end.data?.status ?? 'failed') : live ? 'running' : 'error'
  const steps = [...block.steps.values()].sort((a, b) => Number(a.data?.index) - Number(b.data?.index))
  const lastAction = block.actions.at(-1)
  const runId = String(block.start.data?.runId ?? '')
  return (
    <li className="rounded-lg border">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <StatusIcon status={status} />
        <Link to={runId ? `/runs/${runId}` : '#'} className="min-w-0 flex-1 truncate text-sm font-medium hover:underline">
          {block.start.msg}
        </Link>
        {block.end?.data?.durationS !== undefined && <span className="text-muted-foreground text-xs tabular-nums">{duration(Number(block.end.data.durationS))}</span>}
        {block.end?.data?.credits !== undefined && <span className="text-muted-foreground text-xs tabular-nums">{Number(block.end.data.credits)} cr</span>}
      </div>
      {steps.length > 0 && (
        <ol className="space-y-1 border-t px-3 py-2">
          {steps.map((s) => (
            <li key={String(s.data?.index)} className="flex items-start gap-2 text-xs">
              <StatusIcon status={String(s.data?.status)} className="mt-px size-3.5" />
              <span className={cn('min-w-0 flex-1', s.data?.status === 'failed' ? 'text-foreground' : 'text-muted-foreground')}>
                {s.msg}
                {s.data?.reason && s.data?.status === 'failed' && <span className="text-critical mt-0.5 block">{String(s.data.reason)}</span>}
              </span>
              {s.data?.durationS !== undefined && <span className="text-muted-foreground tabular-nums">{duration(Number(s.data.durationS))}</span>}
            </li>
          ))}
        </ol>
      )}
      {live && !block.end && lastAction && (
        <div className="text-muted-foreground flex items-center gap-2 border-t px-3 py-2 text-xs">
          <Sparkles className="text-series-1 size-3.5 shrink-0" />
          <span className="truncate">Kane: {lastAction.msg}</span>
        </div>
      )}
      {block.notes.map((n, i) => (
        <div key={i} className="text-muted-foreground border-t px-3 py-1.5 text-xs">
          {n.msg}
        </div>
      ))}
    </li>
  )
}

function Note({ event }: { event: GEvent }) {
  if (event.kind === 'job-end') {
    return (
      <li className="flex items-start gap-2 px-1 text-sm">
        <StatusIcon status={String(event.data?.status ?? 'passed')} className="mt-0.5" />
        <span className="font-medium">{event.msg}</span>
      </li>
    )
  }
  const k = KIND_ICON[event.kind] ?? { icon: Info, className: 'text-muted-foreground' }
  const bugId = event.data?.bugId as string | undefined
  return (
    <li className="flex items-start gap-2 px-1 text-sm">
      <k.icon className={cn('mt-0.5 size-4 shrink-0', k.className)} />
      <span className={cn('min-w-0', event.kind === 'agent' && event.data?.activity ? 'text-muted-foreground font-mono text-xs leading-5' : '')}>
        {bugId && event.kind === 'bug' ? (
          <Link to={`/bugs/${bugId}`} className="hover:underline">
            {event.msg}
          </Link>
        ) : (
          event.msg
        )}
      </span>
    </li>
  )
}

/** The live loop: the most recent Gremlin job, streamed step by step. */
export function LiveFeed({ filter, empty, limit = 40 }: { filter?: (e: GEvent) => boolean; empty?: React.ReactNode; limit?: number }) {
  const { job, events, running, end } = useJobEvents(filter)
  if (!job) {
    return (
      <div className="text-muted-foreground flex flex-col items-center gap-2 py-10 text-center text-sm">
        <Play className="size-5" />
        {empty ?? 'Nothing has run yet. Start a hunt, capture a report, or run Guard.'}
      </div>
    )
  }
  const items = fold(events).slice(-limit)
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <StatusIcon status={running ? 'running' : String(end?.data?.status ?? 'passed')} />
        <span className="text-sm font-medium">{job.msg}</span>
        <span className="text-muted-foreground ml-auto text-xs">{running ? 'live' : timeAgo(end?.ts)}</span>
      </div>
      <ul className="space-y-2">
        {items.map((it, i) => (it.type === 'flow' ? <FlowRun key={i} block={it.block} live={running} /> : <Note key={i} event={it.event} />))}
      </ul>
    </div>
  )
}
