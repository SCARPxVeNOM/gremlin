import type { FieldInfo, Journey } from './discover.ts';

export type AttackCategory = 'input' | 'timing' | 'navigation' | 'state' | 'environment' | 'accessibility' | 'permission';

export interface AttackFlow {
  title: string;
  start: string;
  steps: string[];
  expect: string[];
  tags: string[];
}

export interface Attack {
  id: string;
  category: AttackCategory;
  name: string;
  /** Prior belief that this attack finds real bugs, before Gremlin has learned from this product. */
  prior: number;
  applies(j: Journey): boolean;
  build(j: Journey): AttackFlow;
}

const isText = (f: FieldInfo) => ['text', 'textarea', 'email', 'search', 'tel', 'url'].includes(f.type);
const nameField = (j: Journey) => j.fields.find((f) => /name/i.test(f.label) && isText(f)) ?? j.fields.find(isText);
const codeField = (j: Journey) => j.fields.find((f) => /coupon|promo|code|voucher|discount|email|user ?name/i.test(f.label));
const qtyField = (j: Journey) => j.fields.find((f) => f.type === 'number' || /qty|quantity|amount|count/i.test(f.label));
const submitOf = (j: Journey) => j.submit ?? (j.key === 'checkout' ? 'Place order' : j.key === 'search' ? 'Search' : 'Submit');

function reach(j: Journey): string {
  switch (j.key) {
    case 'checkout':
      return 'Add any product to the cart and go to checkout';
    case 'cart':
      return 'Open any product and add it to the cart';
    case 'search':
      return `Go to ${j.start}`;
    case 'login':
    case 'signup':
      return `Go to the ${j.name.toLowerCase()} page`;
    default:
      return `Go to ${j.start}`;
  }
}

const fillRest = 'fill every other required field with ordinary valid values';
const noCrash = 'No error page, stack trace, blank screen or "something went wrong" message appears';

export const ATTACKS: Attack[] = [
  // ----- input abuse
  {
    id: 'input.empty',
    category: 'input',
    name: 'Empty submit',
    prior: 0.25,
    applies: (j) => j.fields.some((f) => f.required) || ['checkout', 'signup', 'login', 'contact', 'form'].includes(j.key),
    build: (j) => ({
      title: `${j.name}: submitting an empty form is handled`,
      start: j.start,
      steps: [`${reach(j)}.`, `Leave every field empty and press "${submitOf(j)}".`],
      expect: ['The app tells the user which information is missing', 'Nothing is submitted or created', noCrash],
      tags: [j.key, 'input'],
    }),
  },
  {
    id: 'input.emoji',
    category: 'input',
    name: 'Emoji and RTL text',
    prior: 0.4,
    applies: (j) => Boolean(nameField(j)) && j.key !== 'search',
    build: (j) => {
      const f = nameField(j)!;
      return {
        title: `${j.name}: emoji and right-to-left text in "${f.label}"`,
        start: j.start,
        steps: [`${reach(j)}.`, `Type "Zoë 🦄 李 مرحبا" into the "${f.label}" field, ${fillRest}, and press "${submitOf(j)}".`],
        expect: ['The app accepts the text or explains politely which characters are allowed', noCrash],
        tags: [j.key, 'input', 'i18n'],
      };
    },
  },
  {
    id: 'input.long',
    category: 'input',
    name: 'Very long text',
    prior: 0.2,
    applies: (j) => j.fields.some(isText),
    build: (j) => {
      const f = nameField(j) ?? j.fields.find(isText)!;
      return {
        title: `${j.name}: a 400-character value in "${f.label}"`,
        start: j.start,
        steps: [`${reach(j)}.`, `Type a 400-character string (the word "gremlin" repeated) into the "${f.label}" field, ${fillRest}, and press "${submitOf(j)}".`],
        expect: ['The app accepts the text or shows a clear length message', 'The page layout stays readable', noCrash],
        tags: [j.key, 'input'],
      };
    },
  },
  {
    id: 'input.whitespace',
    category: 'input',
    name: 'Pasted value with surrounding spaces',
    prior: 0.35,
    applies: (j) => Boolean(codeField(j)),
    build: (j) => {
      const f = codeField(j)!;
      return {
        title: `${j.name}: "${f.label}" pasted with leading and trailing spaces`,
        start: j.start,
        steps: [`${reach(j)}.`, `Enter a valid value in the "${f.label}" field with two spaces before and after it, as if pasted from an email, then continue.`],
        expect: ['The surrounding spaces are ignored and the value is accepted as valid', 'No message says the value is invalid'],
        tags: [j.key, 'input'],
      };
    },
  },
  {
    id: 'input.special',
    category: 'input',
    name: 'Special characters in search',
    prior: 0.35,
    applies: (j) => j.key === 'search',
    build: (j) => ({
      title: 'Search: special characters like "100%" and markup',
      start: j.start,
      steps: [`${reach(j)}.`, 'Search for "100% <b>off</b>".'],
      expect: ['A results page loads, even if it shows no results', 'The search text is shown as plain text, not formatted', noCrash],
      tags: ['search', 'input'],
    }),
  },
  {
    id: 'input.negative',
    category: 'input',
    name: 'Negative and huge quantities',
    prior: 0.4,
    applies: (j) => Boolean(qtyField(j)) || j.key === 'cart',
    build: (j) => {
      const f = qtyField(j);
      const label = f ? `the "${f.label}" field` : 'the quantity of an item in the cart';
      return {
        title: `${j.name}: a negative quantity`,
        start: j.start,
        steps: [`${reach(j)}.`, `Change ${label} to -3 and apply the change.`],
        expect: ['A negative quantity is rejected or corrected to a valid number', 'No price or total is shown as a negative amount'],
        tags: [j.key, 'input', 'money'],
      };
    },
  },
  // ----- timing
  {
    id: 'timing.double-submit',
    category: 'timing',
    name: 'Double submit',
    prior: 0.5,
    applies: (j) => ['checkout', 'signup', 'contact', 'form'].includes(j.key),
    build: (j) => ({
      title: `${j.name}: double-clicking "${submitOf(j)}" creates only one result`,
      start: j.start,
      steps: [
        `${reach(j)}.`,
        `Fill the form with ordinary valid values.`,
        `Double-click "${submitOf(j)}" as fast as possible.`,
        j.key === 'checkout' ? 'Open the page that lists your orders.' : 'Open the page that lists what was created, if there is one.',
      ],
      expect: ['Exactly one new entry was created, not two', 'No error message is visible'],
      tags: [j.key, 'timing'],
    }),
  },
  {
    id: 'timing.rapid-clicks',
    category: 'timing',
    name: 'Rapid clicks',
    prior: 0.25,
    applies: (j) => j.key === 'cart' || j.buttons.some((b) => /add/i.test(b)),
    build: (j) => ({
      title: 'Cart: clicking "Add to cart" five times quickly',
      start: j.start,
      steps: ['Open any product page.', `Click "${j.buttons.find((b) => /add/i.test(b)) ?? 'Add to cart'}" five times as fast as possible.`, 'Open the cart.'],
      expect: ['The cart quantity matches the number of clicks or is clearly limited', 'The cart total equals the quantity times the unit price'],
      tags: ['cart', 'timing', 'money'],
    }),
  },
  // ----- navigation
  {
    id: 'navigation.back-mid-flow',
    category: 'navigation',
    name: 'Back button mid-flow',
    prior: 0.3,
    applies: (j) => ['checkout', 'signup', 'cart'].includes(j.key),
    build: (j) => ({
      title: `${j.name}: pressing back and forward mid-flow`,
      start: j.start,
      steps: [`${reach(j)}.`, 'Fill in part of the form.', 'Press the browser back button, then the forward button.'],
      expect: ['The page is still usable and the user can finish the flow', noCrash],
      tags: [j.key, 'navigation'],
    }),
  },
  {
    id: 'navigation.refresh',
    category: 'navigation',
    name: 'Refresh on a form',
    prior: 0.25,
    applies: (j) => j.fields.length > 0,
    build: (j) => ({
      title: `${j.name}: refreshing the page mid-form`,
      start: j.start,
      steps: [`${reach(j)}.`, 'Fill in the form with ordinary valid values but do not submit it.', 'Refresh the page.'],
      expect: ['The page reloads without errors', 'The user can still complete the flow', 'Nothing was submitted twice'],
      tags: [j.key, 'navigation'],
    }),
  },
  {
    id: 'navigation.deep-link',
    category: 'navigation',
    name: 'Deep link into a later step',
    prior: 0.3,
    applies: (j) => ['checkout', 'cart', 'settings'].includes(j.key) && j.start !== '/',
    build: (j) => ({
      title: `${j.name}: opening ${j.start} directly in a fresh session`,
      start: j.start,
      steps: [`Open ${j.start} directly without visiting any other page first.`],
      expect: ['The app shows a sensible page, such as an empty state or a redirect to the right starting point', noCrash],
      tags: [j.key, 'navigation'],
    }),
  },
  // ----- state
  {
    id: 'state.logged-out',
    category: 'state',
    name: 'Logged out access to a private page',
    prior: 0.3,
    applies: (j) => j.key === 'settings' || j.key === 'login',
    build: (j) => ({
      title: `${j.name}: private pages without being logged in`,
      start: j.key === 'login' ? '/' : j.start,
      steps: [`Without logging in, open ${j.key === 'login' ? 'your account or orders page' : j.start} directly.`],
      expect: ['The app asks the user to log in or shows a friendly message', 'No private data is visible'],
      tags: [j.key, 'state', 'auth'],
    }),
  },
  // ----- accessibility
  {
    id: 'accessibility.keyboard',
    category: 'accessibility',
    name: 'Keyboard only',
    prior: 0.2,
    applies: (j) => ['checkout', 'signup', 'login', 'search', 'cart'].includes(j.key),
    build: (j) => ({
      title: `${j.name}: complete it using only the keyboard`,
      start: j.start,
      steps: [`${reach(j)} using only the keyboard (Tab, Shift+Tab, Enter and Space).`, `Complete the ${j.name.toLowerCase()} using only the keyboard.`],
      expect: ['Every control needed can be reached and used with the keyboard', 'The flow can be completed without a mouse'],
      tags: [j.key, 'accessibility'],
    }),
  },
  {
    id: 'accessibility.labels',
    category: 'accessibility',
    name: 'Missing labels',
    prior: 0.25,
    applies: (j) => j.fields.length > 0,
    build: (j) => ({
      title: `${j.name}: every field has a label`,
      start: j.start,
      steps: [`${reach(j)}.`, 'Look at every form field and icon-only button on the page.'],
      expect: ['Every form field has a visible label or a clear accessible name', 'Every icon-only button has an accessible name'],
      tags: [j.key, 'accessibility'],
    }),
  },
];

export const CATEGORY_LABELS: Record<AttackCategory, string> = {
  input: 'Input abuse',
  timing: 'Timing',
  navigation: 'Navigation',
  state: 'State',
  environment: 'Environment',
  accessibility: 'Accessibility',
  permission: 'Permission',
};
