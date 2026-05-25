import type { AnchorHTMLAttributes, ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

type Tone = "neutral" | "success" | "warning" | "danger" | "info" | "primary";
type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";

export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

export function Button({
  variant = "primary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return <button className={cx("button", `button--${variant}`, className)} {...props} />;
}

export function LinkButton({
  variant = "primary",
  className,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: ButtonVariant }) {
  return <a className={cx("button", `button--${variant}`, className)} {...props} />;
}

export function Panel({
  eyebrow,
  title,
  titleId,
  badge,
  actions,
  children,
  className,
  accent = "neutral",
  ...props
}: HTMLAttributes<HTMLElement> & {
  eyebrow?: string;
  title: ReactNode;
  titleId?: string;
  badge?: ReactNode;
  actions?: ReactNode;
  accent?: Tone;
}) {
  return (
    <section className={cx("panel", `panel--${accent}`, className)} aria-labelledby={titleId} {...props}>
      <div className="panel__header">
        <div>
          {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
          <h2 id={titleId}>{title}</h2>
        </div>
        {badge ? <div className="panel__badge">{badge}</div> : null}
      </div>
      <div className="panel__body">{children}</div>
      {actions ? <div className="panel__actions">{actions}</div> : null}
    </section>
  );
}

export function StatusBadge({ tone = "neutral", className, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return <span className={cx("status-badge", `status-badge--${tone}`, className)} {...props} />;
}

export function Notice({
  tone = "info",
  title,
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { tone?: Tone; title: ReactNode }) {
  return (
    <div className={cx("notice", `notice--${tone}`, className)} {...props}>
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  );
}

export function SummaryMetric({
  label,
  value,
  detail,
  tone = "neutral",
  className
}: {
  label: string;
  value: string;
  detail: string;
  tone?: Tone;
  className?: string;
}) {
  return (
    <article className={cx("summary-metric", `summary-metric--${tone}`, className)}>
      <p className="summary-metric__label">{label}</p>
      <p className="summary-metric__value">{value}</p>
      <p className="summary-metric__detail">{detail}</p>
    </article>
  );
}
