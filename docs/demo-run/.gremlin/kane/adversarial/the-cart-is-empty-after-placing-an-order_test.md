---
mode: testing
url: http://localhost:4000/product/ash-glaze-mug
max_steps: 40
tags: [checkout, state]
---

# The cart is empty after placing an order

<!-- compiled by gremlin from .gremlin/flows/adversarial/the-cart-is-empty-after-placing-an-order.md (0251bb97e311faf8). Edit the flow, not this file. -->

## Step 1: Click Add to cart
Start on http://localhost:4000/product/ash-glaze-mug. Click "Add to cart".

## Step 2: Wait for the Added to cart message
Wait for the "Added to cart" message.

## Step 3: Click View cart
Click "View cart".

## Step 4: Click Checkout
Click "Checkout".

## Step 5: Fill in Full name with Sam Rivera, Email with sam@example.test,…
Fill in Full name with "Sam Rivera", Email with sam@example.test, Address with "12 Clay Street" and City with "Portland".

## Step 6: Click Place order
Click "Place order".

## Step 7: Wait for the Order confirmed page that says Thank you, Sam Rive…
Wait for the "Order confirmed" page that says "Thank you, Sam Rivera!".

## Step 8: Click the cart icon in the header to open the cart, and do not…
Click the cart icon in the header to open the cart, and do not remove or change anything in the cart.

## Check the expected outcome
Verify that under the "Your cart" heading, the page shows the message "Your cart is empty.".
Verify that the Ash Glaze Mug is not listed anywhere in the cart.
Verify that the number on the cart icon in the header reads 0.
