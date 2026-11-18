import { Bot, CircleCheck, CircleX, Globe, Plug, ShieldCheck } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Page, PageHeader, Code } from '@/components/page'
import { useQuery } from '@/lib/live'
import type { ConfigView } from '@/lib/api'
import { credits } from '@/lib/format'

function Check({ ok, children, fix }: { ok: boolean; children: React.ReactNode; fix?: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3 py-2.5">
      {ok ? <CircleCheck className="text-good mt-0.5 size-4 shrink-0" /> : <CircleX className="text-muted-foreground mt-0.5 size-4 shrink-0" />}
      <div className="min-w-0 text-sm">
        <div>{children}</div>
        {!ok && fix && <div className="text-muted-foreground mt-1 text-xs">{fix}</div>}
      </div>
    </li>
  )
}

function stringify(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent)
  if (Array.isArray(value)) return value.length ? value.map((v) => `\n${pad}- ${typeof v === 'object' ? stringify(v, indent + 1).trimStart() : String(v)}`).join('') : ' []'
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => {
        const secret = /password|token|key/i.test(k) && typeof v === 'string'
        if (v && typeof v === 'object') return `\n${pad}${k}:${stringify(v, indent + 1)}`
        return `\n${pad}${k}: ${secret ? '••••••' : String(v)}`
      })
      .join('')
  }
  return ` ${String(value)}`
}

export default function Settings() {
  const { data: c } = useQuery<ConfigView>('config')
  if (!c) {
    return (
      <Page>
        <Skeleton className="mb-6 h-12 w-1/3" />
        <Skeleton className="h-96 rounded-xl" />
      </Page>
    )
  }
  return (
    <Page>
      <PageHeader
        title="Settings"
        description={
          <>
            Read from <Code>gremlin.config.yaml</Code> in <Code>{c.root}</Code>. Edit the file, or run <Code>gremlin doctor</Code>.
          </>
        }
      />
      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="size-4" /> Kane CLI
            </CardTitle>
            <CardDescription>The verifier. Every pass and fail in Gremlin is Kane's.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              <Check ok={c.kane.installed} fix={<Code>npm install -g @testmuai/kane-cli</Code>}>
                Installed {c.kane.version && <span className="text-muted-foreground">v{c.kane.version}</span>}
              </Check>
              <Check ok={c.kane.authenticated} fix={<Code>kane-cli login</Code>}>
                Signed in {c.kane.user && <span className="text-muted-foreground">as {c.kane.user}</span>}
              </Check>
              <Check ok={(c.kane.credits ?? 0) > 0}>
                Credits <span className="text-muted-foreground tabular-nums">{credits(c.kane.credits)}</span>
              </Check>
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bot className="size-4" /> Coding agent
            </CardTitle>
            <CardDescription>Fixes the bugs. Loop mode: {c.raw?.loop?.mode ?? 'approve'}, up to {c.raw?.loop?.attempts ?? 3} attempts.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              <Check ok={c.agent.available} fix={c.agent.detected.length ? `Detected on this machine: ${c.agent.detected.join(', ')}` : 'No coding agent CLI found on PATH.'}>
                {c.agent.label} <span className="text-muted-foreground">({c.agent.name})</span>
              </Check>
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Globe className="size-4" /> App under test
            </CardTitle>
            <CardDescription>Gremlin refuses production targets.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              <Check ok={c.appReachable} fix={c.raw?.app?.start ? <>Gremlin starts it with <Code>{c.raw.app.start}</Code> when a run needs it.</> : 'Start your app, or set app.start.'}>
                {c.raw?.app?.name} at <Code>{c.raw?.app?.url}</Code>
              </Check>
              <Check ok={Boolean(c.raw?.app?.reset)}>Data reset between runs {c.raw?.app?.reset && <Code>{c.raw.app.reset}</Code>}</Check>
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Plug className="size-4" /> Integrations
            </CardTitle>
            <CardDescription>How the loop reaches your agent and your PRs.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              <Check ok={c.integrations.claudeHooks} fix={<Code>gremlin install claude</Code>}>
                Claude Code hooks: Kane checks the agent's work before it can say “done”
              </Check>
              <Check ok={c.integrations.mcp} fix={<Code>gremlin install cursor</Code>}>
                MCP server: any agent can call Gremlin's tools
              </Check>
              <Check ok={c.integrations.rules} fix={<Code>gremlin install codex</Code>}>
                Agent rules (CLAUDE.md / AGENTS.md)
              </Check>
              <Check ok={c.integrations.ci} fix={<Code>gremlin install ci</Code>}>
                GitHub Action: Guard on every pull request
              </Check>
            </ul>
          </CardContent>
        </Card>
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>Configuration</CardTitle>
            <CardDescription>Secrets are masked.</CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="bg-muted/40 max-h-[32rem] overflow-auto rounded-lg border p-4 font-mono text-xs leading-relaxed">{stringify(c.raw).trimStart()}</pre>
          </CardContent>
        </Card>
      </div>
    </Page>
  )
}
