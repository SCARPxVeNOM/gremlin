import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface FieldInfo {
  label: string;
  type: string;
  required: boolean;
}

export interface FormInfo {
  fields: FieldInfo[];
  submit?: string;
  action?: string;
  method?: string;
}

export interface PageInfo {
  path: string;
  title?: string;
  heading?: string;
  links: string[];
  buttons: string[];
  forms: FormInfo[];
}

export type JourneyKey = 'signup' | 'login' | 'search' | 'cart' | 'checkout' | 'settings' | 'contact' | 'form' | 'browse';

export interface Journey {
  key: JourneyKey;
  name: string;
  start: string;
  fields: FieldInfo[];
  submit?: string;
  buttons: string[];
}

export interface ProductMap {
  stack: string[];
  platforms: string[];
  routes: string[];
  pages: PageInfo[];
  journeys: Journey[];
  readme?: string;
}

// ---------------------------------------------------------------------------
// Stack

export function detectStack(root: string): { stack: string[]; platforms: string[]; startCommand?: string; port?: number } {
  const stack: string[] = [];
  const platforms = new Set<string>(['web']);
  let startCommand: string | undefined;
  let port: number | undefined;
  const pkgPath = join(root, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const known: [string, string][] = [
        ['next', 'Next.js'],
        ['nuxt', 'Nuxt'],
        ['@remix-run/react', 'Remix'],
        ['astro', 'Astro'],
        ['@sveltejs/kit', 'SvelteKit'],
        ['vite', 'Vite'],
        ['react', 'React'],
        ['vue', 'Vue'],
        ['svelte', 'Svelte'],
        ['@angular/core', 'Angular'],
        ['express', 'Express'],
        ['fastify', 'Fastify'],
        ['hono', 'Hono'],
        ['expo', 'Expo'],
        ['react-native', 'React Native'],
        ['wagmi', 'wagmi'],
        ['ethers', 'ethers'],
        ['viem', 'viem'],
        ['@solana/web3.js', 'Solana'],
      ];
      for (const [dep, name] of known) if (deps[dep]) stack.push(name);
      if (!stack.length) stack.push('Node.js');
      if (deps.expo || deps['react-native']) {
        platforms.add('ios');
        platforms.add('android');
      }
      const scripts = pkg.scripts ?? {};
      if (scripts.dev) startCommand = 'npm run dev';
      else if (scripts.start) startCommand = 'npm start';
      port = deps.next ? 3000 : deps.vite ? 5173 : deps.astro ? 4321 : (portFromSource(root, pkg) ?? 3000);
      const m = /(?:--port|-p|PORT=)\s*(\d{2,5})/.exec(`${scripts.dev ?? ''} ${scripts.start ?? ''}`);
      if (m) port = Number(m[1]);
    } catch {}
  }
  if (existsSync(join(root, 'requirements.txt')) || existsSync(join(root, 'pyproject.toml'))) stack.push('Python');
  if (existsSync(join(root, 'Gemfile'))) stack.push('Ruby');
  if (existsSync(join(root, 'go.mod'))) stack.push('Go');
  if (existsSync(join(root, 'ios'))) platforms.add('ios');
  if (existsSync(join(root, 'android'))) platforms.add('android');
  return { stack, platforms: [...platforms], startCommand, port };
}

/** For hand-rolled servers: read the port from the entry file (`PORT ?? 4000`, `.listen(8080)`). */
function portFromSource(root: string, pkg: { main?: string; scripts?: Record<string, string> }): number | undefined {
  const fromScripts = Object.values(pkg.scripts ?? {})
    .map((cmd) => /\b(?:node|tsx|ts-node|bun)\s+(?:--\S+\s+)*([\w./-]+\.[cm]?[jt]s)\b/.exec(cmd)?.[1])
    .filter((f): f is string => Boolean(f));
  const candidates = [...fromScripts, pkg.main, 'server.js', 'index.js', 'app.js', 'src/server.ts', 'src/index.ts', 'src/server.js', 'src/index.js'];
  for (const file of candidates) {
    if (!file || !existsSync(join(root, file))) continue;
    const text = readFileSync(join(root, file), 'utf8');
    const m = /PORT\s*\)?\s*(?:\?\?|\|\|)\s*['"]?(\d{2,5})/.exec(text) ?? /\.listen\(\s*(\d{2,5})\b/.exec(text);
    if (m) return Number(m[1]);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Routes from source

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.svelte-kit', '.gremlin', '.testmuai', 'coverage', '.turbo', '.vercel', 'out']);

export function walk(root: string, max = 3000): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < max) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e) || (e.startsWith('.') && e !== '.github')) continue;
      const p = join(dir, e);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(p);
      else if (st.size < 512_000) out.push(p);
    }
  }
  return out;
}

export function scanRoutes(root: string): string[] {
  const routes = new Set<string>();
  for (const file of walk(root)) {
    const rel = relative(root, file).split(sep).join('/');
    const appPage = /(?:^|\/)app\/(.*)page\.(t|j)sx?$/.exec(rel);
    if (appPage) {
      const path = '/' + appPage[1].split('/').filter((s) => s && !/^\(.*\)$/.test(s)).join('/');
      routes.add(path.replace(/\/$/, '') || '/');
      continue;
    }
    const pagesRoute = /(?:^|\/)pages\/(.*)\.(t|j)sx?$/.exec(rel);
    if (pagesRoute && !/^(_|api\/)/.test(pagesRoute[1])) {
      routes.add('/' + pagesRoute[1].replace(/(^|\/)index$/, '').replace(/\/$/, ''));
      continue;
    }
    if (/\.html$/.test(rel) && /(^|\/)(public|static|www)\//.test(rel)) {
      routes.add('/' + rel.replace(/^.*?(public|static|www)\//, '').replace(/(^|\/)index\.html$/, '').replace(/\.html$/, ''));
      continue;
    }
    if (/\.(t|j)sx?$|\.mjs$/.test(rel)) {
      let src = '';
      try {
        src = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const m of src.matchAll(/\bpath\s*[:=]\s*["'](\/[^"'\s]*)["']/g)) routes.add(m[1]);
      for (const m of src.matchAll(/\.(?:get|post|put|patch|delete)\(\s*["'](\/[^"'\s]*)["']/g)) routes.add(m[1]);
    }
  }
  return [...routes].filter((r) => !r.includes('*')).sort().slice(0, 80);
}

// ---------------------------------------------------------------------------
// Crawl the running app (server-rendered HTML; client-rendered apps fall back to source and the agent)

const decode = (s: string) =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4]) : undefined;
}

export function parsePage(html: string, path: string): PageInfo {
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '') || undefined;
  const heading = decode(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? '') || undefined;
  const links = [...html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["']/gi)].map((m) => m[1]);
  const buttons = [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)].map((m) => decode(m[1])).filter(Boolean);

  const labelsFor = new Map<string, string>();
  for (const m of html.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi)) {
    const f = attr(m[1], 'for');
    if (f) labelsFor.set(f, decode(m[2]));
  }
  const forms: FormInfo[] = [];
  for (const m of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const body = m[2];
    const fields: FieldInfo[] = [];
    for (const f of body.matchAll(/<(input|textarea|select)\b([^>]*)>/gi)) {
      const tag = f[2];
      const type = (attr(tag, 'type') ?? (f[1].toLowerCase() === 'input' ? 'text' : f[1].toLowerCase())).toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) continue;
      const id = attr(tag, 'id');
      const label =
        (id && labelsFor.get(id)) || attr(tag, 'aria-label') || attr(tag, 'placeholder') || attr(tag, 'name') || type;
      fields.push({ label: label.replace(/\s*\*$/, ''), type, required: /\brequired\b/i.test(tag) });
    }
    const submitBtn =
      /<button\b(?![^>]*type\s*=\s*["']?button)[^>]*>([\s\S]*?)<\/button>/i.exec(body)?.[1] ??
      attr(/<input\b[^>]*type\s*=\s*["']?submit[^>]*>/i.exec(body)?.[0] ?? '', 'value');
    forms.push({ fields, submit: submitBtn ? decode(submitBtn) : undefined, action: attr(m[1], 'action'), method: attr(m[1], 'method') });
  }
  return { path, title, heading, links, buttons, forms };
}

export async function crawl(baseUrl: string, seeds: string[] = ['/'], maxPages = 15): Promise<PageInfo[]> {
  const base = new URL(baseUrl);
  const seen = new Set<string>();
  const queue = [...new Set(seeds)];
  const pages: PageInfo[] = [];
  while (queue.length && pages.length < maxPages) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    let html = '';
    try {
      const res = await fetch(new URL(path, base), { signal: AbortSignal.timeout(4000), headers: { accept: 'text/html' } });
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('html')) continue;
      html = await res.text();
    } catch {
      continue;
    }
    const page = parsePage(html, path);
    pages.push(page);
    for (const href of page.links) {
      try {
        const u = new URL(href, new URL(path, base));
        if (u.origin !== base.origin) continue;
        if (/\.(png|jpe?g|svg|css|js|ico|pdf|zip)$/i.test(u.pathname) || /logout|sign-?out/i.test(u.pathname)) continue;
        if (!seen.has(u.pathname)) queue.push(u.pathname);
      } catch {}
    }
  }
  return pages;
}

// ---------------------------------------------------------------------------
// Journeys

const JOURNEY_RULES: [JourneyKey, string, RegExp][] = [
  ['checkout', 'Checkout', /checkout|place order|payment|shipping|billing/i],
  ['cart', 'Cart', /\bcart\b|basket|\bbag\b|add to cart/i],
  ['signup', 'Sign up', /sign ?up|register|create (an )?account/i],
  ['login', 'Log in', /log ?in|sign ?in/i],
  ['search', 'Search', /search|find/i],
  ['settings', 'Settings', /settings|profile|preferences|my account/i],
  ['contact', 'Contact', /contact|support|feedback|message us/i],
];

export function buildJourneys(pages: PageInfo[], routes: string[]): Journey[] {
  const journeys = new Map<JourneyKey, Journey>();
  const add = (key: JourneyKey, name: string, start: string, form?: FormInfo, buttons: string[] = []) => {
    const existing = journeys.get(key);
    if (existing && (existing.fields.length || !form)) return;
    journeys.set(key, { key, name, start, fields: form?.fields ?? [], submit: form?.submit, buttons });
  };
  for (const page of pages) {
    const pageText = `${page.path} ${page.title ?? ''} ${page.heading ?? ''}`;
    for (const form of page.forms) {
      const text = `${pageText} ${form.submit ?? ''} ${form.action ?? ''} ${form.fields.map((f) => f.label).join(' ')}`;
      const rule = JOURNEY_RULES.find(([, , re]) => re.test(`${form.submit ?? ''} ${form.action ?? ''}`)) ?? JOURNEY_RULES.find(([, , re]) => re.test(text));
      if (form.fields.some((f) => f.type === 'search')) add('search', 'Search', page.path, form);
      else if (rule) add(rule[0], rule[1], page.path, form);
      else if (form.fields.length) add('form', `Form on ${page.path}`, page.path, form);
    }
    for (const b of page.buttons) {
      if (/add to (cart|bag|basket)/i.test(b)) add('cart', 'Cart', page.path, undefined, [b]);
    }
  }
  for (const r of routes) {
    for (const [key, name, re] of JOURNEY_RULES) {
      if (re.test(r) && !journeys.has(key)) add(key, name, r);
    }
  }
  if (!journeys.size) add('browse', 'Browsing', '/');
  return [...journeys.values()];
}

export async function mapProduct(root: string, baseUrl: string, reachable: boolean): Promise<ProductMap> {
  const { stack, platforms } = detectStack(root);
  const routes = scanRoutes(root);
  const seeds = ['/', ...routes.filter((r) => !/[:[]/.test(r) && !r.startsWith('/api')).slice(0, 10)];
  const pages = reachable ? await crawl(baseUrl, seeds) : [];
  const journeys = buildJourneys(pages, routes);
  let readme: string | undefined;
  for (const name of ['README.md', 'readme.md', 'README']) {
    if (existsSync(join(root, name))) {
      readme = readFileSync(join(root, name), 'utf8').slice(0, 4000);
      break;
    }
  }
  return { stack, platforms, routes, pages, journeys, readme };
}
