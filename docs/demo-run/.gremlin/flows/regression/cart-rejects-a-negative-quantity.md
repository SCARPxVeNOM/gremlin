---
title: Cart rejects a negative quantity
type: regression
platforms:
  - web
start: /product/ash-glaze-mug
source: breaker
status: active
tags:
  - cart
  - input
attack: input.negative-quantity
bug: BUG-002
fail_first: RUN-20261118-163720-542da1
created: 2026-11-18T11:07:20.058Z
---

1. Click "Add to cart"
2. Wait for the "Added to cart" message
3. Click "View cart"
4. Clear the Quantity field for the Ash Glaze Mug and type -3
5. Click "Update"

## Expect

- The cart Total is not a negative amount
- The Ash Glaze Mug quantity is not negative: either an error message is shown or the quantity stays at 1
- The cart count in the header is not a negative number

## Notes

Breaker's suspicion: POST /api/cart/update (server.js:285-294) only rejects NaN and treats 0 as a removal. Any other parseInt result, including negatives, is stored as-is. The min="1" on the input (server.js:147) is only a browser hint, so subtotal, total and header count go negative (rendered as '$-84.00').
