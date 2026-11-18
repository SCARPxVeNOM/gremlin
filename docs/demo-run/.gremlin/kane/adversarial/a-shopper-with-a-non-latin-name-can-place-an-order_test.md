---
mode: testing
url: http://localhost:4000/product/ash-glaze-mug
max_steps: 40
tags: [checkout, input]
---

# A shopper with a non-Latin name can place an order

<!-- compiled by gremlin from .gremlin/flows/adversarial/a-shopper-with-a-non-latin-name-can-place-an-order.md (ac9eaf8b1779e83a). Edit the flow, not this file. -->

## Step 1: Click Add to cart
Start on http://localhost:4000/product/ash-glaze-mug. Click "Add to cart".

## Step 2: Wait for the Added to cart message
Wait for the "Added to cart" message.

## Step 3: Click View cart
Click "View cart".

## Step 4: Click Checkout
Click "Checkout".

## Step 5: Fill in Full name with Łucja Nowak, Email with lucja@example.te…
Fill in Full name with "Łucja Nowak", Email with lucja@example.test, Address with "12 Clay Street" and City with "Portland".

## Step 6: Click Place order
Click "Place order".

## Check the expected outcome
Verify that an order confirmation page says "Thank you, Łucja Nowak!".
Verify that the confirmation shows an order number.
Verify that no message says "Something went wrong".
