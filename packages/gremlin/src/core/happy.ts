import { extractJson, getAgent } from './agent.ts';
import type { Project } from './config.ts';
import type { Journey, ProductMap } from './discover.ts';
import { lintFlow, type FlowDraft } from './flow.ts';
import { flowSafetyIssues } from './guardrails.ts';
import { FLOW_RULES } from './revise.ts';

/** Starter happy-path flows, so the first run shows Kane working within minutes of setup. */

function fromJourney(j: Journey, persona?: string): FlowDraft | undefined {
  const base = { type: 'happy' as const, source: 'gremlin init', start: j.start, tags: [j.key] };
  switch (j.key) {
    case 'browse':
      return { ...base, title: 'The home page loads', steps: ['Open the home page.'], expect: ['The main content is visible', 'No error message is visible'] };
    case 'search':
      return {
        ...base,
        title: 'Search finds results',
        steps: ['Search for a word that appears on the home page.'],
        expect: ['At least one result is shown', 'No error message is visible'],
      };
    case 'cart':
      return {
        ...base,
        start: '/',
        title: 'Adding a product to the cart',
        steps: ['Open the first product on the home page.', 'Add it to the cart.', 'Open the cart.'],
        expect: ['The cart shows that product with quantity 1', 'The cart total equals the product price'],
        tags: ['cart', 'money'],
      };
    case 'checkout':
      return {
        ...base,
        start: '/',
        title: 'Checking out with valid details',
        steps: [
          'Add any product to the cart and go to checkout.',
          'Fill in the checkout form with ordinary valid test details, using an @example.test email address.',
          `Submit the order.`,
        ],
        expect: ['A confirmation with an order number is shown', 'No error message is visible'],
        tags: ['checkout', 'money'],
      };
    case 'login':
      return persona
        ? {
            ...base,
            title: `Logging in as ${persona}`,
            account: persona,
            steps: [`Log in as the ${persona} test account.`],
            expect: ['The user is logged in and sees their account', 'No error message is visible'],
            tags: ['auth'],
          }
        : undefined;
    case 'signup':
      return {
        ...base,
        title: 'Signing up with a new account',
        steps: ['Sign up with a new test email address ending in @example.test and a strong password.'],
        expect: ['The account is created and the user is signed in', 'No error message is visible'],
        tags: ['auth', 'signup'],
      };
    case 'contact':
      return {
        ...base,
        title: 'Sending the contact form',
        steps: ['Fill in the contact form with ordinary test details (an @example.test email) and send it.'],
        expect: ['A confirmation message is shown'],
        tags: ['contact'],
      };
    default:
      return undefined;
  }
}

export function templateHappyFlows(map: ProductMap, project: Project, max = 5): FlowDraft[] {
  const persona = Object.keys(project.config.personas)[0];
  const order = ['browse', 'search', 'cart', 'checkout', 'login', 'signup', 'contact', 'settings', 'form'];
  const journeys = [...map.journeys].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  if (!journeys.some((j) => j.key === 'browse')) journeys.unshift({ key: 'browse', name: 'Browsing', start: '/', fields: [], buttons: [] });
  return journeys
    .map((j) => fromJourney(j, persona))
    .filter((f): f is FlowDraft => Boolean(f))
    .slice(0, max);
}

export async function agentHappyFlows(project: Project, map: ProductMap, max = 5): Promise<FlowDraft[]> {
  const agent = getAgent(project.config);
  if (!agent || !agent.available()) return [];
  const personas = Object.entries(project.config.personas).map(([n, p]) => `${n}${p.description ? ` (${p.description})` : ''}`);
  const prompt = [
    `You are setting up Gremlin for this repository. Read the code and write ${max} happy-path user flows covering the most important journeys of the app running at ${project.config.app.url}.`,
    `Discovered so far: routes ${map.routes.slice(0, 40).join(', ') || 'none'}; journeys ${map.journeys.map((j) => `${j.name} at ${j.start}`).join('; ') || 'none'}.`,
    personas.length ? `Test personas (refer to them by name only, never write credentials): ${personas.join(', ')}.` : '',
    'Return ONLY a JSON array. Each item: {"title": "what the flow proves", "start": "/path", "account": "persona name or omit", "steps": ["plain English steps using the visible labels"], "expect": ["what must be true at the end"], "tags": ["product area"]}',
    FLOW_RULES,
  ]
    .filter(Boolean)
    .join('\n');
  const res = await agent.ask(prompt, project.root);
  if (!res.ok) return [];
  const items = extractJson<any[]>(res.output) ?? [];
  return items
    .filter((f) => f?.title && Array.isArray(f.steps) && Array.isArray(f.expect))
    .map(
      (f): FlowDraft => ({
        title: String(f.title),
        type: 'happy',
        start: f.start ? String(f.start) : '/',
        account: f.account && project.config.personas[f.account] ? String(f.account) : undefined,
        source: 'gremlin init',
        tags: (f.tags ?? []).map((t: unknown) => String(t).toLowerCase()),
        steps: f.steps.map(String),
        expect: f.expect.map(String),
      }),
    )
    .filter((f) => !lintFlow(f).some((i) => i.level === 'error') && !flowSafetyIssues(f).length)
    .slice(0, max);
}
