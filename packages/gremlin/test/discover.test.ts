import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ATTACKS } from '../src/core/attacks.ts';
import { mapProduct, parsePage, type PageInfo } from '../src/core/discover.ts';

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'gremlin-spa-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

/** Serve the same HTML on every path, the way a Vite dev server serves an SPA's shell. */
async function serve(html: string) {
  const server = createServer((_, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

const fieldsOf = (page?: PageInfo) => page?.forms.flatMap((f) => f.fields);

// Shaped like IT Tools: a Vue 3 + Vite SPA whose tools are routes in src/tools/<name>/index.ts
const SHELL =
  '<!doctype html><html><head><title>IT Tools - Handy online tools for developers</title></head><body><div id="app"></div><script type="module" src="/src/main.ts"></script></body></html>';

const tool = (slug: string, file: string) => `import { defineTool } from '../tool';
import { translate } from '@/plugins/i18n.plugin';

export const tool = defineTool({
  name: translate('tools.${slug}.title'),
  path: '/${slug}',
  description: translate('tools.${slug}.description'),
  keywords: ['${slug.split('-').join("', '")}'],
  component: () => import('./${file}'),
  createdAt: new Date('2023-06-18'),
});
`;

const IT_TOOLS: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'it-tools',
    scripts: { dev: 'vite' },
    dependencies: { vue: '^3.5.0', 'vue-router': '^4.4.0', 'naive-ui': '^2.40.0' },
    devDependencies: { vite: '^5.4.0' },
  }),
  'index.html': SHELL,
  'src/main.ts': "import { createApp } from 'vue';\nimport App from './App.vue';\nimport { router } from './router';\n\ncreateApp(App).use(router).mount('#app');\n",
  'src/App.vue': `<script setup lang="ts">
import BaseLayout from './layouts/base.layout.vue';
</script>

<template>
  <n-config-provider>
    <base-layout>
      <router-view />
    </base-layout>
  </n-config-provider>
</template>
`,
  // components are auto-registered, so the layout uses <command-palette /> without importing it
  'src/layouts/base.layout.vue': `<script setup lang="ts">
import { useI18n } from 'vue-i18n';
</script>

<template>
  <n-layout has-sider>
    <n-layout-header>
      <command-palette />
      <c-select v-model:value="locale" :options="localeOptions" placeholder="Select a language" />
    </n-layout-header>
    <slot />
  </n-layout>
</template>
`,
  'src/modules/command-palette/command-palette.vue': `<template>
  <c-button @click="isModalOpen = true">{{ $t('search.label') }} + K</c-button>
  <c-modal v-model:open="isModalOpen" class="palette-modal">
    <c-input-text ref="inputRef" v-model:value="searchPrompt" raw-text placeholder="Type to search a tool or a command..." autofocus clearable />
  </c-modal>
</template>
`,
  'src/router.ts': `import { createRouter, createWebHistory } from 'vue-router';
import HomePage from './pages/Home.page.vue';
import NotFound from './pages/404.page.vue';
import { tools } from './tools';

const toolsRoutes = tools.map(({ path, name, component, ...config }) => ({ path, name, component, meta: { isTool: true, name, ...config } }));

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: HomePage },
    { path: '/about', name: 'about', component: () => import('./pages/About.vue') },
    ...toolsRoutes,
    { path: '/:pathMatch(.*)*', name: 'NotFound', component: NotFound },
  ],
});
`,
  'src/pages/Home.page.vue': '<template>\n  <div class="home">\n    <h1>IT Tools</h1>\n    <p>Handy online tools for developers</p>\n  </div>\n</template>\n',
  'src/pages/About.vue': '<template>\n  <div><h2>About</h2><p>Made with love.</p></div>\n</template>\n',
  'src/pages/404.page.vue': '<template>\n  <div><h1>404 Not Found</h1><c-button to="/">Back home</c-button></div>\n</template>\n',
  'src/tools/tool.ts': 'export function defineTool<T>(tool: T): T {\n  return tool;\n}\n',
  'src/tools/index.ts': [
    "import { tool as jsonToCsv } from './json-to-csv';",
    "import { tool as tokenGenerator } from './token-generator';",
    "import { tool as bcrypt } from './bcrypt';",
    "import { tool as httpStatusCodes } from './http-status-codes';",
    '',
    'export const tools = [jsonToCsv, tokenGenerator, bcrypt, httpStatusCodes];',
    '',
  ].join('\n'),
  'src/tools/json-to-csv/index.ts': tool('json-to-csv', 'json-to-csv.vue'),
  'src/tools/json-to-csv/json-to-csv.vue': `<script setup lang="ts">
import { convertArrayToCsv } from './json-to-csv.service';

// markup inside the script is not a field
const example = '<input name="decoy" placeholder="Not a field">';
function transformer(value: string) {
  return convertArrayToCsv({ array: JSON.parse(value) });
}
</script>

<template>
  <format-transformer
    input-label="Your raw JSON"
    input-placeholder="Paste your raw JSON here..."
    output-label="CSV version of your JSON"
    :transformer="transformer"
  />
</template>
`,
  'src/tools/json-to-csv/json-to-csv.e2e.spec.ts':
    "import { test } from '@playwright/test';\n\ntest('json-to-csv', async ({ page }) => {\n  await page.goto('/json-to-csv');\n  await page.fill('textarea', '<input name=\"spec\">');\n});\n",
  'src/tools/token-generator/index.ts': tool('token-generator', 'token-generator.tool.vue'),
  'src/tools/token-generator/token-generator.tool.vue': `<template>
  <c-card>
    <n-form label-placement="left" label-width="140">
      <n-form-item :label="t('tools.token-generator.uppercase')">
        <n-switch v-model:value="withUppercase" />
      </n-form-item>
      <n-form-item :label="\`Length (\${length})\`">
        <n-slider v-model:value="length" :step="1" :min="1" :max="512" />
      </n-form-item>
    </n-form>
    <c-input-text v-model:value="token" multiline :placeholder="t('tools.token-generator.tokenPlaceholder')" readonly rows="3" />
    <c-button @click="refreshToken">{{ t('tools.token-generator.button.refresh') }}</c-button>
  </c-card>
</template>
`,
  'src/tools/bcrypt/index.ts': tool('bcrypt', 'bcrypt.vue'),
  'src/tools/bcrypt/bcrypt.vue': `<template>
  <c-card title="Hash">
    <c-input-text v-model:value="input" label="Your string: " placeholder="Your string to bcrypt..." raw-text />
    <n-form-item label="Salt count: " label-placement="left" label-width="120">
      <n-input-number v-model:value="saltCount" placeholder="Salt rounds..." :max="100" :min="0" w-full />
    </n-form-item>
    <input-copyable label="Hashed string:" :value="hashed" readonly />
  </c-card>
  <c-card title="Compare string with hash">
    <n-form label-width="120">
      <n-form-item label="Your string: " label-placement="left">
        <c-input-text v-model:value="compareString" placeholder="Your string to compare..." raw-text />
      </n-form-item>
      <n-form-item label="Your hash: " label-placement="left">
        <c-input-text v-model:value="compareHash" placeholder="Your hash to compare..." raw-text />
      </n-form-item>
    </n-form>
  </c-card>
</template>
`,
  'src/tools/http-status-codes/index.ts': tool('http-status-codes', 'http-status-codes.vue'),
  'src/tools/http-status-codes/http-status-codes.vue': `<template>
  <div>
    <c-input-text v-model:value="search" placeholder="Search http status..." autofocus raw-text mb-10 />
    <div v-for="{ codes, category } of codesByCategoryFiltered" :key="category" mb-8>
      <div mb-2 text-xl>{{ category }}</div>
    </div>
  </div>
</template>
`,
  // the input kit and generic wrappers are not routes: their uses above are the fields
  'src/ui/c-input-text/c-input-text.vue': `<template>
  <div class="c-input-text">
    <label v-if="label" :for="id">{{ label }}</label>
    <textarea v-if="multiline" :id="id" v-model="value" :placeholder="placeholder" />
    <input v-else :id="id" v-model="value" :type="type" :placeholder="placeholder">
  </div>
</template>
`,
  'src/components/FormatTransformer.vue':
    '<template>\n  <c-input-text v-model:value="input" :label="inputLabel" :placeholder="inputPlaceholder" multiline />\n  <textarea-copyable :value="output" />\n</template>\n',
  'src/components/InputCopyable.vue': '<template>\n  <c-input-text v-model:value="value">\n    <template #suffix><c-button @click="copy()">Copy</c-button></template>\n  </c-input-text>\n</template>\n',
};

test('a Vue SPA served as an empty shell is mapped from its components: routes, fields and journeys', async (t) => {
  const root = fixture(IT_TOOLS);
  const app = await serve(SHELL);
  t.after(app.close);

  // what the crawl alone sees: one shell per route, no forms
  assert.deepEqual(parsePage(SHELL, '/json-to-csv').forms, []);

  const map = await mapProduct(root, app.url, true);
  const page = (path: string) => map.pages.find((p) => p.path === path);

  assert.deepEqual(fieldsOf(page('/json-to-csv')), [{ label: 'Your raw JSON', type: 'text', required: false }]);
  assert.deepEqual(fieldsOf(page('/bcrypt')), [
    { label: 'Your string', type: 'text', required: false },
    { label: 'Salt count', type: 'number', required: false }, // from the <n-form-item> around it
    { label: 'Your string', type: 'text', required: false },
    { label: 'Your hash', type: 'text', required: false },
  ]);
  assert.deepEqual(fieldsOf(page('/http-status-codes')), [{ label: 'Search http status...', type: 'text', required: false }]);
  // the read-only token box is output, not input; the i18n button still gets a name
  assert.deepEqual(page('/token-generator')?.forms, []);
  assert.deepEqual(page('/token-generator')?.buttons, ['Refresh']);
  // the layout is on every page, so it belongs to the home page; of its chrome only the search box counts, not the language picker
  assert.equal(page('/')?.heading, 'IT Tools');
  assert.deepEqual(page('/')?.forms, [{ fields: [{ label: 'Type to search a tool or a command...', type: 'text', required: false }], submit: undefined }]);

  const labels = map.pages.flatMap((p) => fieldsOf(p) ?? []).map((f) => f.label);
  assert.ok(!labels.some((l) => /decoy|not a field|value|spec/i.test(l)), `no fields from scripts, tests or the input kit: ${labels.join(', ')}`);
  assert.equal(page('/')?.title, undefined, "the shell's title is the same on every route, so it is dropped");

  assert.deepEqual(
    map.journeys.map((j) => [j.key, j.start]),
    [
      ['search', '/'],
      ['form', '/bcrypt'],
    ],
  );

  // the catalogue now has fields to aim at
  const form = map.journeys.find((j) => j.key === 'form')!;
  const aimed = ATTACKS.filter((a) => a.applies(form)).map((a) => a.id);
  for (const id of ['input.empty', 'input.long', 'input.negative', 'timing.double-submit', 'accessibility.labels']) assert.ok(aimed.includes(id), `${id} applies`);
  assert.match(ATTACKS.find((a) => a.id === 'input.negative')!.build(form).steps.join(' '), /Change the "Salt count" field to -3/);
});

test('a React Router SPA maps from source even when the app is not running', async () => {
  const root = fixture({
    'package.json': JSON.stringify({ dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0', 'react-router-dom': '^7.0.0' }, devDependencies: { vite: '^6.0.0' } }),
    'index.html': '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
    'src/main.tsx': "import { createRoot } from 'react-dom/client';\nimport App from './App';\n\ncreateRoot(document.getElementById('root')!).render(<App />);\n",
    'src/App.tsx': `import { lazy } from 'react';
import { Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import Home from './pages/Home';
import { Profile } from './pages/settings/Profile';
import RequireAuth from './components/RequireAuth';

const Login = lazy(() => import('./pages/Login'));

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Home />} />
      </Route>
      <Route path="/login" element={<Login />} />
      <Route
        path="/settings/profile"
        element={
          <RequireAuth>
            <Profile />
          </RequireAuth>
        }
      />
    </Routes>
  );
}
`,
    'src/components/Layout.tsx': `import { Outlet } from 'react-router-dom';
import SearchBox from './SearchBox';

export default function Layout() {
  return (
    <div>
      <header>
        <SearchBox />
      </header>
      <Outlet />
    </div>
  );
}
`,
    'src/components/SearchBox.tsx': `import { useNavigate } from 'react-router-dom';

export default function SearchBox() {
  const go = useNavigate();
  return <input type="search" aria-label="Search products" onKeyDown={(e) => e.key === 'Enter' && go(\`/search?q=\${e.currentTarget.value}\`)} />;
}
`,
    'src/components/RequireAuth.tsx': `import { Navigate } from 'react-router-dom';

export default function RequireAuth({ children }: { children: JSX.Element }) {
  return isLoggedIn() ? children : <Navigate to="/login" />;
}
`,
    'src/pages/Home.tsx': `export default function Home() {
  return (
    <section>
      <h1>Welcome to Kiln</h1>
      <button onClick={() => addToCart(featured)}>Add to cart</button>
    </section>
  );
}
`,
    'src/pages/Login.tsx': `import { useState } from 'react';
import { TextField } from '@mui/material';
import { useTranslation } from 'react-i18next';

export default function Login() {
  const { t } = useTranslation();
  const [email, setEmail] = useState<string>('');
  const [show, setShow] = useState(false);
  return (
    <form onSubmit={(e) => { e.preventDefault(); signIn(email); }}>
      <label htmlFor="email">Email address</label>
      <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      <TextField label="Password" type="password" required />
      {/* <input placeholder="Remember me" /> */}
      <button type="button" onClick={() => setShow((s) => !s)}>Show</button>
      <button type="submit">{t('auth.signIn')}</button>
    </form>
  );
}
`,
    'src/pages/settings/Profile.tsx': `import ProfileForm from '../../components/ProfileForm';

export function Profile() {
  return (
    <main>
      <h1>Your profile</h1>
      <ProfileForm />
    </main>
  );
}
`,
    'src/components/ProfileForm.tsx': `import { useForm } from 'react-hook-form';
import { Input } from '@/components/ui/input';
import { FormItem, FormLabel } from '@/components/ui/form';

export default function ProfileForm({ user }: { user: { id: string } }) {
  const { register, handleSubmit } = useForm<ProfileValues>();
  return (
    <form onSubmit={handleSubmit(save)}>
      <FormItem>
        <FormLabel>Display name</FormLabel>
        <Input {...register('displayName')} />
      </FormItem>
      <Input placeholder="Website" type="url" />
      <Input readOnly value={user.id} />
      <Button type="submit">Save changes</Button>
    </form>
  );
}
`,
    'src/components/ui/input.tsx': `import { forwardRef } from 'react';

export const Input = forwardRef<HTMLInputElement, InputProps>(({ className, type, ...props }, ref) => (
  <input type={type} className={cn('rounded border', className)} ref={ref} {...props} />
));
`,
    // imported nowhere: placed by folder name, or left out when no route is close
    'src/features/login/MagicLinkForm.tsx': `export function MagicLinkForm() {
  return (
    <form method="post">
      <input type="email" name="email" placeholder="Work email" required />
      <button>Email me a link</button>
    </form>
  );
}
`,
    'src/components/NewsletterSignup.tsx': 'export default function NewsletterSignup() {\n  return <input type="email" aria-label="Newsletter email" />;\n}\n',
  });

  const map = await mapProduct(root, 'http://127.0.0.1:9', false);
  const page = (path: string) => map.pages.find((p) => p.path === path);

  assert.deepEqual(
    map.pages.map((p) => p.path),
    ['/', '/login', '/settings/profile'],
  );
  assert.deepEqual(fieldsOf(page('/')), [{ label: 'Search products', type: 'search', required: false }]);
  assert.equal(page('/')?.heading, 'Welcome to Kiln');
  assert.deepEqual(page('/')?.buttons, ['Add to cart']);
  assert.deepEqual(page('/login')?.forms, [
    {
      fields: [
        { label: 'Email address', type: 'email', required: true },
        { label: 'Password', type: 'password', required: true },
      ],
      submit: 'Sign in',
    },
    { fields: [{ label: 'Work email', type: 'email', required: true }], submit: 'Email me a link' },
  ]);
  assert.deepEqual(page('/settings/profile')?.forms, [
    {
      fields: [
        { label: 'Display name', type: 'text', required: false },
        { label: 'Website', type: 'url', required: false },
      ],
      submit: 'Save changes',
    },
  ]);
  assert.ok(!map.pages.some((p) => fieldsOf(p)?.some((f) => /newsletter/i.test(f.label))), 'a component no route is close to is left out');

  assert.deepEqual(
    map.journeys.map((j) => [j.key, j.start, j.fields.length]),
    [
      ['search', '/', 1],
      ['cart', '/', 0],
      ['login', '/login', 2],
      ['settings', '/settings/profile', 2],
    ],
  );
});

test('a server-rendered app whose crawl finds fields is mapped from the crawl alone', async (t) => {
  const root = fixture({
    'package.json': JSON.stringify({ scripts: { start: 'node server.js' }, dependencies: { express: '^5.0.0' } }),
    'server.js': "const app = require('express')();\napp.get('/search', (req, res) => res.send('results'));\napp.listen(4000);\n",
    'src/search/Advanced.jsx': 'export default () => <input placeholder="From source" />;\n',
  });
  const app = await serve('<html><title>Shop</title><h1>Search</h1><form action="/search"><input type="search" name="q" aria-label="Search the shop"><button>Search</button></form></html>');
  t.after(app.close);

  const map = await mapProduct(root, app.url, true);
  assert.deepEqual(
    map.pages.map((p) => p.path),
    ['/', '/search'],
  );
  assert.deepEqual(fieldsOf(map.pages[0]), [{ label: 'Search the shop', type: 'search', required: false }]);
  assert.ok(!map.pages.some((p) => fieldsOf(p)?.some((f) => f.label === 'From source')));
});
