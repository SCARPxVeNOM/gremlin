---
mode: testing
url: http://localhost:4000/
max_steps: 40
tags: [search, input]
---

# Search shows typed HTML as plain text, not markup

<!-- compiled by gremlin from .gremlin/flows/adversarial/search-shows-typed-html-as-plain-text-not-markup.md (cd79f235d03149e1). Edit the flow, not this file. -->

## Step 1: Type <s>mug</s> into the Search box
Start on http://localhost:4000/. Type "<s>mug</s>" into the Search box.

## Step 2: Click Search
Click "Search".

## Check the expected outcome
Verify that the results heading shows the text <s>mug</s> literally, with the angle brackets visible.
Verify that no text in the results heading is struck through.
