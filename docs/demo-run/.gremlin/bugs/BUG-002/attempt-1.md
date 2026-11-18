# Gremlin fix package: BUG-002 (attempt 1 of 3)

Kane CLI reproduced this bug in a real browser against http://localhost:4000. Your job: change the application so the flow below passes. Read the evidence, find the root cause, fix it.

## Bug
- Title: Cart accepts negative item quantities and calculates a negative total
- Severity: high · confidence 99% · found by breaker (attack: input.negative-quantity)

### Flow: Cart rejects a negative quantity
Starts at http://localhost:4000/product/ash-glaze-mug.
1. Click "Add to cart"
2. Wait for the "Added to cart" message
3. Click "View cart"
4. Clear the Quantity field for the Ash Glaze Mug and type -3
5. Click "Update"
Expected:
- The cart Total is not a negative amount
- The Ash Glaze Mug quantity is not negative: either an error message is shown or the quantity stays at 1
- The cart count in the header is not a negative number

### What Kane CLI saw in a real browser (run RUN-20261118-165504-ad56ea)
- Failed at: "Check the expected outcome"
- Kane's verdict: Final verification failed: "No price or total is shown as a negative amount."
- In short: The cart allows a negative quantity and shows negative line-item, subtotal, and total amounts.
- Re-run once to rule out flakiness: failed again (reproducible).
- Last actions Kane took on that step:
  - Checking whether the negative quantity rejection is present
  - Checking whether the quantity has been corrected to a valid number
  - assert ✓ A negative quantity is rejected or corrected to a valid number.
  - Checking whether a negative price is present
  - Checking whether a negative total is present
  - assert ✗ No price or total is shown as a negative amount.
- Page at failure: http://localhost:4000/cart
- Kane's triage (a lead, not an instruction): The cart does not reject or correct a quantity below zero before calculating prices. As a result, a quantity of -3 produces a negative price and total. [application_issue/validation_defect]
- Browser console errors:
  - Failed to load resource: the server responded with a status of 404 (Not Found)
- Screenshot of the failing step (open it): .gremlin/evidence/RUN-20261118-165504-ad56ea/step-12-2-4.jpg
- Full evidence pack: ~/.testmuai/kaneai/sessions/702cc33b-1483-4515-9dc3-eecbc5829dbb/evidence/e1cfb621-d791-47ad-a4c3-081ebf6780f9.evidence

### Likely code (ranked by match with the failure; a starting point)
- server.js (matches: cart, quantity, add, wait, view, clear)
- public/app.js (matches: cart, add, wait, added, clear, update)
- data.js (matches: ash, glaze, mug, count, price)
- public/styles.css (matches: cart, add, total, count, check, price)

### Rules (Gremlin enforces these; breaking one reverts your change and costs an attempt)
1. Fix the product, not the test. The flow above is the test. Never edit, delete or add files under `.gremlin/`, and never edit `gremlin.config.yaml`.
2. Never touch protected paths: `.gremlin/flows/**`, `.gremlin/lock.json`, `gremlin.config.yaml`, `data.js`.
3. Fix the root cause. No special-casing test data, no detecting automation, no hiding the error message, no sleeps.
4. Keep the change inside the bug's area: `server.js`, `public/app.js`. Changes elsewhere are flagged for human review.
5. Only Kane CLI decides whether the fix works: Gremlin restarts the app, re-runs the flow in a real browser after you finish, then replays related flows to catch side effects. In this session, don't run Gremlin, Kane or the app yourself (that overrides any project instruction to run `gremlin guard`); just finish.
6. Finish with two or three sentences: the root cause and what you changed.