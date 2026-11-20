import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

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
// Crawl the running app (server-rendered HTML; client-rendered apps fall back to component source below)

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
// Fields from component source (a client-rendered app serves an empty shell, so the crawl sees no forms)

const MAX_SOURCE_FILES = 400;
const MAX_PAGE_FILES = 20;
const MAX_PAGE_FIELDS = 12;
const MAX_SOURCE_PAGES = 100;

const COMPONENT = /\.(vue|svelte|[jt]sx|html)$/;
const COMPONENT_IMPORT = /\.(vue|svelte|[jt]sx)$|\/[A-Z][^/]*\.js$/;
const NOT_APP = /(^|\/)(tests?|__tests__|e2e|cypress|playwright|stories|fixtures?|examples?)\/|\.(test|spec|stories|demo)\.[^/]+$/;
// shared primitives (an <Input> wrapper, a ui/ kit) count where they are used, not as fields of their own
const PRIMITIVE = /(^|\/)(ui|primitives)\//;
const FIELD_TAG = /(^|-)(input|textarea|select|text-?field|combo-?box|auto-?complete)(-|$)/;
// parts and outputs of a field rather than fields: <SelectItem>, <InputLabel>, <input-copyable>, TS types like <InputProps>
const NOT_FIELD =
  /(^|-)(item|option|options|group|label|content|trigger|value|list|menu|icon|wrapper|container|error|helper|hint|addon|adornment|prefix|suffix|slot|separator|panel|popover|portal|indicator|message|description|counter|tag|button|btn|copyable|display|output|preview|props|element|ref|type|event|state)(-|$)/;
const ROOT_COMPONENT =
  /(^|\/)((App|app)\.(vue|svelte|[jt]sx)|app\/(layout|root)\.[jt]sx|pages\/_app\.[jt]sx|routes\/(\+layout\.svelte|__root\.[jt]sx)|app\.component\.(html|ts)|layouts?\/[^/]+\.(vue|svelte|[jt]sx))$/;
const GENERIC_DIRS = new Set(['src', 'app', 'lib', 'components', 'pages', 'views', 'routes', 'features', 'modules', 'common', 'shared', 'ui', 'layouts', 'containers', 'screens']);
// with no form or submit type to go by, only a button that reads like sending something counts as the submit
const SUBMIT_WORDS =
  /^(submit|send|save|sign|log ?in|register|create|continue|next|search|go|apply|subscribe|place|pay|checkout|buy|add|update|confirm|join|post|book|order|request|generate|convert|calculate|compute|encrypt|decrypt|hash|compare|check|validate|parse|analy[sz]e)\b/i;

const LABEL_PROPS = ['label', 'input-label', 'inputLabel', 'aria-label', 'floating-label', 'floatingLabelText', 'labelText'];
const PLACEHOLDER_PROPS = ['placeholder', 'input-placeholder', 'inputPlaceholder'];
const NAME_PROPS = ['name', 'formControlName', 'id'];
const BINDINGS = ['v-model', 'v-model:value', 'v-model:model-value', 'bind:value', '[(ngModel)]', '[formControl]', ':value', ':model-value', 'value'];

interface SourceScan {
  fields: FieldInfo[];
  buttons: string[];
  submit?: string;
  heading?: string;
  children: string[];
  /** Renders routed content (<router-view>, <Outlet>, <slot>, {children}): a layout around every page. */
  outlet: boolean;
}

const OUTLET = /<(router-view|RouterView|Outlet|Routes|NuxtPage|router-outlet|slot)\b|\{\s*(props\.)?children\s*\}|@render\s+children/;

const kebab = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/[._:]+/g, '-')
    .toLowerCase();

const humanize = (id: string) => {
  const s = kebab(id).replace(/-+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

const isFieldTag = (k: string) => FIELD_TAG.test(k) && !NOT_FIELD.test(k);

const unwrap = (raw: string) => (raw.length > 1 && (/^(["'`]).*\1$/s.test(raw) || /^\{.*\}$/s.test(raw)) ? raw.slice(1, -1) : raw);

/** The text of a bound expression when it is knowable: a string literal, or the last part of an i18n key, t('auth.signIn') → "Sign in". */
function textOf(expr: string): string | undefined {
  const lit = /^\s*(["'`])([^"'`]*)\1\s*$/.exec(expr);
  if (lit) {
    // `${label}:` leaves only punctuation, which names nothing
    const text = lit[2].replace(/\$\{[^}]*\}/g, '').replace(/\(\s*\)/g, '').trim();
    return /[\p{L}\p{N}]/u.test(text) ? text : undefined;
  }
  const key = /(?:^|[^\w$])(?:\$t|t|i18n\.t|translate)\(\s*["'`]([\w.:-]+)["'`]/.exec(expr)?.[1];
  // 'search.label' says "Search", not "Label"
  const parts = (key ?? '')
    .split(/[.:]/)
    .map((p) => p.replace(/(Label|Title|Text|Placeholder|Button)$/, ''))
    .filter((p) => p && !/^(label|title|text|placeholder|button|btn|value|name|description|hint|tooltip)$/i.test(p));
  return parts.length ? humanize(parts[parts.length - 1]) : undefined;
}

const textContent = (html: string) =>
  decode(html.replace(/\{\{([\s\S]*?)\}\}|\{([^{}]*)\}/g, (_, a?: string, b?: string) => ` ${textOf(a ?? b ?? '') ?? ''} `));

/** End of a tag's attributes: skips `>` inside quotes and `{…}`, so JSX arrows and Svelte handlers don't end the tag. */
function readTag(src: string, from: number): { attrs: string; end: number } {
  let depth = 0;
  let quote = '';
  const stop = Math.min(src.length, from + 4000);
  for (let i = from; i < stop; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    else if (c === '>' && !depth) return { attrs: src.slice(from, i), end: i + 1 };
  }
  return { attrs: src.slice(from, stop), end: stop };
}

function valueEnd(s: string, i: number): number {
  const open = s[i];
  if (open === '"' || open === "'" || open === '`') {
    const close = s.indexOf(open, i + 1);
    return close < 0 ? s.length : close + 1;
  }
  if (open !== '{') return i + /^[^\s>]*/.exec(s.slice(i))![0].length;
  let depth = 0;
  let quote = '';
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && !--depth) return j + 1;
  }
  return s.length;
}

/** Attribute name → raw value ('' when bare). Spreads like {...register('email')} collect under '{…}'. */
function parseAttrs(s: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < s.length) {
    if (/[\s/]/.test(s[i])) {
      i++;
      continue;
    }
    if (s[i] === '{') {
      const end = valueEnd(s, i);
      out.set('{…}', (out.get('{…}') ?? '') + s.slice(i, end));
      i = end;
      continue;
    }
    const name = /^[^\s=/>{]+/.exec(s.slice(i))?.[0];
    if (!name) {
      i++;
      continue;
    }
    i += name.length;
    const eq = /^\s*=\s*/.exec(s.slice(i));
    if (!eq) {
      out.set(name, '');
      continue;
    }
    i += eq[0].length;
    const end = valueEnd(s, i);
    out.set(name, s.slice(i, end));
    i = end;
  }
  return out;
}

/** A prop's text, static (label="X", label={'X'}) or bound to a literal or i18n key (:label="t('x')", [label]="'X'"). */
function prop(attrs: Map<string, string>, names: string[]): string | undefined {
  for (const name of names) {
    const raw = attrs.get(name);
    const own = raw ? (raw.startsWith('{') ? textOf(unwrap(raw)) : unwrap(raw)) : undefined;
    if (own?.trim()) return own.trim();
    for (const bound of [`:${name}`, `v-bind:${name}`, `[${name}]`]) {
      const v = attrs.get(bound);
      const text = v ? textOf(unwrap(v)) : undefined;
      if (text?.trim()) return text.trim();
    }
  }
  return undefined;
}

/** A boolean prop that is plainly on: readonly, readOnly={true}, :disabled="true". Bound to a variable, it might be off. */
function isOn(attrs: Map<string, string>, names: string[]): boolean {
  return names.some((name) =>
    [name, `:${name}`, `[${name}]`].some((k) => {
      const v = attrs.get(k);
      return v !== undefined && ['', 'true', name.toLowerCase()].includes(unwrap(v).trim().toLowerCase());
    }),
  );
}

/** The state a field is bound to, as a last-resort name: v-model="form.email", value={email}, {...register('email')}. */
function bindingName(attrs: Map<string, string>): string | undefined {
  const registered = /register\(\s*["'`]([\w.]+)/.exec(attrs.get('{…}') ?? '')?.[1];
  if (registered) return registered.split('.').pop();
  for (const k of BINDINGS) {
    const v = attrs.get(k);
    // a static value="…" is a default, not a name
    if (!v || (k === 'value' && !v.startsWith('{'))) continue;
    const id = /([A-Za-z_$][\w$]*)\s*$/.exec(unwrap(v).trim())?.[1];
    if (id) return id;
  }
  return undefined;
}

/** A field fed by its own component's props (:label="inputLabel", label={props.label}): a wrapper, whose uses are the fields. */
function forwardsProps(attrs: Map<string, string>): boolean {
  return ['label', 'placeholder'].some((name) =>
    [`:${name}`, `v-bind:${name}`, `[${name}]`, name].some((k) => {
      const v = attrs.get(k);
      if (!v || (k === name && !v.startsWith('{'))) return false;
      const expr = unwrap(v).trim();
      return /^(props\.)?[\w$]+$/.test(expr) && expr.toLowerCase().endsWith(name);
    }),
  );
}

/** The visible label just before a field: <label>, <FormLabel>, <mat-label>, or an open form item with a label prop (<n-form-item label="…">, <Form.Item>). */
function contextLabel(seg: string): string | undefined {
  for (const m of [...seg.matchAll(/<([A-Za-z][\w.:-]*)(?=[\s/>])/g)].reverse()) {
    const k = kebab(m[1]);
    const open = readTag(seg, m.index! + m[0].length);
    if (/(^|-)label$/.test(k)) {
      const rest = seg.slice(open.end);
      const close = rest.search(new RegExp(`</${m[1].replace(/\./g, '\\.')}\\s*>`));
      const text = textContent(close < 0 ? rest : rest.slice(0, close));
      if (text) return text;
    } else if (/form-?(item|field|group|control)$/.test(k) && !seg.includes(`</${m[1]}`, open.end)) {
      const label = prop(parseAttrs(open.attrs), ['label']);
      if (label) return label;
    }
  }
  return undefined;
}

const cleanLabel = (s: string) => s.replace(/\s+/g, ' ').replace(/[\s:*]+$/, '').trim().slice(0, 80);

function fieldType(k: string, attrs: Map<string, string>): string {
  const type = prop(attrs, ['type'])?.toLowerCase();
  if (k.includes('textarea') || type === 'textarea' || attrs.has('multiline')) return 'textarea';
  if (/(^|-)select(-|$)/.test(k)) return 'select';
  const words = k.split('-');
  for (const t of ['number', 'search', 'password', 'email', 'date', 'color']) if (words.includes(t)) return t;
  return type && /^[a-z-]+$/.test(type) ? type : 'text';
}

/** The template of a component: a Vue/Svelte file without its <script>, JSX as is, an Angular template inline or from templateUrl. */
function splitComponent(file: string, src: string): { markup: string; script: string } {
  if (/\.(vue|svelte|html)$/.test(file)) {
    const script = [...src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n');
    return { markup: src.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ''), script };
  }
  if (/@Component\s*\(/.test(src)) {
    const url = /templateUrl\s*:\s*["'`]([^"'`]+)["'`]/.exec(src)?.[1];
    let markup = /\btemplate\s*:\s*`([\s\S]*?)`/.exec(src)?.[1] ?? '';
    if (url) {
      try {
        markup = readFileSync(join(dirname(file), url), 'utf8');
      } catch {}
    }
    return { markup, script: src };
  }
  return { markup: src.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, ''), script: src };
}

function resolveImport(root: string, from: string, spec: string): string | undefined {
  const rest = spec.replace(/^([@~]|\$lib)\//, '');
  const bases = spec.startsWith('.')
    ? [join(dirname(from), spec)]
    : spec.startsWith('$lib/')
      ? [join(root, 'src', 'lib', rest)]
      : /^[@~]\//.test(spec)
        ? [join(root, 'src', rest), join(root, rest)]
        : [];
  for (const base of bases) {
    if (relative(root, base).startsWith('..')) continue;
    for (const ext of ['', '.vue', '.tsx', '.jsx', '.svelte', '.ts', '.js', '/index.vue', '/index.tsx', '/index.jsx', '/index.ts', '/index.js']) {
      const p = base + ext;
      if (existsSync(p) && statSync(p).isFile()) return p;
    }
  }
  return undefined;
}

/** Local names of imported modules, including lazy ones: `import Login from './Login'`, `const Login = lazy(() => import('./Login'))`. */
function importMap(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/import\s+(?:type\s+)?([\w$]+)?\s*,?\s*(?:\{([^}]*)\})?\s*from\s*["']([^"']+)["']/g)) {
    if (m[1]) out.set(m[1], m[3]);
    for (const n of (m[2] ?? '').split(',')) {
      const id = n.trim().split(/\s+as\s+/).pop();
      if (id) out.set(id, m[3]);
    }
  }
  for (const m of src.matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*(?:React\.)?(?:lazy|defineAsyncComponent|loadable)\(\s*(?:\(\)\s*=>\s*)?import\(\s*["']([^"']+)["']/g)) {
    out.set(m[1], m[2]);
  }
  return out;
}

/** `local` maps component names to .vue files, for templates that use auto-registered components without importing them. */
function scanComponent(root: string, file: string, local: Map<string, string>): SourceScan {
  let src = '';
  try {
    src = readFileSync(file, 'utf8');
  } catch {}
  const { markup: raw, script } = splitComponent(file, src);
  const markup = raw.replace(/<!--[\s\S]*?-->/g, '');
  const used = new Set<string>();

  const labelsFor = new Map<string, string>();
  for (const m of markup.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi)) {
    const id = prop(parseAttrs(m[1]), ['for', 'htmlFor']);
    if (id) labelsFor.set(id, textContent(m[2]));
  }

  const fields: FieldInfo[] = [];
  const buttons: { text: string; submit: boolean; plain: boolean; inForm: boolean }[] = [];
  let prevEnd = 0;
  for (const m of markup.matchAll(/<([A-Za-z][\w.:-]*)(?=[\s/>])/g)) {
    // useState<Input> or forwardRef<HTMLInputElement> is a TypeScript type, not a tag
    if (/[\w$.)\]]/.test(markup[m.index! - 1] ?? '')) continue;
    const k = kebab(m[1]);
    if (file.endsWith('.vue') && local.has(k)) used.add(local.get(k)!);
    const { attrs: rawAttrs, end } = readTag(markup, m.index! + m[0].length);
    const attrs = parseAttrs(rawAttrs);
    const type = fieldType(k, attrs);
    const native = k === 'input';

    if (k === 'button' || /(^|-)(button|btn)$/.test(k) || (native && ['submit', 'button'].includes(type))) {
      const close = rawAttrs.trimEnd().endsWith('/') || native ? -1 : markup.indexOf(`</${m[1]}`, end);
      const text = cleanLabel((close < 0 ? '' : textContent(markup.slice(end, close))) || prop(attrs, ['label', 'text', 'value', 'title']) || '');
      const kind = prop(attrs, ['type', 'html-type', 'htmlType', 'attr-type', 'attrType', 'native-type', 'nativeType']);
      const inForm = markup.lastIndexOf('<form', m.index!) > markup.lastIndexOf('</form', m.index!);
      if (text) buttons.push({ text: text.slice(0, 40), submit: kind === 'submit', plain: kind === 'button', inForm });
      continue;
    }

    // <format-transformer input-label="Your raw JSON"> wraps a text box whatever the component is called
    const wrapsInput = [...attrs.keys()].some((a) => /^(:|v-bind:)?input-?(label|placeholder)$/i.test(a));
    if (!isFieldTag(k) && !wrapsInput) continue;
    const seg = markup.slice(Math.max(prevEnd, m.index! - 400), m.index!);
    prevEnd = end;
    if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type) || isOn(attrs, ['readonly', 'readOnly', 'disabled'])) continue;
    // an input component's own definition passes its props through; its uses are the fields
    if (/\.\.\.\s*(props|rest|restProps|attrs|others|\$\$restProps)\b/.test(attrs.get('{…}') ?? '') || attrs.get('v-bind') === '"$attrs"' || forwardsProps(attrs)) continue;
    const name = prop(attrs, NAME_PROPS)?.replace(/\]$/, '').split(/[[.]/).pop();
    const binding = bindingName(attrs);
    const named =
      prop(attrs, LABEL_PROPS) ??
      labelsFor.get(prop(attrs, ['id']) ?? '') ??
      contextLabel(seg) ??
      prop(attrs, PLACEHOLDER_PROPS) ??
      (name ? humanize(name) : undefined);
    // nothing names it and it is bound to the component's own value: a wrapper like <InputCopyable>
    if (!named && (binding === 'value' || binding === 'modelValue')) continue;
    const label = named ?? (binding ? humanize(binding) : type);
    // a placeholder like "* * * * *" is all punctuation, but still what the user sees
    fields.push({ label: cleanLabel(label) || label.trim().slice(0, 80) || type, type, required: isOn(attrs, ['required', 'aria-required', 'isRequired']) });
    if (fields.length >= MAX_PAGE_FIELDS) break;
  }

  const submit =
    buttons.find((b) => b.submit) ?? buttons.find((b) => b.inForm && !b.plain) ?? buttons.find((b) => SUBMIT_WORDS.test(b.text));
  const heading = textContent(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(markup)?.[1] ?? '') || undefined;
  const children = new Set<string>();
  const imported = [...script.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'`]([^"'`]+)["'`]/g)].map((m) => resolveImport(root, file, m[1]));
  for (const f of [...imported, ...used]) {
    if (!f || f === file || !COMPONENT_IMPORT.test(f)) continue;
    const rel = relative(root, f).split(sep).join('/');
    // input-like components (<InputCopyable>, <SearchInput>) were already judged where they are used
    if (!PRIMITIVE.test(rel) && !FIELD_TAG.test(kebab(rel.split('/').pop()!.split('.')[0]))) children.add(f);
  }
  return { fields, buttons: buttons.map((b) => b.text), submit: fields.length ? submit?.text : undefined, heading, children: [...children], outlet: OUTLET.test(markup) };
}

const ROUTE_PATH = /\bpath\s*[:=]\s*\{?\s*["'`](\/?[^"'`\s]*)["'`]/g;
const ROUTE_REF = /import\(\s*["'`]([^"'`]+)["'`]|<([A-Z][\w$]*)|\b(?:component|Component|loadComponent|element)\s*:\s*([A-Za-z_$][\w$]*)/g;

/** Router config: each `path` and the components named after it (Vue Router, React Router, Angular, route tables like IT Tools'). */
function configRoutes(root: string, file: string, src: string, add: (route: string, file: string) => void): void {
  // Angular paths have no leading slash; elsewhere a relative path is a nested child whose parent we can't place
  const angular = /@angular\/router|:\s*Routes\b/.test(src);
  const imports = importMap(src);
  const found = [...src.matchAll(ROUTE_PATH)];
  found.forEach((m, i) => {
    const route = m[1].startsWith('/') ? m[1] : angular ? `/${m[1]}` : undefined;
    if (!route || /[*(]/.test(route)) return;
    const from = m.index! + m[0].length;
    const window = src.slice(from, Math.min(found[i + 1]?.index ?? Infinity, from + 800));
    for (const r of window.matchAll(ROUTE_REF)) {
      const spec = r[1] ?? imports.get(r[2] ?? r[3] ?? '');
      const target = spec ? resolveImport(root, file, spec) : undefined;
      if (target) add(route.replace(/(.)\/$/, '$1'), target);
    }
  });
}

/** A route from file-based routing: Next.js app/ and pages/, Nuxt pages/, SvelteKit, Remix/SolidStart/TanStack routes/, static HTML. */
function fileRoute(rel: string, stack: string[]): string | undefined {
  const path = (segs: string[]) => '/' + segs.filter((s) => s && s !== 'index' && !/^\(.*\)$/.test(s)).join('/');
  const app = /(?:^|\/)app\/(?:(.+)\/)?page\.[jt]sx?$/.exec(rel);
  if (app) return path((app[1] ?? '').split('/'));
  const kit = /(?:^|\/)routes\/(?:(.+)\/)?\+page\.svelte$/.exec(rel);
  if (kit) return path((kit[1] ?? '').split('/'));
  // a plain Vue or React SPA keeps components in pages/ too, routed by config rather than by file name
  const pages = /(?:^|\/)pages\/(.+)\.(vue|[jt]sx?)$/.exec(rel);
  if (pages) return stack.includes(pages[2] === 'vue' ? 'Nuxt' : 'Next.js') && !/^(_|api\/)/.test(pages[1]) ? path(pages[1].split('/')) : undefined;
  const flat = /(?:^|\/)(?:app|src)\/routes\/(.+)\.[jt]sx$/.exec(rel);
  if (flat) {
    const segs = flat[1].split(/[/.]/);
    if (segs.some((s) => /^(-|__|\+)/.test(s))) return undefined;
    return path(segs.filter((s) => !s.startsWith('_') && s !== 'route').map((s) => (s === '$' ? '*' : s.replace(/^\$/, ':').replace(/_$/, ''))));
  }
  if (/\.html$/.test(rel) && /(^|\/)(public|static|www)\//.test(rel)) {
    return '/' + rel.replace(/^.*?(public|static|www)\//, '').replace(/(^|\/)index\.html$/, '').replace(/\.html$/, '');
  }
  return undefined;
}

/** The route whose segments best match a file's folders and name: src/features/checkout/AddressForm.tsx → /checkout. */
function closestRoute(rel: string, routes: string[]): string | undefined {
  const parts = rel.split('/');
  const base = kebab(parts.pop()!.split('.')[0]);
  const dirs = new Set(parts.map(kebab).filter((d) => !GENERIC_DIRS.has(d)));
  let best: { route: string; hit: number; miss: number } | undefined;
  for (const route of routes) {
    const segs = route
      .split('/')
      .filter((s) => s && !/^[:[$]/.test(s))
      .map((s) => s.toLowerCase());
    const hit = segs.filter((s) => dirs.has(s) || base === s || base.startsWith(`${s}-`)).length;
    if (hit && (!best || hit > best.hit || (hit === best.hit && segs.length - hit < best.miss))) best = { route, hit, miss: segs.length - hit };
  }
  return best?.route;
}

/**
 * Pages and fields read from component source, for apps whose served HTML has none. Fields go to a route through
 * router config or file-based routing, then the components those import; root layouts go to '/', and any other
 * component with fields to the closest route by folder name. Heuristic and bounded.
 */
export function sourcePages(root: string, routes: string[] = [], stack: string[] = []): PageInfo[] {
  const relOf = (f: string) => relative(root, f).split(sep).join('/');
  const files = walk(root).filter((f) => !NOT_APP.test(relOf(f)));
  const owners = new Map<string, string[]>();
  const add = (route: string, file: string) => {
    const list = owners.get(route) ?? [];
    if (!list.includes(file)) list.push(file);
    owners.set(route, list);
  };
  for (const f of files) {
    if (!/\.m?[jt]sx?$/.test(f)) continue;
    let src = '';
    try {
      src = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    if (src.includes('path')) configRoutes(root, f, src, add);
  }
  const configured = new Set([...owners.values()].flat());
  for (const f of files) {
    const route = configured.has(f) ? undefined : fileRoute(relOf(f), stack);
    if (route !== undefined && !route.includes('*')) add(route, f);
  }
  const routed = new Set([...owners.values()].flat());
  const layouts = new Set(files.filter((f) => ROOT_COMPONENT.test(relOf(f)) && !routed.has(f)));
  for (const f of layouts) add('/', f);

  // Vue apps often register components globally or by auto-import, so a template can use <command-palette /> unimported
  const local = new Map<string, string>();
  for (const f of files) {
    if (!f.endsWith('.vue')) continue;
    const parts = relOf(f).split('/');
    const base = parts.pop()!.replace(/\.vue$/, '');
    const name = kebab(base === 'index' ? (parts.pop() ?? base) : base);
    if (name.includes('-') && !local.has(name)) local.set(name, f);
  }
  const cache = new Map<string, SourceScan>();
  const scan = (f: string) => {
    if (!cache.has(f) && cache.size < MAX_SOURCE_FILES) cache.set(f, scanComponent(root, f, local));
    return cache.get(f);
  };
  // a page's own components and what they import, two levels down; another route's component belongs to that route
  const expand = (start: string[], roots: Set<string>) => {
    const seen = new Set<string>();
    let level = start;
    for (let depth = 0; depth <= 2 && level.length; depth++) {
      const next: string[] = [];
      for (const f of level) {
        if (seen.has(f) || seen.size >= MAX_PAGE_FILES) continue;
        seen.add(f);
        for (const c of scan(f)?.children ?? []) if (!roots.has(c)) next.push(c);
      }
      level = next;
    }
    return [...seen];
  };

  let roots = new Set([...owners.values()].flat());
  const used = new Set([...owners.values()].flatMap((start) => expand(start, roots)));
  // routes that render a known component win ties over routes only seen in source
  const targets = [...new Set([...owners.keys(), ...routes])].filter((r) => r !== '/' && !r.startsWith('/api') && !r.includes('*'));
  for (const f of files.filter((f) => COMPONENT.test(f) && !used.has(f)).sort()) {
    if (!scan(f)?.fields.length) continue;
    const route = closestRoute(relOf(f), targets);
    if (route) add(route, f);
  }

  roots = new Set([...owners.values()].flat());
  const pages: PageInfo[] = [];
  for (const [path, start] of [...owners].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    // a layout around routed content is chrome on every page (a language picker, a menu): only its search box is a journey of its own
    const chrome = start.filter((f) => layouts.has(f) && scan(f)?.outlet);
    const own = new Set(expand(start.filter((f) => !chrome.includes(f)), roots));
    const forms: FormInfo[] = [];
    const buttons = new Set<string>();
    let heading: string | undefined;
    let room = MAX_PAGE_FIELDS;
    for (const f of new Set([...own, ...expand(chrome, roots)])) {
      const s = scan(f);
      if (!s) continue;
      const mine = own.has(f);
      const fields = mine ? s.fields : s.fields.filter((x) => x.type === 'search' || /search|find/i.test(x.label));
      if (mine) {
        heading ??= s.heading;
        for (const b of s.buttons) buttons.add(b);
      }
      if (fields.length && room > 0) {
        forms.push({ fields: fields.slice(0, room), submit: mine ? s.submit : undefined });
        room -= fields.length;
      }
    }
    if (forms.length || buttons.size) pages.push({ path, heading, links: [], buttons: [...buttons].slice(0, 20), forms });
    if (pages.length >= MAX_SOURCE_PAGES) break;
  }
  return pages;
}

/** Source pages fill in what the crawl could not see; a crawled page that already has fields stays as served. */
function mergePages(crawled: PageInfo[], fromSource: PageInfo[]): PageInfo[] {
  const bySource = new Map(fromSource.map((p) => [p.path, p]));
  const merged = crawled.map((p) => {
    const s = bySource.get(p.path);
    bySource.delete(p.path);
    if (!s || p.forms.some((f) => f.fields.length)) return p;
    // an SPA shell's title is the same on every route, so it says nothing about this page
    if (!p.heading && !p.buttons.length && !p.forms.length) return s;
    return { ...p, heading: p.heading ?? s.heading, buttons: [...new Set([...p.buttons, ...s.buttons])], forms: s.forms };
  });
  return [...merged, ...bySource.values()];
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

// a client-rendered app serves the same empty shell on every route, so its forms only exist in component source
const CLIENT_RENDERED = ['React', 'Vue', 'Svelte', 'Angular'];
const SERVER_RENDERED = ['Next.js', 'Nuxt', 'Remix', 'Astro', 'SvelteKit'];

export async function mapProduct(root: string, baseUrl: string, reachable: boolean): Promise<ProductMap> {
  const { stack, platforms } = detectStack(root);
  let routes = scanRoutes(root);
  const seeds = ['/', ...routes.filter((r) => !/[:[]/.test(r) && !r.startsWith('/api')).slice(0, 10)];
  let pages = reachable ? await crawl(baseUrl, seeds) : [];
  const spa = stack.some((s) => CLIENT_RENDERED.includes(s)) && !stack.some((s) => SERVER_RENDERED.includes(s));
  if (spa || !pages.some((p) => p.forms.some((f) => f.fields.length))) {
    const fromSource = sourcePages(root, routes, stack);
    pages = mergePages(pages, fromSource);
    routes = [...new Set([...routes, ...fromSource.map((p) => p.path)])].sort().slice(0, 80);
  }
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
