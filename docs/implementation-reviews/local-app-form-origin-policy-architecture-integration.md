# Architecture Integration Brief: local-app form origin policy

## Outcome

The live failure is not a Prism restart problem. PR #51 made one Firefox-shaped request acceptable (`Origin: null` plus `Sec-Fetch-Site: same-origin`), but the user's default Firefox still returns `csrf_rejected`. That means the real form submission does not carry the positive Fetch Metadata signal assumed by that fix.

The local-app HTML response creates the problem: `localAppHtmlResponse` delegates to `secureLocalAppResponse`, which applies `Referrer-Policy: no-referrer` to every response. Firefox consequently submits the same-origin form with an unusable `Origin: null`. The route then correctly fails closed when Fetch Metadata is absent or different.

Keep the CSRF guard and authorization flow unchanged. Make the local-app HTML response produce a concrete browser Origin instead.

## Minimal integration

In `src/server/local-app-authorization/http.ts`, override the policy only after `localAppHtmlResponse` has called `secureLocalAppResponse`:

```ts
const secured = secureLocalAppResponse(response, requestId);
secured.headers.set("Referrer-Policy", "strict-origin");
return secured;
```

Use **`strict-origin`**, not `origin`.

- Both directives disclose only the origin in `Referer`, never `/local-app/authorize`, its query, user code, or request locator.
- `strict-origin` also suppresses the referrer on an HTTPS-to-HTTP downgrade; `origin` would send it. The downgrade is not needed by this same-origin form and should remain private by default.
- The consent form already posts to the relative same-origin action `/local-app/authorize`, while CSP restricts forms to `form-action 'self'`.
- A normal submission then reaches the existing exact comparison against the validated `PRISM_PUBLIC_BASE_URL` origin. Cross- and sibling-origin submissions remain rejected.

Do not change `secureLocalAppResponse`'s default. JSON begin/poll/exchange responses, redirects through Slack OAuth, and CSRF error JSON must retain `Referrer-Policy: no-referrer`. Do not change the form, add JavaScript, add a route exception, trust `Referer`, or weaken the no-store, CSP, frame-denial, exact-body, session, or authorization checks.

This is a narrow correction to the earlier generic local-app brief's blanket no-referrer posture: HTML that contains the same-origin approval form needs an origin-only policy so the owning CSRF guard receives its primary signal. All other local-app responses keep the original posture.

## Tests and live proof

Add focused response-helper tests that assert exact header values:

- `localAppHtmlResponse(...)` returns exactly `Referrer-Policy: strict-origin`, `Cache-Control: no-store`, `Pragma: no-cache`, `form-action 'self'`, and frame denial;
- `localAppJsonResponse(...)` still returns exactly `Referrer-Policy: no-referrer`;
- `localAppRedirect(...)` still returns exactly `Referrer-Policy: no-referrer`;
- the actual eligible consent GET in `app/local-app/authorize/route.test.ts` expects `strict-origin`, not `no-referrer`.

Retain the shared guard matrix and add a route-level POST using the exact configured non-null Origin with no Fetch Metadata. It must reach `decideLocalAppAuthorization`. Retain hostile-origin cases, including a mismatched Origin that claims `Sec-Fetch-Site: same-origin`, and the null-Origin-without-metadata rejection.

Synthetic `NextRequest` tests cannot prove that a browser derives Origin correctly from the response policy. Before declaring the incident fixed:

1. Load a fresh consent page in default Firefox, approve it, and verify the POST carries the concrete Prism origin and completes rather than returning 403.
2. Repeat approve or deny in a Chromium-family browser.
3. Inspect the deployed response to ensure there is one effective `Referrer-Policy: strict-origin` value, not a combined global `no-referrer` value.
4. Repeat a hostile-origin probe and confirm 403 before any authorization decision.

## Security and blast radius

| Risk | Control |
| --- | --- |
| Local-app URL, code, or request ID leaks through `Referer` | `strict-origin` sends only scheme, host, and port; no path or query. |
| Downgrade disclosure | `strict-origin` suppresses HTTPS-to-HTTP referrers. |
| Cross-origin form submission becomes acceptable | CSP remains `form-action 'self'`; the POST guard still requires the exact configured non-null Origin and rejects contradictory Fetch Metadata. |
| Shared API/OAuth privacy posture changes | Override only `localAppHtmlResponse`; JSON and redirects retain `no-referrer`. |
| Framework/global headers produce conflicting policy values | Assert the exact header in unit tests and against the deployed HTTP response. |
| PR #51's null-Origin allowance is mistaken for the primary contract | Treat concrete exact Origin as the repaired normal path. Reconsidering the narrow null-plus-same-origin fallback is a separate hardening decision, not part of this minimal live fix. |

The code blast radius is one local-app response factory. It affects local-app consent and result HTML only; it does not affect delegated-delivery HTML, OAuth routes, generic browser-mutation policy, bearer-authenticated machine endpoints, Slack forwarding, or application state ownership.

## Confidence

**High (0.92).** The response policy, relative same-origin form, and pre-decision rejection path are explicit in the code, and the continued live failure explains why PR #51's Fetch Metadata fallback was insufficient. The remaining uncertainty is runtime browser/header behavior through the deployed Next.js stack, which is why real Firefox approval and an exact deployed-header check are release gates.
