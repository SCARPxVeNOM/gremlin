import { CircleCheck, MapPin, UserRound } from 'lucide-react'
import type { FlowView } from '@/lib/api'
import { Code } from './page'

/** A flow, rendered the way it reads: a numbered user journey and what must be true at the end. */
export function FlowDoc({ flow, failingIndex }: { flow: Pick<FlowView, 'start' | 'account' | 'steps' | 'expect'>; failingIndex?: number }) {
  return (
    <div className="space-y-5">
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span className="inline-flex items-center gap-1.5">
          <MapPin className="size-3.5" /> Starts at <Code>{flow.start}</Code>
        </span>
        {flow.account && (
          <span className="inline-flex items-center gap-1.5">
            <UserRound className="size-3.5" /> as <Code>{flow.account}</Code>
          </span>
        )}
      </div>
      <ol className="space-y-2.5">
        {flow.steps.map((s, i) => (
          <li key={i} className="flex gap-3">
            <span
              className={
                'flex size-6 shrink-0 items-center justify-center rounded-full border font-mono text-xs ' +
                (failingIndex === i + 1 ? 'border-critical text-critical' : 'text-muted-foreground')
              }
            >
              {i + 1}
            </span>
            <span className="pt-0.5 text-sm leading-relaxed">{s}</span>
          </li>
        ))}
      </ol>
      <div className="bg-muted/40 rounded-lg border p-4">
        <p className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">Expect</p>
        <ul className="space-y-1.5">
          {flow.expect.map((e, i) => (
            <li key={i} className="flex gap-2 text-sm">
              <CircleCheck className="text-muted-foreground mt-0.5 size-4 shrink-0" />
              {e}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
