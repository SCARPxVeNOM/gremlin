import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Logo } from '@/components/logo'
import { Page } from '@/components/page'

export default function NotFound({ what = 'page' }: { what?: string }) {
  return (
    <Page className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
      <Logo className="text-muted-foreground size-12" />
      <h1 className="text-2xl font-semibold tracking-tight">No such {what}</h1>
      <p className="text-muted-foreground max-w-sm text-sm">It may have been retired, or the link is from another project.</p>
      <Button variant="outline" asChild>
        <Link to="/">Back to overview</Link>
      </Button>
    </Page>
  )
}
