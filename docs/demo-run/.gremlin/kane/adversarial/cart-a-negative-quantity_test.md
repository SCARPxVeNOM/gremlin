---
mode: testing
url: http://localhost:4000/product/ash-glaze-mug
max_steps: 40
tags: [cart, input, money]
---

# Cart: a negative quantity

<!-- compiled by gremlin from .gremlin/flows/adversarial/cart-a-negative-quantity.md (9e898efb5ffeed1b). Edit the flow, not this file. -->

## Step 1: Open any product and add it to the cart
Open any product and add it to the cart.

## Step 2: Change the quantity of an item in the cart to -3 and apply the…
Change the quantity of an item in the cart to -3 and apply the change.

## Check the expected outcome
Verify that A negative quantity is rejected or corrected to a valid number.
Verify that no price or total is shown as a negative amount.
