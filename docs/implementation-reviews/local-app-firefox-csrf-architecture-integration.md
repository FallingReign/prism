# Architecture Integration Brief: local-app Firefox CSRF interoperability

## Outcome and ownership

The `csrf_rejected` response occurs before local-app authorization state is read or changed. The consent page posts a normal same-origin HTML form from a response protected with `Referrer-Policy: no-referrer`, and the observed browser request carries both `Origin: null` and `Sec-Fetch-Site: same-origin`. `rejectCrossOriginBrowserMutation` currently rejects the literal `null` origin unconditionally, although it already accepts an omitted Origin when the same positive Fetch Metadata signal is present.

Ownership stays unchanged:

- `src/server/http/browser-mutation-csrf.ts` owns the shared policy for cookie-authenticated browser mutations.
- `src/server/local-app-authorization/http.ts` owns the local-app no-store, no-referrer, CSP, and frame-denial response posture.
- `app/local-app/authorize/route.ts` owns exact form parsing and invokes the shared guard before reading the form or resolving the Prism session.
- The local-app service/store continues to own authorization decisions, exact session-bound Slack connection authority, token issuance, and audit. This fix must not move or duplicate any of that logic.

The existing architecture brief explicitly requires local-app approve/deny to use the shared guard and retain `Referrer-Policy: no-referrer`; therefore the shared guard is the correct extension point. A route-local exception would duplicate security policy and leave other no-referrer form surfaces exposed to the same interoperability failure.

## Current interaction and conflict

1. `GET /local-app/authorize` renders a relative, same-origin `POST /local-app/authorize` form.
2. The HTML response uses `form-action 'self'`, `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Cache-Control: no-store`, and `Referrer-Policy: no-referrer`.
3. The browser submits the Prism session cookie and exact two-field form.
4. `POST /local-app/authorize` calls `rejectCrossOriginBrowserMutation` before body parsing or decision handling.
5. The guard first requires any supplied `Sec-Fetch-Site` value to be exactly `same-origin`. It then accepts a missing Origin with that signal, but rejects the serialized value `Origin: null` without considering the same signal.

That last distinction is the bug. For this guard, both a missing Origin and the literal `null` origin mean that an exact origin comparison is unavailable. Neither is sufficient by itself; both are safe to accept only with the existing positive `Sec-Fetch-Site: same-origin` requirement.

## Exact minimal fix

Change only `rejectCrossOriginBrowserMutation` so that an absent Origin and the literal `Origin: null` share the existing unavailable-origin branch:

```ts
if (origin === null || origin === "null") {
  return fetchSite === "same-origin" ? null : rejected();
}
```

Keep the earlier Fetch Metadata rejection and the later exact configured-origin comparison unchanged. In effect:

- allow `Origin: null` only when `Sec-Fetch-Site: same-origin` is present;
- continue allowing an omitted Origin only when `Sec-Fetch-Site: same-origin` is present;
- continue rejecting `Origin: null` when Fetch Metadata is absent, `none`, `same-site`, or `cross-site`;
- continue rejecting sibling/cross origins, including when a contradictory `Sec-Fetch-Site: same-origin` header is supplied;
- continue allowing a non-null Origin only when it exactly equals the validated `PRISM_PUBLIC_BASE_URL` origin;
- continue failing closed when neither usable browser signal is present.

Do not remove or relax `Referrer-Policy: no-referrer`. Do not add a hidden CSRF token, callback, JavaScript fetch, route-specific header rewrite, Firefox user-agent branch, or local-app exception for this correction. The shared decision rule already has the needed positive browser signal.

## Security invariants and do-not-bypass list

- Do not accept literal `Origin: null` unconditionally. Opaque, sandboxed, file, and privacy-sensitive contexts can also serialize a null origin.
- Do not accept `Sec-Fetch-Site: same-site`; sibling origins must remain unable to exercise a Prism browser session.
- Do not treat cookies, `Referer`, `Host`, or forwarded headers as substitutes for the positive same-origin Fetch Metadata signal.
- Do not move the guard after form parsing, session lookup, authorization decision, token rotation, or audit.
- Do not weaken the consent response's no-store, no-referrer, `form-action 'self'`, frame denial, or output escaping.
- Do not change Prism/local-app ownership: Prism still authorizes the exact browser session and connection; no app-specific task, Slack channel/thread, or Remote Codex state belongs here.
- Do not alter bearer-authenticated machine routes; they do not use ambient browser credentials and are outside this guard.

The shared change affects admin, Token profile, Slack connection, logout, delegated-delivery, setup, and local-app browser mutations. Its accepted request class expands only from “Origin omitted plus positive same-origin metadata” to the equivalent “Origin unavailable as literal null plus positive same-origin metadata.” All other shared consumers retain their route authorization, exact body validation, cookie/session checks, and domain invariants.

## Regression tests

### Shared guard unit tests

Update `src/server/http/browser-mutation-csrf.test.ts` to prove the full matrix:

- accepts `{ origin: "null", "sec-fetch-site": "same-origin" }`;
- rejects `{ origin: "null" }`;
- rejects literal null with `none`, `same-site`, and `cross-site`;
- retains acceptance of omitted Origin with `same-origin`;
- retains rejection when both signals are absent;
- retains exact configured-origin acceptance and cross/sibling-origin rejection;
- explicitly rejects a mismatched non-null Origin even when Fetch Metadata claims `same-origin`.

The current test named “fails closed for null Origin and same-site or cross-site Fetch Metadata” should be split or renamed so it no longer encodes unconditional rejection of literal null as the contract.

### Local-app route regression

Add a focused case to `app/local-app/authorize/route.test.ts` that submits the exact form and Prism session cookie with `Origin: null` and `Sec-Fetch-Site: same-origin`. Assert that:

- the response maps the mocked decision normally rather than returning 403;
- `decideLocalAppAuthorization` is called once with the authorization request ID, session token, decision, and generated audit request ID;
- the response remains no-store and carries `X-Prism-Request-ID`.

Retain the existing cross-origin test and add/retain a route-level literal-null-without-Fetch-Metadata rejection so the integration cannot accidentally broaden beyond the intended matrix. The eligible consent GET test should also assert `Referrer-Policy: no-referrer` and the `form-action 'self'` CSP, tying the reproduction-producing response posture to the POST regression.

Run the shared CSRF and local-app route tests first, then the full test suite and production build because this helper is shared across many browser mutation routes. A final real-browser check should cover Firefox approval and one Chromium-family browser, verifying both approve and deny without logging cookies, codes, or request bodies.

## Risks

| Risk | Control |
| --- | --- |
| Treating every null Origin as trusted | Require the exact positive `Sec-Fetch-Site: same-origin` signal; preserve all negative Fetch Metadata branches. |
| Shared-helper blast radius | Keep the change to one conditional, add the full header matrix, and run the full suite. |
| A route-local workaround drifts from shared policy | Fix the owning helper and leave `/local-app/authorize` on the standard guard. |
| Regression hidden by mocked route requests | Add the exact observed header pair at route level and repeat in real Firefox plus Chromium. |
| Security headers removed to avoid the symptom | Retain no-referrer, no-store, self-only form action, and frame denial; they are independent protections. |

## Confidence

**High (0.94).** The rejection is deterministic in the current guard: `Origin: null` reaches an unconditional 403 even after `Sec-Fetch-Site: same-origin` passes the first check. The recommended change aligns literal-null handling with the guard's existing treatment of an unavailable Origin while preserving the positive same-origin requirement and every cross/sibling-origin rejection. The remaining validation risk is browser coverage, not an unresolved ownership or state-model decision.
