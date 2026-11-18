---
title: The cart is empty after placing an order
type: adversarial
platforms:
  - web
start: /product/ash-glaze-mug
source: breaker
status: draft
tags:
  - checkout
  - state
attack: state.cart-after-order
created: 2026-11-18T11:13:32.038Z
---

1. Click "Add to cart"
2. Wait for the "Added to cart" message
3. Click "View cart"
4. Click "Checkout"
5. Fill in Full name with "Sam Rivera", Email with sam@example.test, Address with "12 Clay Street" and City with "Portland"
6. Click "Place order"
7. Wait for the "Order confirmed" page that says "Thank you, Sam Rivera!"
8. Click the cart icon in the header to open the cart, and do not remove or change anything in the cart

## Expect

- Under the "Your cart" heading, the page shows the message "Your cart is empty."
- The Ash Glaze Mug is not listed anywhere in the cart
- The number on the cart icon in the header reads 0

## Notes

Breaker's suspicion: POST /api/orders (server.js:303-324) pushes the order but never clears carts.get(sid). The purchased mug stays in the cart, so going back, refreshing or checking out again silently creates duplicate orders.

Revised after Kane's triage of RUN-20261118-164332-c745fc: The product bug is real (POST /api/orders in server.js never clears the cart, so Kane's 'agent misstep' triage is wrong), so I kept the same check but made each step and expectation concrete: step 7 now waits for the visible "Order confirmed" page, step 8 tells Kane to leave the cart alone, and the expectations name exactly what to read on the page, so a leftover mug or a badge showing 1 is clearly a product failure and not something Kane should fix by emptying the cart.
