# Kiln

A tiny ceramics shop: browse, search, add to cart, check out with a coupon, see your orders.
No dependencies.

```bash
npm start     # http://localhost:4000
npm run dev   # same, restarting on every change
```

You don't need to start it for Gremlin: any command that needs the shop starts it (`app.start` in
`gremlin.config.yaml`) and restarts it after an agent changes the code. If you run it yourself, use `npm run dev` so
Kane always sees the latest code.

Routes: `/`, `/product/:slug`, `/cart`, `/checkout`, `/order/:id`, `/orders`, `/search?q=`.
Coupons: `WELCOME10`, `KILN20`.
