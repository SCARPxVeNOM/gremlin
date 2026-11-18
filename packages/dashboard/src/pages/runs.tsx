import { useState } from 'react'
import { Link } from 'react-router-dom'
import { History } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Page, PageHeader, Empty, Code } from '@/components/page'
import { StatusBadge, TypeBadge } from '@/components/status'
import { useQuery } from '@/lib/live'
import type { RunLite } from '@/lib/api'
import { credits, duration, purposeLabel, timeAgo } from '@/lib/format'

const FILTERS = ['all', 'guard', 'breaker', 'capture', 'fix'] as const

export default function Runs() {
  const { data: runs, loading } = useQuery<RunLite[]>('runs?limit=200')
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all')
  const shown = (runs ?? []).filter((r) => filter === 'all' || r.purpose === filter || (filter === 'fix' && r.purpose === 'verify'))
  const total = shown.reduce((s, r) => s + r.credits, 0)

  return (
    <Page>
      <PageHeader
        title="Runs"
        description={
          <>
            Every Kane CLI execution, with its evidence. Recorded steps replay without AI, so Guard stays cheap: {credits(total)} credits across the runs below.
          </>
        }
      />
      <Tabs value={filter} onValueChange={(v) => setFilter(v as typeof filter)} className="mb-4">
        <TabsList>
          {FILTERS.map((f) => (
            <TabsTrigger key={f} value={f} className="capitalize">
              {f === 'all' ? 'All' : f === 'fix' ? 'Fixer' : purposeLabel[f]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {loading ? (
        <Skeleton className="h-96 rounded-xl" />
      ) : !shown.length ? (
        <Empty icon={<History />} title="No runs yet">
          Try <Code>gremlin run --all</Code>.
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-xl border">
          <Table>
            <TableHeader className="bg-muted/40">
              <TableRow>
                <TableHead>Result</TableHead>
                <TableHead>Flow</TableHead>
                <TableHead className="hidden md:table-cell">Loop</TableHead>
                <TableHead className="hidden xl:table-cell">Steps</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Time</TableHead>
                <TableHead className="hidden text-right lg:table-cell">Credits</TableHead>
                <TableHead className="text-right">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <StatusBadge status={r.status} />
                  </TableCell>
                  <TableCell className="w-full max-w-0">
                    <Link to={`/runs/${r.id}`} className="block truncate font-medium hover:underline">
                      {r.flowTitle}
                    </Link>
                    <span className="text-muted-foreground block truncate text-xs">
                      {r.kane?.failedStep ? `Failed at: ${r.kane.failedStep.heading}` : r.id}
                      {r.bugId ? ` · ${r.bugId}` : ''}
                    </span>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">{purposeLabel[r.purpose] ?? r.purpose}</span>
                      <TypeBadge type={r.flowType} />
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden text-xs whitespace-nowrap xl:table-cell">
                    {r.kane ? `${r.kane.replayed} replayed · ${r.kane.authored} authored` : '–'}
                  </TableCell>
                  <TableCell className="hidden text-right tabular-nums sm:table-cell">{duration(r.kane?.durationS)}</TableCell>
                  <TableCell className="hidden text-right tabular-nums lg:table-cell">{credits(r.credits)}</TableCell>
                  <TableCell className="text-muted-foreground text-right whitespace-nowrap">{timeAgo(r.startedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Page>
  )
}
