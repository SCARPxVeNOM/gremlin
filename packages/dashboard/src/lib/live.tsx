import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { api, SNAPSHOT, type GEvent } from './api'

interface LiveState {
  events: GEvent[]
  /** Bumps whenever something happened that may change server state. */
  version: number
  connected: boolean
}

const LiveContext = createContext<LiveState>({ events: [], version: 0, connected: false })

/** Follows .gremlin/events.jsonl through server-sent events: CLI runs, hooks and MCP calls all show up live. */
export function LiveProvider({ children }: { children: ReactNode }) {
  const [events, setEvents] = useState<GEvent[]>([])
  const [version, setVersion] = useState(0)
  const [connected, setConnected] = useState(false)
  const bump = useRef<number | undefined>(undefined)

  useEffect(() => {
    let es: EventSource | undefined
    let stopped = false
    api<GEvent[]>('events?limit=400')
      .then(setEvents)
      .catch(() => {})
    if (SNAPSHOT) return
    const connect = () => {
      if (stopped) return
      es = new EventSource('/api/stream')
      es.onopen = () => setConnected(true)
      es.onerror = () => {
        setConnected(false)
        es?.close()
        setTimeout(connect, 2000)
      }
      es.onmessage = (m) => {
        try {
          const e = JSON.parse(m.data) as GEvent
          setEvents((prev) => [...prev.slice(-599), e])
          if (e.kind !== 'kane-action') {
            window.clearTimeout(bump.current)
            bump.current = window.setTimeout(() => setVersion((v) => v + 1), 400)
          }
        } catch {
          /* ignore malformed lines */
        }
      }
    }
    connect()
    return () => {
      stopped = true
      es?.close()
    }
  }, [])

  return <LiveContext.Provider value={{ events, version, connected }}>{children}</LiveContext.Provider>
}

export const useLive = () => useContext(LiveContext)

/** Fetch an API path, refetching whenever live events arrive. */
export function useQuery<T>(path: string | null) {
  const { version } = useLive()
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)
  const refetch = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    if (!path) return
    let cancelled = false
    api<T>(path)
      .then((d) => {
        if (!cancelled) {
          setData(d)
          setError(undefined)
        }
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [path, version, nonce])

  return { data, error, loading: loading && !data, refetch }
}

/** Events of the most recent job (or a given job), for live progress panels. */
export function useJobEvents(filter?: (e: GEvent) => boolean) {
  const { events } = useLive()
  const relevant = filter ? events.filter(filter) : events
  const lastStart = [...relevant].reverse().find((e) => e.kind === 'job-start')
  if (!lastStart?.job) return { job: undefined, events: [] as GEvent[], running: false, end: undefined }
  const jobEvents = events.filter((e) => e.job === lastStart.job)
  const end = jobEvents.find((e) => e.kind === 'job-end')
  // A process killed mid-job never writes job-end; treat a long-silent job as finished.
  const lastTs = new Date(jobEvents.at(-1)?.ts ?? lastStart.ts).getTime()
  const running = !end && Date.now() - lastTs < STALE_MS
  return { job: lastStart, events: jobEvents, running, end }
}

const STALE_MS = 15 * 60_000

/** True while any Gremlin job is running, whether started here, from the CLI, a hook or MCP. */
export function useBusy() {
  return useJobEvents().running
}
