import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { ArrowRight, Bug, Coins, ShieldCheck, Swords, Wrench } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Page, PageHeader, Code } from '@/components/page'
import { LiveFeed } from '@/components/live-feed'
import { SeverityBadge, StatusBadge, StatusIcon } from '@/components/status'
import { useQuery, useBusy } from '@/lib/live'
import { post, type Bug as BugT, type RunLite, type Summary } from '@/lib/api'
import { credits, duration, purposeLabel, timeAgo } from '@/lib/format'

const chartConfig = {
  found: { label: 'Found', color: 'var(--series-2)' },
  fixed: { label: 'Fixed', color: 'var(--series-1)' },
} satisfies ChartConfig

function Stat({ title, value, icon: Icon, hint, to }: { title: string; value: React.ReactNode; icon: typeof Bug; hint?: React.ReactNode; to?: string }) {
  const body = (
    <Card className="h-full gap-2 transition-colors hover:bg-muted/30">
      <CardHeader>
        <CardDescription className="flex items-center gap-2">
          <Icon className="size-4" /> {title}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-semibold tracking-tight tabular-nums">{value}</div>
        {hint && <p className="text-muted-foreground mt-1 text-xs">{hint}</p>}
      </CardContent>
    </Card>
  )
  return to ? <Link to={to}>{body}</Link> : body
}

function FoundFixedChart({ data }: { data: Summary['timeline'] }) {
  const [view, setView] = useState<'chart' | 'table'>('chart')
  const rows = data.map((d) => ({ ...d, label: new Date(d.day + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }))
  const max = Math.max(1, ...rows.map((r) => Math.max(r.found, r.fixed)))
  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>Bugs found and fixed</CardTitle>
        <CardDescription>Last 14 days. Fixed means Kane re-ran the flow and it passed.</CardDescription>
        <CardAction>
          <ToggleGroup type="single" size="sm" variant="outline" value={view} onValueChange={(v) => v && setView(v as 'chart' | 'table')}>
            <ToggleGroupItem value="chart">Chart</ToggleGroupItem>
            <ToggleGroupItem value="table">Table</ToggleGroupItem>
          </ToggleGroup>
        </CardAction>
      </CardHeader>
      <CardContent>
        {view === 'chart' ? (
          <ChartContainer config={chartConfig} className="aspect-auto h-64 w-full">
            <BarChart data={rows} barGap={2} barCategoryGap="28%" margin={{ left: -20, right: 4, top: 8 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={44} domain={[0, max]} />
              <ChartTooltip cursor={{ fillOpacity: 0.5 }} content={<ChartTooltipContent />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar dataKey="found" fill="var(--color-found)" radius={[4, 4, 0, 0]} maxBarSize={14} />
              <Bar dataKey="fixed" fill="var(--color-fixed)" radius={[4, 4, 0, 0]} maxBarSize={14} />
            </BarChart>
          </ChartContainer>
        ) : (
          <div className="max-h-64 overflow-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Day</TableHead>
                  <TableHead className="text-right">Found</TableHead>
                  <TableHead className="text-right">Fixed</TableHead>
                  <TableHead className="text-right">Kane runs</TableHead>
                  <TableHead className="text-right">Credits</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...rows].reverse().map((r) => (
                  <TableRow key={r.day}>
                    <TableCell>{r.label}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.found}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.fixed}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.runs}</TableCell>
                    <TableCell className="text-right tabular-nums">{credits(r.credits)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default function Overview() {
  const { data: s } = useQuery<Summary>('summary')
  const busy = useBusy() || !!s?.busy
  const { data: runs } = useQuery<RunLite[]>('runs?limit=8')
  const { data: bugs } = useQuery<BugT[]>('bugs')
  const open = (bugs ?? []).filter((b) => ['candidate', 'confirmed', 'fixing', 'escalated'].includes(b.status)).slice(0, 5)

  const start = async (path: string, label: string) => {
    try {
      await post(path, path === 'guard' ? { all: true } : {})
      toast.success(label)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <Page>
      <PageHeader
        title={s?.app.name ?? 'Overview'}
        description={
          s ? (
            <>
              Gremlin is guarding <Code>{s.app.url}</Code> with {s.counts.flows.happy + s.counts.flows.adversarial + s.counts.flows.regression} flows. Every verdict comes from
              Kane CLI driving a real browser.
            </>
          ) : (
            'Loading…'
          )
        }
        actions={
          <>
            <Button variant="outline" onClick={() => start('guard', 'Guard is replaying every active flow')} disabled={busy}>
              <ShieldCheck /> Run Guard
            </Button>
            <Button onClick={() => start('break', 'Breaker hunt started')} disabled={busy}>
              <Swords /> Hunt for bugs
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {s ? (
          <>
            <Stat
              title="Bugs found"
              icon={Bug}
              value={s.counts.bugsFound}
              to="/bugs"
              hint={`${s.counts.byOrigin.breaker?.found ?? 0} by Breaker · ${s.counts.byOrigin.capture?.found ?? 0} from reports · ${s.counts.byOrigin.guard?.found ?? 0} by Guard`}
            />
            <Stat title="Fixed and proven" icon={Wrench} value={s.counts.bugsFixed} to="/bugs" hint={`${s.counts.open} open · ${s.counts.escalated} escalated to a human`} />
            <Stat title="Regressions caught" icon={ShieldCheck} value={s.counts.regressionsCaught} to="/runs" hint={`${s.counts.flaky} flaky runs · ${s.counts.quarantined} quarantined flows`} />
            <Stat
              title="Kane credits this week"
              icon={Coins}
              value={credits(s.credits.week)}
              hint={`${credits(s.credits.today)} today of ${s.credits.budget.per_day} · ${credits(s.credits.perBugFound)} per bug found`}
            />
          </>
        ) : (
          [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-32 rounded-xl" />)
        )}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        {s ? <FoundFixedChart data={s.timeline} /> : <Skeleton className="h-80 rounded-xl lg:col-span-2" />}
        <Card className="lg:row-span-2">
          <CardHeader>
            <CardTitle>Live loop</CardTitle>
            <CardDescription>Whatever Gremlin is doing, from the CLI, a hook, MCP or this page.</CardDescription>
          </CardHeader>
          <CardContent className="max-h-[42rem] overflow-auto">
            <LiveFeed />
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Recent runs</CardTitle>
            <CardAction>
              <Button variant="ghost" size="sm" asChild>
                <Link to="/runs">
                  All runs <ArrowRight />
                </Link>
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            {runs?.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Flow</TableHead>
                    <TableHead className="hidden sm:table-cell">Loop</TableHead>
                    <TableHead>Result</TableHead>
                    <TableHead className="hidden text-right md:table-cell">Time</TableHead>
                    <TableHead className="text-right">When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="max-w-0 w-full">
                        <Link to={`/runs/${r.id}`} className="block truncate font-medium hover:underline">
                          {r.flowTitle}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground hidden sm:table-cell">{purposeLabel[r.purpose] ?? r.purpose}</TableCell>
                      <TableCell>
                        <StatusBadge status={r.status} />
                      </TableCell>
                      <TableCell className="text-muted-foreground hidden text-right tabular-nums md:table-cell">{duration(r.kane?.durationS)}</TableCell>
                      <TableCell className="text-muted-foreground text-right whitespace-nowrap">{timeAgo(r.startedAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-muted-foreground py-6 text-center text-sm">No runs yet.</p>
            )}
          </CardContent>
        </Card>
      </div>

      {open.length > 0 && (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Needs attention</CardTitle>
            <CardDescription>Open bugs, worst first. Hand one to your coding agent and Kane will check the fix.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {open.map((b) => (
                <li key={b.id}>
                  <Link to={`/bugs/${b.id}`} className="hover:bg-muted/40 -mx-2 flex items-center gap-3 rounded-md px-2 py-3">
                    <StatusIcon status={b.status} />
                    <span className="text-muted-foreground w-16 shrink-0 font-mono text-xs">{b.id}</span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{b.title}</span>
                    <SeverityBadge severity={b.severity} />
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </Page>
  )
}
