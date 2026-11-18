---
mode: testing
url: http://localhost:4000/product/ash-glaze-mug
max_steps: 40
tags: [cart, input]
---

# Cart rejects a negative quantity

<!-- compiled by gremlin from .gremlin/flows/adversarial/cart-rejects-a-negative-quantity.md (68bcb7a6c445edf4). Edit the flow, not this file. -->

## Step 1: Click Add to cart
Start on http://localhost:4000/product/ash-glaze-mug. Click "Add to cart".

## Step 2: Wait for the Added to cart message
Wait for the "Added to cart" message.

## Step 3: Click View cart
Click "View cart".

## Step 4: Clear the Quantity field for the Ash Glaze Mug and type -3
Clear the Quantity field for the Ash Glaze Mug and type -3.

## Step 5: Click Update
Click "Update".

## Check the expected outcome
Verify that the cart Total is not a negative amount.
Verify that the Ash Glaze Mug quantity is not negative: either an error message is shown or the quantity stays at 1.
Verify that the cart count in the header is not a negative number.
