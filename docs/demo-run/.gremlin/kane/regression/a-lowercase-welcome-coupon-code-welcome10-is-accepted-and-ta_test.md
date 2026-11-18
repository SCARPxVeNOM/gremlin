---
mode: testing
url: http://localhost:4000/product/ash-glaze-mug
max_steps: 40
tags: [checkout, coupon]
---

# A lowercase welcome coupon code (welcome10) is accepted and takes 10% off

<!-- compiled by gremlin from .gremlin/flows/regression/a-lowercase-welcome-coupon-code-welcome10-is-accepted-and-ta.md (59e33b170d9dd415). Edit the flow, not this file. -->

## Step 1: Click Add to cart
Start on http://localhost:4000/product/ash-glaze-mug. Click "Add to cart".

## Step 2: Go to the checkout page
Go to the checkout page.

## Step 3: Type welcome10 (all lowercase) into the Coupon code field and c…
Type welcome10 (all lowercase) into the "Coupon code" field and click "Apply".

## Check the expected outcome
Verify that the message "That coupon code is not valid." is not shown.
Verify that A message says the 10% welcome discount was applied.
Verify that the order summary shows a discount of $2.80.
