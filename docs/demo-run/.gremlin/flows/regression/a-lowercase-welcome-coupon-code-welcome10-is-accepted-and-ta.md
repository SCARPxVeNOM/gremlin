---
title: A lowercase welcome coupon code (welcome10) is accepted and takes 10% off
type: regression
platforms:
  - web
start: /product/ash-glaze-mug
source: capture:paste
status: active
tags:
  - checkout
  - coupon
bug: BUG-005
fail_first: RUN-20261118-170700-80b75b
created: 2026-11-18T11:37:00.439Z
---

1. Click "Add to cart"
2. Go to the checkout page
3. Type welcome10 (all lowercase) into the "Coupon code" field and click "Apply"

## Expect

- The message "That coupon code is not valid." is not shown
- A message says the 10% welcome discount was applied
- The order summary shows a discount of $2.80

## Notes

Captured from paste:
> Hi Kiln team, I'm Priya Sharma ([redacted-email], [redacted-phone]). I typed welcome10 into the coupon box at checkout but it just says "That coupon code is not valid". The code from your welcome email should work!
