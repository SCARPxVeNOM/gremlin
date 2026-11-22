// Fills dist-snapshot/ with a read-only copy of one session, read from a running `gremlin dash`, for a static host.
//   VITE_SNAPSHOT=1 npx vite build && node scripts/snapshot.mjs [--from http://127.0.0.1:4777]
// It keeps every page's data and Kane's evidence. It drops the Kane account name and credit balance, and strips this
// machine's paths.
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { values: a } = parseArgs({
  options: { from: { type: 'string', default: 'http://127.0.0.1:4777' }, out: { type: 'string', default: 'dist-snapshot' } },
})
const dir = join(a.out, 'snapshot')
mkdirSync(dir, { recursive: true })

const get = async (path) => {
  const res = await fetch(`${a.from}/api/${path}`)
  if (!res.ok) throw new Error(`${path}: ${res.status}`)
  return res.json()
}

const config = await get('config')
const root = config.root
const save = (path, data) =>
  writeFileSync(join(dir, `${path.replace(/[^\w.-]/g, '_')}.json`), JSON.stringify(data).replaceAll(`${root}/`, '').replaceAll(root, '.'))

save('config', { ...config, root: 'docs/demo-run', kane: { installed: config.kane.installed, version: config.kane.version, authenticated: config.kane.authenticated } })

const lists = { flows: await get('flows'), bugs: await get('bugs'), runs: await get('runs?limit=200') }
save('flows', lists.flows)
save('bugs', lists.bugs)
save('runs?limit=200', lists.runs)
for (const path of ['summary', 'runs?limit=8', 'report', 'catalog', 'events?limit=400']) save(path, await get(path))
for (const kind of ['flows', 'bugs', 'runs']) for (const { id } of lists[kind]) save(`${kind}/${id}`, await get(`${kind}/${id}`))

cpSync(join(root, '.gremlin', 'evidence'), join(dir, 'evidence'), { recursive: true })
// the story the snapshot opens on, kept next to the record it tells
if (existsSync(join(root, 'tour.json'))) cpSync(join(root, 'tour.json'), join(dir, 'tour.json'))
console.log(`${a.out}: ${lists.flows.length} flows, ${lists.bugs.length} bugs, ${lists.runs.length} runs, from ${root}`)
