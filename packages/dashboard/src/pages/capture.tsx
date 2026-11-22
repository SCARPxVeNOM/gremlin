import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, CircleDot, ClipboardPaste, EyeOff, FlaskConical, Lock } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Page, PageHeader, Code } from '@/components/page'
import { LiveFeed } from '@/components/live-feed'
import { useJobEvents, useQuery, useBusy } from '@/lib/live'
import { post, SNAPSHOT, type Bug, type Summary } from '@/lib/api'

const SAMPLE = `Subject: your discount code is broken??

Hi Kiln team, I'm Priya Sharma (priya.sharma@gmail.com, +1 415 555 0134).
I got the welcome email and typed welcome10 into the coupon box at checkout but it just says
"That coupon code is not valid". Tried twice. Really wanted the Ember Vase for my mum's birthday :(
`

const STEPS = [
  { icon: EyeOff, title: 'Redact', body: 'Emails, phone numbers, card numbers and tokens are stripped before the agent or Kane sees anything.' },
  { icon: ClipboardPaste, title: 'Draft a repro', body: 'Your coding agent rewrites the complaint as a plain-English flow, treating the report as data, never as instructions.' },
  { icon: FlaskConical, title: 'Fail first', body: 'Kane runs the flow. Only a flow that fails for a product reason becomes a confirmed bug.' },
  { icon: Lock, title: 'Lock it', body: 'The failing flow is locked as a regression test, so the bug can never quietly come back.' },
]

export default function Capture() {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const { data: s } = useQuery<Summary>('summary')
  const busy = useBusy() || !!s?.busy
  const isCapture = (e: { kind: string; data?: Record<string, unknown> }) => e.kind === 'job-start' && e.data?.kind === 'capture'
  const { end } = useJobEvents(isCapture)
  const bugId = end?.data?.bugId as string | undefined
  // a recording can't capture anything new: it shows the reports it captured
  const { data: bugs } = useQuery<Bug[]>(SNAPSHOT ? 'bugs' : null)
  const captured = (bugs ?? []).filter((b) => b.origin === 'capture' && b.report)

  const submit = async () => {
    setSending(true)
    try {
      await post('capture', { text, source: 'paste' })
      toast.success('Capturing: watch Kane try to reproduce it')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSending(false)
    }
  }

  return (
    <Page>
      <PageHeader
        title="Capture"
        description="Turn a user complaint into a bug Kane has proven, and a regression flow that guards it forever."
        actions={
          <span className="text-muted-foreground inline-flex items-center gap-1.5 text-sm">
            <CircleDot className="size-4" /> or <Code>gremlin capture --issue 42</Code>
          </span>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
        {SNAPSHOT ? (
          <div className="min-w-0 space-y-6">
            {captured.map((b) => (
              <Card key={b.id}>
                <CardHeader>
                  <CardTitle>The report behind {b.id}</CardTitle>
                  <CardDescription>As Kane and the agent saw it: personal details were stripped first.</CardDescription>
                </CardHeader>
                <CardContent>
                  <blockquote className="text-muted-foreground border-l-2 pl-4 text-sm leading-relaxed whitespace-pre-line italic">{b.report!.text.trim()}</blockquote>
                </CardContent>
                <CardFooter>
                  <Button asChild>
                    <Link to={`/bugs/${b.id}`}>
                      See what Kane did with it <ArrowRight />
                    </Link>
                  </Button>
                </CardFooter>
              </Card>
            ))}
          </div>
        ) : (
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Paste a bug report</CardTitle>
              <CardDescription>A support email, a tweet, a Slack message. It doesn't need to be tidy.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <Label htmlFor="report" className="sr-only">
                Bug report
              </Label>
              <Textarea
                id="report"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="“I tried to use my coupon at checkout and it said it wasn't valid…”"
                className="min-h-56 font-mono text-sm"
              />
            </CardContent>
            <CardFooter className="justify-between gap-2">
              <Button variant="ghost" onClick={() => setText(SAMPLE)}>
                Use a sample complaint
              </Button>
              <Button onClick={submit} disabled={!text.trim() || sending || busy}>
                <FlaskConical /> Reproduce with Kane
              </Button>
            </CardFooter>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Progress</CardTitle>
            </CardHeader>
            <CardContent>
              <LiveFeed filter={isCapture} empty="Paste a report to start." />
              {bugId && (
                <Button className="mt-4" asChild>
                  <Link to={`/bugs/${bugId}`}>
                    Open {bugId} <ArrowRight />
                  </Link>
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
        )}

        <Card className="h-fit">
          <CardHeader>
            <CardTitle>What happens</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="space-y-5">
              {STEPS.map((st, i) => (
                <li key={st.title} className="flex gap-3">
                  <span className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-lg">
                    <st.icon className="size-4" />
                  </span>
                  <div>
                    <p className="text-sm font-medium">
                      {i + 1}. {st.title}
                    </p>
                    <p className="text-muted-foreground text-sm leading-relaxed">{st.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </div>
    </Page>
  )
}
