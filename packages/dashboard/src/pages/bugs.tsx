import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Bug as BugIcon } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Page, PageHeader, Empty, Code } from '@/components/page'
import { Confidence, SeverityBadge, StatusBadge } from '@/components/status'
import { useQuery } from '@/lib/live'
import { SNAPSHOT, type Bug } from '@/lib/api'
import { credits, timeAgo } from '@/lib/format'

const OPEN = ['candidate', 'confirmed', 'fixing', 'escalated']
const ORIGIN: Record<string, string> = { breaker: 'Breaker', capture: 'Report', guard: 'Guard' }

export default function Bugs() {
  const { data: bugs, loading } = useQuery<Bug[]>('bugs')
  const [tab, setTab] = useState<'open' | 'fixed' | 'all'>(SNAPSHOT ? 'all' : 'open')
  const all = bugs ?? []
  const shown = all.filter((b) => (tab === 'open' ? OPEN.includes(b.status) : tab === 'fixed' ? b.status === 'fixed' : true))

  return (
    <Page>
      <PageHeader
        title="Bugs"
        description={
          <>
            Every bug here was reproduced by Kane before it was filed. A bug only becomes <em>fixed</em> when Kane re-runs its flow and the flow passes.
          </>
        }
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="mb-4">
        <TabsList>
          <TabsTrigger value="open">
            Open <span className="text-muted-foreground ml-1 tabular-nums">{all.filter((b) => OPEN.includes(b.status)).length}</span>
          </TabsTrigger>
          <TabsTrigger value="fixed">
            Fixed <span className="text-muted-foreground ml-1 tabular-nums">{all.filter((b) => b.status === 'fixed').length}</span>
          </TabsTrigger>
          <TabsTrigger value="all">
            All <span className="text-muted-foreground ml-1 tabular-nums">{all.length}</span>
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {loading ? (
        <Skeleton className="h-96 rounded-xl" />
      ) : !shown.length ? (
        <Empty icon={<BugIcon />} title={tab === 'open' ? 'No open bugs' : 'Nothing here yet'}>
          Start a hunt with <Code>gremlin break</Code>, or paste a user complaint on the Capture page.
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-xl border">
          <Table>
            <TableHeader className="bg-muted/40">
              <TableRow>
                <TableHead className="w-20">ID</TableHead>
                <TableHead>Bug</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden lg:table-cell">Confidence</TableHead>
                <TableHead className="hidden text-right md:table-cell">Fix attempts</TableHead>
                <TableHead className="hidden text-right xl:table-cell">Credits</TableHead>
                <TableHead className="text-right">Found</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((b) => (
                <TableRow key={b.id}>
                  <TableCell className="text-muted-foreground font-mono text-xs">{b.id}</TableCell>
                  <TableCell className="w-full max-w-0">
                    <Link to={`/bugs/${b.id}`} className="block truncate font-medium hover:underline">
                      {b.title}
                    </Link>
                    <span className="text-muted-foreground text-xs">
                      {ORIGIN[b.origin]}
                      {b.attack ? ` · ${b.attack}` : ''}
                      {b.report?.ref ? ` · ${b.report.ref}` : ''}
                    </span>
                  </TableCell>
                  <TableCell>
                    <SeverityBadge severity={b.severity} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={b.status} />
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    <Confidence value={b.confidence} />
                  </TableCell>
                  <TableCell className="hidden text-right tabular-nums md:table-cell">{b.attempts.length || '–'}</TableCell>
                  <TableCell className="text-muted-foreground hidden text-right tabular-nums xl:table-cell">{credits(b.credits)}</TableCell>
                  <TableCell className="text-muted-foreground text-right whitespace-nowrap">{timeAgo(b.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Page>
  )
}
