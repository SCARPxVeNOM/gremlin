import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import { CONFIG_FILE, findRoot, projectPaths, type ProjectPaths } from './paths.ts';

const Persona = z.object({
  description: z.string().optional(),
  email: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
});

export const ConfigSchema = z.object({
  app: z
    .object({
      name: z.string().default('My app'),
      url: z.string().default('http://localhost:3000'),
      /** Shell command Gremlin may use to start the app when it isn't reachable. */
      start: z.string().optional(),
      /** HTTP request that resets test data before each run, e.g. "POST /__reset". */
      reset: z.string().optional(),
      /** Gremlin refuses to run against a target marked as production. */
      production: z.boolean().default(false),
    })
    .default({ name: 'My app', url: 'http://localhost:3000', production: false }),
  platforms: z.array(z.enum(['web', 'ios', 'android'])).default(['web']),
  personas: z.record(z.string(), Persona).default({}),
  agent: z
    .object({
      name: z.enum(['claude-code', 'codex', 'cursor', 'gemini', 'custom', 'none']).default('claude-code'),
      /** Custom fixer command. {prompt_file} is replaced with the path of the fix package. */
      command: z.string().optional(),
      /** Custom read-only command used to draft flows. {prompt_file} as above. */
      ask_command: z.string().optional(),
    })
    .default({ name: 'claude-code' }),
  loop: z
    .object({
      mode: z.enum(['suggest', 'approve', 'autonomous']).default('approve'),
      attempts: z.number().int().min(1).max(10).default(3),
    })
    .default({ mode: 'approve', attempts: 3 }),
  guard: z
    .object({
      trigger: z.array(z.enum(['agent-finish', 'commit', 'pr'])).default(['agent-finish', 'pr']),
      /** Product areas (flow tags) mapped to the source paths that implement them. */
      areas: z.record(z.string(), z.array(z.string())).default({}),
      /** What Guard runs when a change touches no mapped area. */
      fallback: z.enum(['all', 'none']).default('all'),
      concurrency: z.number().int().min(1).max(8).default(2),
    })
    .default({ trigger: ['agent-finish', 'pr'], areas: {}, fallback: 'all', concurrency: 2 }),
  breaker: z
    .object({
      scope: z.array(z.string()).default([]),
      avoid: z.array(z.string()).default([]),
      categories: z
        .array(z.enum(['input', 'timing', 'navigation', 'state', 'environment', 'accessibility', 'permission']))
        .default(['input', 'timing', 'navigation', 'state', 'accessibility']),
      max_flows: z.number().int().min(1).max(50).default(6),
    })
    .default({ scope: [], avoid: [], categories: ['input', 'timing', 'navigation', 'state', 'accessibility'], max_flows: 6 }),
  sources: z
    .object({
      paste: z.boolean().default(true),
      github: z.object({ label: z.string().default('gremlin') }).optional(),
    })
    .default({ paste: true }),
  budget: z
    .object({
      per_run: z.number().default(200),
      per_day: z.number().default(2000),
      per_bug: z.number().default(500),
    })
    .default({ per_run: 200, per_day: 2000, per_bug: 500 }),
  protected_paths: z.array(z.string()).default([]),
  /**
   * Behaviour contracts: product-wide rules Kane checks at the end of every flow, such as
   * "Every price shows a currency symbol". A rule with tags applies only to flows with one of them.
   */
  contracts: z
    .array(z.union([z.string(), z.object({ rule: z.string(), tags: z.array(z.string()).default([]) })]))
    .default([])
    .transform((list) => list.map((c) => (typeof c === 'string' ? { rule: c, tags: [] as string[] } : c))),
  kane: z
    .object({
      headless: z.boolean().default(true),
      max_steps: z.number().int().default(40),
      timeout: z.number().int().default(600),
      bug_detection: z.enum(['off', 'stop', 'continue']).default('continue'),
    })
    .default({ headless: true, max_steps: 40, timeout: 600, bug_detection: 'continue' }),
});

export type GremlinConfig = z.infer<typeof ConfigSchema>;

/** Expand ${VAR} and ${VAR:-default} from the environment. Secrets live in env vars, never in the file. */
export function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/gi, (_, name: string, def?: string) => env[name] ?? def ?? '');
}

function expandDeep(node: unknown): unknown {
  if (typeof node === 'string') return expandEnv(node);
  if (Array.isArray(node)) return node.map(expandDeep);
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, expandDeep(v)]));
  }
  return node;
}

export interface Project {
  root: string;
  paths: ProjectPaths;
  config: GremlinConfig;
  /** Config before env expansion, safe to show on the dashboard. */
  raw: unknown;
}

export class ProjectNotFoundError extends Error {
  constructor(start: string) {
    super(`No ${CONFIG_FILE} found in ${start} or any parent. Run \`gremlin init\` first.`);
  }
}

export function loadProject(start = process.cwd()): Project {
  const root = findRoot(start);
  if (!root) throw new ProjectNotFoundError(start);
  const paths = projectPaths(root);
  const raw = YAML.parse(readFileSync(paths.config, 'utf8')) ?? {};
  const config = ConfigSchema.parse(expandDeep(raw));
  return { root, paths, config, raw };
}

export function tryLoadProject(start = process.cwd()): Project | null {
  try {
    return loadProject(start);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) return null;
    throw err;
  }
}

export function writeConfig(path: string, doc: string): void {
  if (existsSync(path)) throw new Error(`${path} already exists`);
  writeFileSync(path, doc);
}

/** Resolve a flow's starting point (a path or URL) against the configured app URL. */
export function resolveUrl(config: GremlinConfig, start?: string): string {
  if (!start) return config.app.url;
  if (/^https?:\/\//i.test(start)) return start;
  return new URL(start, config.app.url.endsWith('/') ? config.app.url : config.app.url + '/').toString();
}
