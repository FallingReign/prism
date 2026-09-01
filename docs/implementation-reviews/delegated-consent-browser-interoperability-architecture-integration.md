# Architecture Integration Brief: delegated consent browser interoperability

## Outcome

Implement this as a Prism-owned improvement to the generic delegated Slack-message authorization surface. The browser behavior, registration, and product wording must be application-neutral. This slice does not add a multi-client registry; it makes the consent mechanism reliable for any single client registered through the existing deployment configuration.

## Existing ownership and interaction

- `src/server/delegated-delivery/http.ts` owns security headers for delegated responses.
- `src/server/delegated-delivery/presentation.ts` owns consent markup and user-facing recovery guidance.
- `src/server/http/browser-mutation-csrf.ts` owns same-origin verification.
- The Approve and Deny routes call the shared guard before reading the form or changing authorization state.

The delegated consent document posts relative, same-origin forms back to Prism. Delegated HTML currently applies `Referrer-Policy: no-referrer` in both the response and document markup. Some browsers consequently omit the concrete Prism origin and may also omit the optional Fetch Metadata fallback, causing a legitimate submission to fail closed.

## Integration plan

1. Make delegated HTML responses use exactly `Referrer-Policy: strict-origin` after applying the shared delegated security headers.
2. Keep delegated JSON, redirects, and other machine responses at `no-referrer`.
3. Remove document-level referrer meta directives so the response helper remains the single policy owner.
4. Replace consumer-specific consent and recovery language with `Application request`, `requesting application`, and equivalent neutral terms.
5. Accept a bounded configured client identifier and exact safe callback instead of requiring a consumer-specific identifier or callback path.
6. Make setup prompts, examples, and current security documentation describe a registered-client Prism capability.

`strict-origin` exposes only Prism's scheme, hostname, and port. It does not disclose the authorization path, request identifier, query, message, or token, and it suppresses the referrer on HTTPS-to-HTTP downgrade.

Do not rename legacy encryption associated-data strings in this slice. Existing grants may depend on their exact values, and changing them would be a storage-compatibility project with no browser benefit.

## Do-not-bypass systems

- Shared same-origin browser mutation guard.
- Exact empty-form parsing and body-size limit.
- Prism session and canonical user/Slack-connection authorization.
- `form-action 'self'`, no-store, frame denial, CSP, and output escaping.
- One-message sender, workspace, channel, payload, revision, and delivery-window binding.
- Hash-only artifacts, encrypted payload custody, DPoP, replay protection, rate limits, and metadata-only audit.
- Machine-response `no-referrer` behavior.

The guard must continue to accept the exact configured Origin without optional Fetch Metadata and reject hostile or sibling origins even when they claim `Sec-Fetch-Site: same-origin`. Literal or absent Origin remains rejected without positive same-origin Fetch Metadata; `same-site`, `cross-site`, and `none` remain rejected.

## Regression and release plan

- Delegated HTML returns exactly `strict-origin`.
- Delegated JSON and redirects remain exactly `no-referrer`.
- Consent markup contains no conflicting referrer meta directive.
- Consent and recovery pages use application-neutral language.
- A valid application-neutral client identifier and callback registration is accepted; malformed identifiers, unsafe callbacks, and private JWK material are rejected.
- Approve and Deny accept the exact configured Origin without Fetch Metadata.
- Approve and Deny reject hostile, null-without-metadata, and metadata-free requests before database work.
- Existing bounded null-Origin plus exact same-origin metadata fallback remains covered.
- Malformed and non-empty forms remain rejected.
- Targeted tests, full Vitest, helper tests, and production build pass.
- Live release proof inspects the effective header and completes Approve and Deny in Firefox and Chromium while a hostile-origin probe remains rejected.

## Risks

- Conflicting header and markup policies: remove the document-level meta directive.
- Privacy weakening: scope `strict-origin` only to delegated HTML.
- CSRF regression: retain the complete negative matrix and pre-database assertions.
- Overclaiming universality: describe universal browser behavior without implying simultaneous multi-client registration.
- Registration broadening: retain one exact client identifier, callback, and public key ring per deployment, with the existing format and URL safety checks.
- Existing encrypted-record breakage: preserve legacy internal associated-data strings.

## Confidence

**High (0.94).** Ownership and the failure mechanism are explicit. The remaining uncertainty is real browser behavior through the deployed HTTP stack, covered by the Firefox and Chromium release gate.
