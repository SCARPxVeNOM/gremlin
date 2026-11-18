---
title: 'Search: special characters like "100%" and markup'
type: adversarial
platforms:
  - web
start: /
source: breaker
status: confirmed
tags:
  - search
  - input
attack: input.special
bug: BUG-003
fail_first: RUN-20261118-165759-7f706d
created: 2026-11-18T11:27:59.130Z
---

1. Go to /.
2. Search for "100% <b>off</b>".

## Expect

- A results page loads, even if it shows no results
- The search text is shown as plain text, not formatted
- No error page, stack trace, blank screen or "something went wrong" message appears
