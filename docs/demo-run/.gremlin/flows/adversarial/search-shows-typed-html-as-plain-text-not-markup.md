---
title: Search shows typed HTML as plain text, not markup
type: adversarial
platforms:
  - web
start: /
source: breaker
status: confirmed
tags:
  - search
  - input
attack: input.html-in-search
bug: BUG-004
fail_first: RUN-20261118-165300-56e7c1
created: 2026-11-18T11:23:00.813Z
---

1. Type "<s>mug</s>" into the Search box
2. Click "Search"

## Expect

- The results heading shows the text <s>mug</s> literally, with the angle brackets visible
- No text in the results heading is struck through

## Notes

Breaker's suspicion: pages.search (server.js:248) puts the raw query into <h1>Results for “${q}”</h1> without the esc() helper used everywhere else. Any HTML in the search box is rendered, which is a reflected XSS through the GET /search?q= link.
