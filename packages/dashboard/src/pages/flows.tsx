import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Check, Lock, MoreHorizontal, Play, Route, Scale, Search, ShieldAlert, Archive } from 'lucide-react'
import { toast } from 'sonner'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Page, PageHeader, Empty, Code } from '@/components/page'
import { Stability, StatusBadge, StatusIcon, TypeBadge } from '@/components/status'
import { useQuery } from '@/lib/live'
import { post, SNAPSHOT, type FlowView } from '@/lib/api'
import { timeAgo } from '@/lib/format'

const TABS = ['all', 'happy', 'adversarial', 'regression', 'review'] as const

export async function flowAction(id: string, action: 'approve' | 'retire' | 'run', refetch?: () => void) {
  try {
    await post(`flows/${id}/${action}`)
    toast.success(action === 'run' ? 'Kane is running the flow' : action === 'approve' ? 'Approved: the flow is now active and locked' : 'Retired')
    refetch?.()
  } catch (e) {
    toast.error((e as Error).message)
  }
}

export default function Flows() {
  const { data: flows, loading, refetch } = useQuery<FlowView[]>('flows')
  const [tab, setTab] = useState<(typeof TABS)[number]>('all')
  const [q, setQ] = useState('')

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0, happy: 0, adversarial: 0, regression: 0, review: 0 }
    for (const f of flows ?? []) {
      if (f.status === 'retired') continue
      c.all++
      c[f.type]++
      if (f.status === 'draft' || f.status === 'confirmed' || f.tampered) c.review++
    }
    return c
  }, [flows])

  const shown = (flows ?? [])
    .filter((f) => (tab === 'all' ? f.status !== 'retired' : tab === 'review' ? f.status === 'draft' || f.status === 'confirmed' || f.tampered : f.type === tab))
    .filter((f) => !q || `${f.title} ${f.tags.join(' ')} ${f.start}`.toLowerCase().includes(q.toLowerCase()))

  return (
    <Page>
      <PageHeader
        title="Flows"
        description={
          <>
            User journeys in plain English, stored in <Code>.gremlin/flows</Code> and compiled to Kane tests. Agents can't edit them: only a human approves or retires a flow.
          </>
        }
      />
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList>
            {TABS.map((t) => (
              <TabsTrigger key={t} value={t} className="capitalize">
                {t === 'review' ? 'Needs review' : t}
                <span className="text-muted-foreground ml-1 tabular-nums">{counts[t]}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="relative sm:w-64">
          <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input placeholder="Filter flows…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
        </div>
      </div>

      {loading ? (
        <Skeleton className="h-96 rounded-xl" />
      ) : !shown.length ? (
        <Empty icon={<Route />} title={tab === 'review' ? 'Nothing waiting for review' : 'No flows here yet'}>
          Run <Code>gremlin init</Code> to draft happy paths, <Code>gremlin break</Code> to hunt, or <Code>gremlin capture</Code> to turn a report into a regression flow.
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-xl border">
          <Table>
            <TableHeader className="bg-muted/40">
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Flow</TableHead>
                <TableHead className="hidden md:table-cell">Type</TableHead>
                <TableHead>Last run</TableHead>
                <TableHead className="hidden lg:table-cell">Stability</TableHead>
                <TableHead className="hidden text-right lg:table-cell">Runs</TableHead>
                {!SNAPSHOT && <TableHead className="w-10" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((f) => (
                <TableRow key={f.id}>
                  <TableCell>
                    <Tooltip>
                      <TooltipTrigger>
                        <StatusIcon status={f.tampered ? 'tampered' : f.status} />
                      </TooltipTrigger>
                      <TooltipContent className="capitalize">{f.tampered ? 'Edited since it was approved' : f.status}</TooltipContent>
                    </Tooltip>
                  </TableCell>
                  <TableCell className="w-full max-w-0">
                    <Link to={`/flows/${f.id}`} className="flex items-center gap-2 font-medium hover:underline">
                      <span className="truncate">{f.title}</span>
                      {f.locked && <Lock className="text-muted-foreground size-3 shrink-0" aria-label="Locked" />}
                      {f.tampered && <ShieldAlert className="text-critical size-3.5 shrink-0" aria-label="Edited without approval" />}
                      {f.status === 'draft' && isDisputed(f) && (
                        <Badge variant="outline" className="shrink-0 gap-1 font-normal">
                          <Scale className="text-warning" />
                          Disputed
                        </Badge>
                      )}
                    </Link>
                    <div className="text-muted-foreground mt-0.5 flex gap-2 truncate text-xs">
                      <span className="font-mono">{f.start}</span>
                      {f.tags.length > 0 && <span>· {f.tags.join(', ')}</span>}
                      {f.bug && <span>· {f.bug}</span>}
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <TypeBadge type={f.type} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <div className="flex flex-col items-start gap-1">
                      <StatusBadge status={f.last} />
                      {f.lastRunAt && <span className="text-muted-foreground text-xs">{timeAgo(f.lastRunAt)}</span>}
                    </div>
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    <Stability value={f.stability} />
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden text-right tabular-nums lg:table-cell">{f.runs}</TableCell>
                  <TableCell className={SNAPSHOT ? 'hidden' : undefined}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="size-8" aria-label={`Actions for ${f.title}`}>
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => flowAction(f.id, 'run', refetch)}>
                          <Play /> Run with Kane
                        </DropdownMenuItem>
                        {(f.status !== 'active' || f.tampered) && f.status !== 'retired' && (
                          <DropdownMenuItem onSelect={() => flowAction(f.id, 'approve', refetch)}>
                            <Check /> Approve and lock
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onSelect={() => flowAction(f.id, 'retire', refetch)}>
                          <Archive /> Retire
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Page>
  )
}

/** Kane blamed the flow, but the agent that wrote it argues the product is at fault: a human decides. */
export function isDisputed(f: FlowView) {
  return /disputes Kane's triage/.test(f.notes)
}
