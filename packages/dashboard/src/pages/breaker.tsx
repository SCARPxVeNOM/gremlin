import { useMemo, useState } from 'react'
import { Bot, Swords } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Page, PageHeader } from '@/components/page'
import { LiveFeed } from '@/components/live-feed'
import { useQuery, useBusy } from '@/lib/live'
import { post, type CatalogEntry, type ConfigView, type Summary } from '@/lib/api'

/** Same estimate the Breaker uses to rank attacks: the prior, updated by what this product has shown so far. */
const learned = (a: CatalogEntry) => (a.found + a.prior * 2) / (a.tried + 2)

export default function Breaker() {
  const { data: catalog } = useQuery<CatalogEntry[]>('catalog')
  const { data: s } = useQuery<Summary>('summary')
  const busy = useBusy() || !!s?.busy
  const { data: config } = useQuery<ConfigView>('config')
  const categories = useMemo(() => {
    const m = new Map<string, string>()
    for (const a of catalog ?? []) m.set(a.category, a.categoryLabel)
    return [...m.entries()]
  }, [catalog])
  const [picked, setPicked] = useState<string[] | null>(null)
  const selected = picked ?? categories.map(([c]) => c)
  const [max, setMax] = useState(6)
  const [useAgent, setUseAgent] = useState(true)

  const start = async () => {
    try {
      await post('break', { categories: selected, max, useAgent })
      toast.success('Breaker hunt started')
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <Page>
      <PageHeader
        title="Breaker"
        description="Sends Kane to do what real users do: paste emoji, double-click Pay, hit Back mid-checkout. Only failures Kane judges to be product bugs are filed."
      />
      <div className="grid gap-6 lg:grid-cols-[22rem_minmax(0,1fr)]">
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>New hunt</CardTitle>
            <CardDescription>Spend is capped at {s?.credits.budget.per_run ?? '–'} credits per hunt.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <fieldset className="space-y-3">
              <legend className="mb-2 text-sm font-medium">Kinds of chaos</legend>
              {categories.length ? (
                categories.map(([c, label]) => (
                  <div key={c} className="flex items-center gap-2.5">
                    <Checkbox
                      id={`cat-${c}`}
                      checked={selected.includes(c)}
                      onCheckedChange={(v) => setPicked(v ? [...selected, c] : selected.filter((x) => x !== c))}
                    />
                    <Label htmlFor={`cat-${c}`} className="font-normal">
                      {label}
                    </Label>
                  </div>
                ))
              ) : (
                <Skeleton className="h-32" />
              )}
            </fieldset>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>Attacks</Label>
                <span className="text-muted-foreground text-sm tabular-nums">up to {max}</span>
              </div>
              <Slider value={[max]} min={1} max={16} step={1} onValueChange={([v]) => setMax(v)} aria-label="Maximum attacks" />
            </div>
            <div className="flex items-start gap-2.5">
              <Checkbox id="agent" checked={useAgent} onCheckedChange={(v) => setUseAgent(Boolean(v))} disabled={!config?.agent.available} />
              <div className="grid gap-1">
                <Label htmlFor="agent" className="font-normal">
                  <Bot className="size-4" /> Ask {config?.agent.label ?? 'the coding agent'} for attacks
                </Label>
                <p className="text-muted-foreground text-xs">It reads your code and suggests attacks specific to this product, each citing the file that made it suspicious.</p>
              </div>
            </div>
          </CardContent>
          <CardFooter>
            <Button className="w-full" onClick={start} disabled={!selected.length || busy}>
              <Swords /> Start hunting
            </Button>
          </CardFooter>
        </Card>

        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Hunt</CardTitle>
            </CardHeader>
            <CardContent>
              <LiveFeed filter={(e) => e.kind === 'job-start' && e.data?.kind === 'break'} empty="No hunts yet." limit={80} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Attack catalog</CardTitle>
              <CardDescription>Gremlin learns which attacks find bugs in this product and tries those first.</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Attack</TableHead>
                    <TableHead className="hidden xl:table-cell">Kind</TableHead>
                    <TableHead className="text-right">Tried</TableHead>
                    <TableHead className="text-right">Found</TableHead>
                    <TableHead className="text-right">Hit rate</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...(catalog ?? [])]
                    .sort((a, b) => learned(b) - learned(a))
                    .map((a) => (
                      <TableRow key={a.id}>
                        <TableCell>
                          <span className="font-medium">{a.name}</span>
                          <span className="text-muted-foreground block font-mono text-xs">{a.id}</span>
                        </TableCell>
                        <TableCell className="text-muted-foreground hidden xl:table-cell">{a.categoryLabel}</TableCell>
                        <TableCell className="text-right tabular-nums">{a.tried}</TableCell>
                        <TableCell className="text-right tabular-nums">{a.found}</TableCell>
                        <TableCell className="text-right">
                          <span className="inline-flex items-center gap-2 text-xs tabular-nums">
                            <span className="bg-muted relative h-1.5 w-14 overflow-hidden rounded-full">
                              <span className="bg-foreground/70 absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.round(learned(a) * 100)}%` }} />
                            </span>
                            {Math.round(learned(a) * 100)}%
                          </span>
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      </div>
    </Page>
  )
}
