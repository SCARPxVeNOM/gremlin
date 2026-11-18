---
mode: testing
url: http://localhost:4000/
max_steps: 40
tags: [search, input]
---

# Searching for a phrase with a percent sign shows results

<!-- compiled by gremlin from .gremlin/flows/adversarial/searching-for-a-phrase-with-a-percent-sign-shows-results.md (4fd7b1543b5deb06). Edit the flow, not this file. -->

## Step 1: Type 100% stoneware into the Search box
Start on http://localhost:4000/. Type "100% stoneware" into the Search box.

## Step 2: Click Search
Click "Search".

## Check the expected outcome
Verify that A results page is shown with a heading that includes "100% stoneware".
Verify that the page says nothing matched or lists products.
Verify that no message says "Something went wrong".
