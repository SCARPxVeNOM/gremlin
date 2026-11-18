import { Fragment } from 'react'
import { Copy, Download } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Page, PageHeader, Code } from '@/components/page'
import { useQuery } from '@/lib/live'

/** Inline markdown: **bold** and `code`. */
function inline(text: string) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
    part.startsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part.startsWith('`') ? <Code key={i}>{part.slice(1, -1)}</Code> : <Fragment key={i}>{part}</Fragment>,
  )
}

/** Just enough markdown for the weekly report: headings and bullet lists. */
function Markdown({ source }: { source: string }) {
  const blocks: React.ReactNode[] = []
  let list: string[] = []
  const flush = () => {
    if (list.length) {
      blocks.push(
        <ul key={blocks.length} className="my-4 ml-6 list-disc space-y-2 [&>li]:pl-1">
          {list.map((l, i) => (
            <li key={i}>{inline(l)}</li>
          ))}
        </ul>,
      )
      list = []
    }
  }
  for (const line of source.split('\n')) {
    if (line.startsWith('- ')) {
      list.push(line.slice(2))
      continue
    }
    flush()
    if (line.startsWith('# ')) blocks.push(<h1 key={blocks.length} className="mb-2 text-2xl font-semibold tracking-tight">{inline(line.slice(2))}</h1>)
    else if (line.startsWith('## ')) blocks.push(<h2 key={blocks.length} className="mt-8 border-b pb-2 text-lg font-semibold tracking-tight">{inline(line.slice(3))}</h2>)
    else if (line.trim()) blocks.push(<p key={blocks.length} className="leading-7">{inline(line)}</p>)
  }
  flush()
  return <div className="text-sm">{blocks}</div>
}

export default function Report() {
  const { data } = useQuery<{ markdown: string }>('report')

  const copy = async () => {
    await navigator.clipboard.writeText(data?.markdown ?? '')
    toast.success('Copied as Markdown')
  }
  const download = () => {
    const url = URL.createObjectURL(new Blob([data?.markdown ?? ''], { type: 'text/markdown' }))
    const a = Object.assign(document.createElement('a'), { href: url, download: `gremlin-weekly-${new Date().toISOString().slice(0, 10)}.md` })
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Page className="max-w-4xl">
      <PageHeader
        title="Weekly report"
        description={
          <>
            Paste it into Slack or your team's notes. Same as <Code>gremlin report</Code>.
          </>
        }
        actions={
          <>
            <Button variant="outline" onClick={download} disabled={!data}>
              <Download /> Download
            </Button>
            <Button onClick={copy} disabled={!data}>
              <Copy /> Copy Markdown
            </Button>
          </>
        }
      />
      <Card>
        <CardContent className="px-6 py-2 md:px-10 md:py-6">{data ? <Markdown source={data.markdown} /> : <Skeleton className="h-64" />}</CardContent>
      </Card>
    </Page>
  )
}
