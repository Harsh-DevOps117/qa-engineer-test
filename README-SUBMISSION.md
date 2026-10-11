# Submission Summary

I started by running the API and testing every endpoint with curl. I went through the happy path, negative and type-confusion inputs, security probes (forged signatures, XSS, SQL injection, eavesdropping on Socket.IO rooms) and concurrency, and only then read the code to find the root causes. This found all 7 listed bugs plus 11 more, including a broken seed login, an unsigned e-invoice webhook, payments stored as `NaN`/`Infinity`, and Socket.IO events that were never emitted. All of them are fixed without changing any endpoint, field or event names. Ten further risks need a design decision or a contract change, so I documented them with evidence instead of fixing them (`bug-reports.md` → *Known issues not fixed*). There are 88 automated tests. To check the tests themselves, I put each original route file back and confirmed that every bug A–G makes at least one test fail.

| Deliverable | Where |
|---|---|
| Bug reports (A–G + H–R, known issues) | [`bug-reports.md`](bug-reports.md) |
| Fixes with diffs and rationale | [`fixes.md`](fixes.md) |
| Webhook test plan | [`test-plan.md`](test-plan.md) |
| Tests (88) | `src/routes/__tests__/*.test.js` → `npm test` |
| Webhook signing helper | `scripts/sign-webhook.js`. The Postman collection also has a new self-signing *Webhooks* folder |

**Run it:** `npm install && npm test`, then `npm start`. Login `merchant@test.com` / `Test123!` now works.

**`npm run verify-bugs`** prints `0/7` after the fixes. Some fixed bugs show as "missing" instead of "already fixed" because the script uses text matching (details at the end of `fixes.md`).

**New dev dependency:** `socket.io-client`, used to test the real-time events end to end.
