import { Link } from 'react-router-dom'
import { ArrowUpRight, Bug as BugIcon, Gauge, History, Route as RouteIcon, Swords, type LucideIcon } from 'lucide-react'
import { Page } from '@/components/page'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useQuery } from '@/lib/live'
import { evidenceUrl, type Bug, type FlowView, type RunLite } from '@/lib/api'
import { cn } from '@/lib/utils'

/** The story of a recorded session, written next to its record (docs/demo-run/tour.json) and shown first in the snapshot. */
interface Tour {
  title: string
  lede: string
  summary: string
  stops: Stop[]
  ending: string
  links: { label: string; href: string }[]
}

interface Stop {
  /** When this part of the session began: every run from here to the next stop belongs to it. */
  at: string
  title: string
  body: string
  verdict: 'pass' | 'fail'
  links: { label: string; to: string }[]
  /** One of Kane's screenshots, cropped to what matters: [x, y, width, height] as fractions of the image. */
  shot?: { run: string; file: string; crop: [number, number, number, number]; alt: string; caption: string }
}

const RUN_COLOR: Record<string, string> = {
  passed: 'bg-good',
  failed: 'bg-critical',
  flaky: 'bg-warning',
}

const utcTime = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })

/** Every Kane run of the session as one bar each, grouped by the stops of the story. */
function Strip({ runs, stops }: { runs: RunLite[]; stops: Stop[] }) {
  const sorted = [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  const groups = stops.map((stop, i) => {
    const end = stops[i + 1]?.at
    return sorted.filter((r) => r.startedAt >= stop.at && (!end || r.startedAt < end))
  })
  return (
    <div>
      <ol className="flex items-end gap-2" aria-label="Every Kane run in the session, in order, grouped by the steps below">
        {groups.map((group, i) => (
          <li key={stops[i].at} className="flex min-w-6 flex-col gap-2" style={{ flex: `${Math.max(group.length, 1)} 1 0` }}>
            <div className="flex h-14 items-stretch gap-[2px]">
              {group.map((r) => (
                <Tooltip key={r.id}>
                  <TooltipTrigger asChild>
                    <Link
                      to={`/runs/${r.id}`}
                      aria-label={`${r.flowTitle}: ${r.status === 'running' ? 'stopped' : r.status}`}
                      className={cn(
                        'focus-visible:ring-ring max-w-3 min-w-[2px] flex-1 rounded-[2px] md:max-w-none transition-opacity hover:opacity-70 focus-visible:ring-2 focus-visible:outline-none',
                        RUN_COLOR[r.status] ?? 'bg-muted-foreground/30',
                      )}
                    />
                  </TooltipTrigger>
                  <TooltipContent>
                    {r.flowTitle}
                    <span className="block opacity-70">{r.status === 'running' ? 'Stopped' : r.status === 'passed' ? 'Passed' : r.status === 'failed' ? 'Failed' : r.status}</span>
                  </TooltipContent>
                </Tooltip>
              ))}
            </div>
            {/* the router owns the hash, so the step is scrolled to rather than linked */}
            <button
              type="button"
              onClick={() => document.getElementById(`stop-${i + 1}`)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit rounded text-left text-xs tabular-nums focus-visible:ring-2 focus-visible:outline-none"
              aria-label={`Step ${i + 1}: ${stops[i].title}`}
            >
              {i + 1}
            </button>
          </li>
        ))}
      </ol>
      <p className="text-muted-foreground mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span>One bar per Kane run, in order.</span>
        <span className="inline-flex items-center gap-1.5">
          <span className="bg-good size-2 rounded-[2px]" /> Passed
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="bg-critical size-2 rounded-[2px]" /> Failed
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="bg-muted-foreground/30 size-2 rounded-[2px]" /> Stopped before it finished
        </span>
      </p>
    </div>
  )
}

/** A Kane screenshot cropped with CSS, so the evidence stays the original file. */
function Shot({ shot }: { shot: NonNullable<Stop['shot']> }) {
  const [x, y, w, h] = shot.crop
  return (
    <figure className="min-w-0">
      <Link
        to={`/runs/${shot.run}`}
        className="bg-muted focus-visible:ring-ring relative block overflow-hidden rounded-lg border focus-visible:ring-2 focus-visible:outline-none"
        style={{ aspectRatio: `${w * 1024} / ${h * 576}` }}
      >
        <img
          src={evidenceUrl(shot.run, shot.file)}
          alt={shot.alt}
          loading="lazy"
          className="absolute max-w-none"
          style={{ width: `${100 / w}%`, left: `${(-x / w) * 100}%`, top: `${(-y / h) * 100}%` }}
        />
      </Link>
      <figcaption className="text-muted-foreground mt-2 text-xs leading-relaxed">{shot.caption}</figcaption>
    </figure>
  )
}

function Explore({ to, icon: Icon, title, count, children }: { to: string; icon: LucideIcon; title: string; count?: number; children: React.ReactNode }) {
  return (
    <li>
      <Link to={to} className="hover:bg-muted/50 focus-visible:ring-ring -mx-3 flex gap-4 rounded-lg px-3 py-4 focus-visible:ring-2 focus-visible:outline-none">
        <Icon className="text-muted-foreground mt-0.5 size-5 shrink-0" />
        <div className="min-w-0">
          <p className="font-medium">
            {title}
            {count !== undefined && <span className="text-muted-foreground ml-2 font-normal tabular-nums">{count}</span>}
          </p>
          <p className="text-muted-foreground text-sm leading-relaxed">{children}</p>
        </div>
      </Link>
    </li>
  )
}

export default function TourPage() {
  const { data: tour, error } = useQuery<Tour>('tour')
  const { data: runs } = useQuery<RunLite[]>('runs?limit=200')
  const { data: bugs } = useQuery<Bug[]>('bugs')
  const { data: flows } = useQuery<FlowView[]>('flows')

  if (error) {
    return (
      <Page>
        <p className="text-muted-foreground">This recording has no guided tour. Start from the Overview.</p>
      </Page>
    )
  }
  if (!tour) {
    return (
      <Page className="max-w-5xl">
        <Skeleton className="mb-4 h-10 w-2/3" />
        <Skeleton className="mb-10 h-24 w-full" />
        <Skeleton className="h-96 w-full" />
      </Page>
    )
  }

  return (
    <Page className="max-w-5xl">
      <header className="max-w-3xl">
        <h1 className="text-3xl leading-tight font-semibold tracking-tight text-balance md:text-4xl">{tour.title}</h1>
        <p className="text-muted-foreground mt-4 text-base leading-relaxed md:text-lg">{tour.lede}</p>
      </header>

      <section className="mt-10" aria-labelledby="strip-heading">
        <h2 id="strip-heading" className="sr-only">
          Every Kane run
        </h2>
        {runs ? <Strip runs={runs} stops={tour.stops} /> : <Skeleton className="h-20 w-full" />}
        <p className="mt-4 max-w-3xl text-sm leading-relaxed">{tour.summary}</p>
      </section>

      <section className="mt-14" aria-labelledby="story-heading">
        <h2 id="story-heading" className="text-xl font-semibold tracking-tight">
          What happened, in order
        </h2>
        <ol className="mt-8">
          {tour.stops.map((stop, i) => (
            <li
              key={stop.at}
              id={`stop-${i + 1}`}
              className={cn('relative grid scroll-mt-20 gap-5 pl-11 lg:grid-cols-[minmax(0,1fr)_23rem] lg:gap-10', i < tour.stops.length - 1 && 'pb-12')}
            >
              {i < tour.stops.length - 1 && <span aria-hidden className="bg-border absolute top-8 bottom-0 left-[13px] w-px" />}
              <span
                aria-hidden
                className={cn(
                  'bg-background absolute top-0 left-0 flex size-7 items-center justify-center rounded-full border-2 text-xs font-semibold tabular-nums',
                  stop.verdict === 'pass' ? 'border-good text-good' : 'border-critical text-critical',
                )}
              >
                {i + 1}
              </span>
              <div className="min-w-0">
                <p className="text-muted-foreground text-sm tabular-nums">
                  {utcTime(stop.at)} UTC
                  <span className="sr-only">. Kane's verdict: {stop.verdict === 'pass' ? 'passed' : 'failed'}.</span>
                </p>
                <h3 className="mt-1 text-lg leading-snug font-semibold tracking-tight">{stop.title}</h3>
                <p className="text-muted-foreground mt-2 max-w-[62ch] leading-relaxed">{stop.body}</p>
                <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm">
                  {stop.links.map((l) => (
                    <li key={l.to}>
                      <Link to={l.to} className="decoration-muted-foreground/50 hover:decoration-foreground font-medium underline underline-offset-4">
                        {l.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
              {stop.shot && <Shot shot={stop.shot} />}
            </li>
          ))}
        </ol>
        <p className="mt-12 max-w-3xl leading-relaxed">{tour.ending}</p>
      </section>

      <section className="mt-14 grid gap-10 border-t pt-10 md:grid-cols-[minmax(0,1fr)_16rem]" aria-labelledby="explore-heading">
        <div>
          <h2 id="explore-heading" className="text-xl font-semibold tracking-tight">
            Explore the record
          </h2>
          <ul className="mt-4 grid gap-x-8 sm:grid-cols-2">
            <Explore to="/bugs" icon={BugIcon} title="Bugs" count={bugs?.length}>
              What Kane saw for each one, its triage, the fix attempts and the test that now guards it.
            </Explore>
            <Explore to="/runs" icon={History} title="Kane runs" count={runs?.length}>
              Every run, step by step, with Kane's screenshots and the browser console.
            </Explore>
            <Explore to="/flows" icon={RouteIcon} title="Flows" count={flows?.length}>
              The tests in plain English, and which ones are locked so no agent can edit them.
            </Explore>
            <Explore to="/breaker" icon={Swords} title="Breaker">
              The attacks Gremlin tried on the shop, and how often each kind found a bug.
            </Explore>
            <Explore to="/overview" icon={Gauge} title="Overview">
              The dashboard as Gremlin's users see it: totals, recent runs and open bugs.
            </Explore>
          </ul>
        </div>
        <div>
          <h2 className="text-muted-foreground text-sm font-medium">Outside this page</h2>
          <ul className="mt-4 space-y-3 text-sm">
            {tour.links.map((l) => (
              <li key={l.href}>
                <a href={l.href} target="_blank" rel="noreferrer" className="group inline-flex items-center gap-1 font-medium">
                  <span className="decoration-muted-foreground/50 group-hover:decoration-foreground underline underline-offset-4">{l.label}</span>
                  <ArrowUpRight className="text-muted-foreground size-3.5" aria-hidden />
                </a>
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground mt-6 text-xs leading-relaxed">
            Read-only: the buttons that start Kane are hidden. To run it on your own app, <code className="font-mono">npm i -g gremlin-qa</code>.
          </p>
        </div>
      </section>
    </Page>
  )
}
