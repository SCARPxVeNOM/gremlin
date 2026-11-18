---
mode: testing
url: http://localhost:4000/
max_steps: 40
tags: [search, input]
---

# Search: special characters like "100%" and markup

<!-- compiled by gremlin from .gremlin/flows/adversarial/search-special-characters-like-100-and-markup.md (e610c920bb1a309e). Edit the flow, not this file. -->

## Step 1: Go to /
Go to /.

## Step 2: Search for 100% <b>off</b>
Search for "100% <b>off</b>".

## Check the expected outcome
Verify that A results page loads, even if it shows no results.
Verify that the search text is shown as plain text, not formatted.
Verify that no error page, stack trace, blank screen or "something went wrong" message appears.
