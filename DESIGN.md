# Design

## Visual identity

Prism is a professional product UI with a restrained, refractive personality. The interface should feel like secure infrastructure made legible: calm surfaces, precise controls, clear status language, and subtle prism-inspired spectrum details used only to guide hierarchy.

## Theme

Primary theme: light. Scene: a developer/operator is configuring local-tool Slack access during normal work hours on a laptop or external monitor, focused on safety and setup rather than incident response.

Dark mode may be added later, but it should not be the default aesthetic shortcut.

## Color system

Use OKLCH tokens. Avoid pure black and pure white.

- Neutral background: softly tinted cool-lavender neutrals, not dead gray.
- Primary accent: violet prism hue for primary actions, focus rings, selected states, and key active affordances.
- Spectrum accents: cyan, amber, and rose may appear as rare status or prism-light accents, never as decorative noise.
- Semantic states must not rely on color alone. Pair color with labels, icons, or text.

Suggested token direction:

```css
--prism-bg: oklch(97% 0.008 292);
--prism-surface: oklch(99% 0.006 292);
--prism-surface-raised: oklch(100% 0.005 292);
--prism-text: oklch(22% 0.025 292);
--prism-muted: oklch(48% 0.025 292);
--prism-border: oklch(88% 0.018 292);
--prism-primary: oklch(56% 0.18 292);
--prism-primary-strong: oklch(46% 0.19 292);
--prism-focus: oklch(64% 0.19 292);
--prism-success: oklch(54% 0.13 158);
--prism-warning: oklch(68% 0.14 78);
--prism-danger: oklch(58% 0.17 28);
--prism-info: oklch(58% 0.13 226);
```

## Typography

Use a high-quality system sans stack for performance and native product feel:

```css
font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
```

Use a compact fixed product scale:

- 12px: metadata, badges, dense labels.
- 14px: secondary text and form help.
- 16px: body, form controls.
- 20px: section headings.
- 28px: page heading.
- 40px to 48px: restrained hero heading.

Use tabular numerals for timestamps, request IDs, and audit metadata. Keep body copy within 65 to 75 characters where it reads like prose.

## Layout

Use a clear product workspace layout:

- Top product header with brand, Slack status, and primary setup action.
- Hero or summary band that answers: linked status, active Token profiles, recent activity.
- Main content split into task-focused panels: Slack link, Token profiles, metadata audit.
- Avoid nested cards. Use panels, dividers, tables/lists, and spacing hierarchy.
- Use a 4px spacing base with semantic steps: 4, 8, 12, 16, 24, 32, 48, 64.

Responsive behavior:

- Mobile: single-column setup flow with sticky or repeated primary actions.
- Tablet: stacked panels with compact summaries.
- Desktop: two-column dashboard with Token profiles as the primary work area and activity/status as supporting context.

## Components

Controls should feel like a mature product system:

- Buttons: one primary, one secondary, one quiet/destructive treatment. All have default, hover, focus-visible, active, disabled, and loading states.
- Inputs/selects: visible labels, clear helper text, strong focus rings, no placeholder-only labels.
- Status badges: text plus color, not color alone.
- Notices: no side-stripe borders. Use full-border tint, icon or heading, and concise guidance.
- Token profile creation: should not feel like a raw debug form. Prefer a guided, focused creation surface or a well-structured progressive form.
- Audit rows: dense but scannable metadata with method, outcome, object, identity, request ID, and time.

## Motion

Motion should communicate state only. Use 150 to 220 ms transitions for hover, focus, panel reveal, and success feedback. Respect `prefers-reduced-motion`. Avoid page-load choreography.

## Copy

Voice: precise, secure, and lightly prism-themed. Avoid jokes for errors. Use specific verbs:

- "Create Token profile"
- "Rotate token"
- "Revoke token"
- "Reconnect Slack"
- "Copy developer token"

Make custody boundaries explicit in short copy. Avoid vague security theater.

## Accessibility

Target WCAG AA. Required:

- Visible focus rings with at least 3:1 contrast.
- 44px minimum touch targets for primary controls.
- Color-blind-safe status communication.
- Keyboard paths for all Token profile actions.
- Reduced-motion support.
- No hover-only controls.
- Form errors that explain what happened and how to fix it.

## Implementation notes

Tailwind and shadcn-style components are acceptable if they support the tokens above and do not introduce generic defaults. Prefer local reusable components over ad hoc inline styles. The final system should make future panels easy to add without inventing new button, badge, form, or panel styles.
