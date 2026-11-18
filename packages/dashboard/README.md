# @gremlin/dashboard

The local dashboard that `gremlin dash` serves: Vite, React 19, Tailwind v4 and shadcn/ui.

`npm run build` writes into `packages/gremlin/dist/dashboard`, where the CLI's server picks it up.
For development, run `gremlin dash` in a project and `npm run dev` here: Vite proxies `/api` to port 4777.
