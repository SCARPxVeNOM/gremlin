---
title: "Cart: pressing back and forward mid-flow"
type: adversarial
platforms:
  - web
start: /product/ash-glaze-mug
source: breaker
status: active
tags:
  - cart
  - navigation
attack: navigation.back-mid-flow
created: 2026-11-18T11:30:08.940Z
---

1. Click the "Add to cart" button for the Ash Glaze Mug
2. Click "View cart", then click "Checkout"
3. On the Checkout page, type "Test Shopper" in Full name and "shopper@example.test" in Email, and leave the other fields empty
4. Press the browser back button, then press the browser forward button to return to the Checkout page
5. If Full name or Email is now empty, type "Test Shopper" in Full name and "shopper@example.test" in Email again
6. Type "1 Test Street" in Address and "Testville" in City
7. Click "Place order"

## Expect

- An "Order confirmed" page is shown with the heading "Thank you, Test Shopper!"
- The page shows an order number and a "Total paid" amount
- No error page, stack trace, blank screen or "Something went wrong" message is visible

## Notes

Revised after Kane's triage of RUN-20261118-170008-1b77e6: Gave Kane exact checkout labels and @example.test values for the partial fill, and had the flow finish the order after back and forward so that "the user can finish the flow" is checked on the confirmation page.
