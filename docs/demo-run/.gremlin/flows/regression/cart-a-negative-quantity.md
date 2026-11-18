---
title: "Cart: a negative quantity"
type: regression
platforms:
  - web
start: /product/ash-glaze-mug
source: breaker
status: active
tags:
  - cart
  - input
  - money
attack: input.negative
bug: BUG-002
fail_first: RUN-20261118-165504-ad56ea
created: 2026-11-18T11:25:04.435Z
---

1. Open any product and add it to the cart.
2. Change the quantity of an item in the cart to -3 and apply the change.

## Expect

- A negative quantity is rejected or corrected to a valid number
- No price or total is shown as a negative amount
