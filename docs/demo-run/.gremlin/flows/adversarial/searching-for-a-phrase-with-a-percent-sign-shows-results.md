---
title: Searching for a phrase with a percent sign shows results
type: adversarial
platforms:
  - web
start: /
source: breaker
status: confirmed
tags:
  - search
  - input
attack: input.percent-in-search
bug: BUG-003
fail_first: RUN-20261118-164132-5f61a3
created: 2026-11-18T11:11:32.040Z
---

1. Type "100% stoneware" into the Search box
2. Click "Search"

## Expect

- A results page is shown with a heading that includes "100% stoneware"
- The page says nothing matched or lists products
- No message says "Something went wrong"

## Notes

Breaker's suspicion: server.js:367 calls decodeURIComponent on url.searchParams.get('q'), which URLSearchParams has already decoded. A literal '%' not followed by two hex digits throws URIError: URI malformed, and the catch at server.js:379-384 turns that into the 500 'Something went wrong' page.
