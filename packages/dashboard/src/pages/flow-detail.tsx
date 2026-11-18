import { Link, useParams } from 'react-router-dom'
import { Archive, Check, Lock, Play, ShieldAlert } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Page, PageHeader, Code } from '@/components/page'
import { FlowDoc } from '@/components/flow-doc'
import { Stability, StatusBadge, TypeBadge } from '@/components/status'
import { useQuery } from '@/lib/live'
import type { FlowView, RunLite } from '@/lib/api'
import { credits, duration, purposeLabel, timeAgo } from '@/lib/format'
import { flowAction } from './flows'
import NotFound from './not-found'

interface FlowDetailData {
  flow: FlowView
  markdown: string
  kane: string
  runs: RunLite[]
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate">{children}</dd>
    </>
  )
}

export default function FlowDetail() {
  const { type, slug } = useParams()
  const id = `${type}/${slug}`
  const { data, error, refetch } = useQuery<FlowDetailData>(`flows/${id}`)

  if (error) return <NotFound what="flow" />
  if (!data) {
    return (
      <Page>
        <Skeleton className="mb-6 h-12 w-2/3" />
        <Skeleton className="h-96 rounded-xl" />
      </Page>
    )
  }
  const { flow, runs } = data
  const lastFailed = runs.find((r) => r.status === 'failed')
  const failingIndex = lastFailed?.kane?.steps.findIndex((s) => s.status === 'failed')

  return (
    <Page>
      <PageHeader
        title={flow.title}
        actions={
          <>
            {flow.status !== 'retired' && (
              <Button variant="ghost" onClick={() => flowAction(flow.id, 'retire', refetch)}>
                <Archive /> Retire
              </Button>
            )}
            {(flow.status !== 'active' || flow.tampered) && flow.status !== 'retired' && (
              <Button variant="outline" onClick={() => flowAction(flow.id, 'approve', refetch)}>
                <Check /> Approve and lock
              </Button>
            )}
            <Button onClick={() => flowAction(flow.id, 'run', refetch)}>
              <Play /> Run with Kane
            </Button>
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <TypeBadge type={flow.type} />
          <StatusBadge status={flow.tampered ? 'tampered' : flow.status} />
          {flow.locked && (
            <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
              <Lock className="size-3" /> locked
            </span>
          )}
          {flow.tags.map((t) => (
            <span key={t} className="text-muted-foreground text-xs">
              #{t}
            </span>
          ))}
        </div>
      </PageHeader>

      {flow.tampered && (
        <Alert variant="destructive" className="mb-6">
          <ShieldAlert />
          <AlertTitle>This flow changed since a human approved it</AlertTitle>
          <AlertDescription>Guard blocks on edited flows, so an agent can't make a check pass by rewriting it. Review the change, then approve it again or revert the file.</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Tabs defaultValue="flow">
          <TabsList>
            <TabsTrigger value="flow">Flow</TabsTrigger>
            <TabsTrigger value="kane">Kane test</TabsTrigger>
            <TabsTrigger value="source">Source</TabsTrigger>
            <TabsTrigger value="runs">
              Runs <span className="text-muted-foreground ml-1 tabular-nums">{runs.length}</span>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="flow" className="pt-2">
            <Card>
              <CardContent>
                <FlowDoc flow={flow} failingIndex={failingIndex !== undefined && failingIndex >= 0 ? failingIndex + 1 : undefined} />
                {flow.notes && <p className="text-muted-foreground mt-5 border-t pt-4 text-sm whitespace-pre-wrap">{flow.notes}</p>}
              </CardContent>
            </Card>
          </TabsContent>
          <TabsContent value="kane" className="pt-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-normal">
                  What Gremlin hands to <Code>kane-cli testmd run</Code>. Persona logins are passed as variables, never written to disk.
                </CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="bg-muted/40 overflow-auto rounded-lg border p-4 font-mono text-xs leading-relaxed">{data.kane}</pre>
              </CardContent>
            </Card>
          </TabsContent>
          <TabsContent value="source" className="pt-2">
            <Card>
              <CardHeader>
                <CardTitle className="font-mono text-sm font-normal">{flow.file}</CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="bg-muted/40 overflow-auto rounded-lg border p-4 font-mono text-xs leading-relaxed">{data.markdown}</pre>
              </CardContent>
            </Card>
          </TabsContent>
          <TabsContent value="runs" className="pt-2">
            <div className="overflow-hidden rounded-xl border">
              <Table>
                <TableHeader className="bg-muted/40">
                  <TableRow>
                    <TableHead>Result</TableHead>
                    <TableHead>Loop</TableHead>
                    <TableHead className="hidden sm:table-cell">Steps</TableHead>
                    <TableHead className="text-right">Time</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">Credits</TableHead>
                    <TableHead className="text-right">When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>
                        <Link to={`/runs/${r.id}`}>
                          <StatusBadge status={r.status} />
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{purposeLabel[r.purpose] ?? r.purpose}</TableCell>
                      <TableCell className="text-muted-foreground hidden text-xs sm:table-cell">
                        {r.kane ? `${r.kane.replayed} replayed · ${r.kane.authored} authored` : '–'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{duration(r.kane?.durationS)}</TableCell>
                      <TableCell className="hidden text-right tabular-nums sm:table-cell">{credits(r.credits)}</TableCell>
                      <TableCell className="text-muted-foreground text-right whitespace-nowrap">{timeAgo(r.startedAt)}</TableCell>
                    </TableRow>
                  ))}
                  {!runs.length && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-muted-foreground py-8 text-center">
                        Never run.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </TabsContent>
        </Tabs>

        <Card className="h-fit lg:mt-11">
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-2.5 text-sm">
              <Meta label="Stability">
                <Stability value={flow.stability} />
              </Meta>
              <Meta label="Last run">{flow.last ? <StatusBadge status={flow.last} /> : '–'}</Meta>
              <Meta label="Source">{flow.source}</Meta>
              {flow.attack && <Meta label="Attack">{flow.attack}</Meta>}
              {flow.bug && (
                <Meta label="Bug">
                  <Link to={`/bugs/${flow.bug}`} className="font-mono hover:underline">
                    {flow.bug}
                  </Link>
                </Meta>
              )}
              {flow.fail_first && <Meta label="Failed first">{timeAgo(flow.fail_first)}</Meta>}
              <Meta label="Platforms">{flow.platforms.join(', ')}</Meta>
              {flow.created && <Meta label="Created">{timeAgo(flow.created)}</Meta>}
              <Meta label="Hash">
                <span className="font-mono text-xs">{flow.hash.slice(0, 12)}</span>
              </Meta>
            </dl>
          </CardContent>
        </Card>
      </div>
    </Page>
  )
}
