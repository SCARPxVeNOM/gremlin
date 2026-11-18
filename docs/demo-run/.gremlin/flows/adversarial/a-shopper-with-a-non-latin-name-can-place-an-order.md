---
title: A shopper with a non-Latin name can place an order
type: adversarial
platforms:
  - web
start: /product/ash-glaze-mug
source: breaker
status: confirmed
tags:
  - checkout
  - input
attack: input.non-latin-name
bug: BUG-001
fail_first: RUN-20261118-163240-baf87a
created: 2026-11-18T11:02:40.031Z
---

1. Click "Add to cart"
2. Wait for the "Added to cart" message
3. Click "View cart"
4. Click "Checkout"
5. Fill in Full name with "Łucja Nowak", Email with lucja@example.test, Address with "12 Clay Street" and City with "Portland"
6. Click "Place order"

## Expect

- An order confirmation page says "Thank you, Łucja Nowak!"
- The confirmation shows an order number
- No message says "Something went wrong"

## Notes

Breaker's suspicion: server.js:322 puts the raw customer name into the X-Order-Ref response header. Node's setHeader throws ERR_INVALID_CHAR for any character above U+00FF (Ł, CJK, Arabic, emoji). The order has already been pushed at server.js:320, so the shopper sees 'Something went wrong' even though a phantom order exists, and a retry creates a duplicate.
