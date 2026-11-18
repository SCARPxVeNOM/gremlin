---
mode: testing
url: http://localhost:4000/product/ash-glaze-mug
max_steps: 40
tags: [cart, navigation]
---

# Cart: pressing back and forward mid-flow

<!-- compiled by gremlin from .gremlin/flows/adversarial/cart-pressing-back-and-forward-mid-flow.md (dfd074acbd62c8f8). Edit the flow, not this file. -->

## Step 1: Click the Add to cart button for the Ash Glaze Mug
Start on http://localhost:4000/product/ash-glaze-mug. Click the "Add to cart" button for the Ash Glaze Mug.

## Step 2: Click View cart, then click Checkout
Click "View cart", then click "Checkout".

## Step 3: On the Checkout page, type Test Shopper in Full name and shoppe…
On the Checkout page, type "Test Shopper" in Full name and "shopper@example.test" in Email, and leave the other fields empty.

## Step 4: Press the browser back button, then press the browser forward b…
Press the browser back button, then press the browser forward button to return to the Checkout page.

## Step 5: If Full name or Email is now empty, type Test Shopper in Full n…
If Full name or Email is now empty, type "Test Shopper" in Full name and "shopper@example.test" in Email again.

## Step 6: Type 1 Test Street in Address and Testville in City
Type "1 Test Street" in Address and "Testville" in City.

## Step 7: Click Place order
Click "Place order".

## Check the expected outcome
Verify that an "Order confirmed" page is shown with the heading "Thank you, Test Shopper!".
Verify that the page shows an order number and a "Total paid" amount.
Verify that no error page, stack trace, blank screen or "Something went wrong" message is visible.
