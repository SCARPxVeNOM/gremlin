import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useJobEvents, useLive } from '@/lib/live'
import { SNAPSHOT } from '@/lib/api'
import { cn } from '@/lib/utils'

/** Shows whether the dashboard is following the event stream, and what Gremlin is doing right now. */
export function LiveIndicator() {
  const { connected } = useLive()
  const { job, running } = useJobEvents()
  if (SNAPSHOT) {
    return (
      <span className="text-muted-foreground hidden h-8 items-center gap-2 rounded-md border px-2.5 text-xs sm:inline-flex">
        <span className="bg-muted-foreground size-1.5 rounded-full" />
        Recorded session
      </span>
    )
  }
  const label = !connected ? 'Reconnecting' : running ? job?.msg ?? 'Working' : 'Idle'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="text-muted-foreground hidden h-8 items-center gap-2 rounded-md border px-2.5 text-xs sm:inline-flex">
          <span className={cn('size-1.5 rounded-full', !connected ? 'bg-warning' : running ? 'bg-series-1 live-dot' : 'bg-good')} />
          <span className="max-w-48 truncate">{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{connected ? 'Live: following .gremlin/events.jsonl' : 'Lost the event stream; retrying'}</TooltipContent>
    </Tooltip>
  )
}
