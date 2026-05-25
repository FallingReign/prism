import type { AnchorHTMLAttributes, ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button as ShadcnButton } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type Tone = "neutral" | "success" | "warning" | "danger" | "info" | "primary";
type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";

const toneBorder: Record<Tone, string> = {
  neutral: "border-border",
  success: "border-[color:var(--prism-success)]/60",
  warning: "border-[color:var(--prism-warning)]/65",
  danger: "border-destructive/55",
  info: "border-[color:var(--prism-info)]/60",
  primary: "border-primary/45"
};

const badgeTone: Record<Tone, string> = {
  neutral: "border-border bg-muted text-muted-foreground",
  success: "border-[color:var(--prism-success)] bg-[color:var(--prism-success-soft)] text-[color:var(--prism-success-foreground)]",
  warning: "border-[color:var(--prism-warning)] bg-[color:var(--prism-warning-soft)] text-[color:var(--prism-warning-foreground)]",
  danger: "border-destructive/40 bg-destructive/10 text-destructive",
  info: "border-[color:var(--prism-info)] bg-[color:var(--prism-info-soft)] text-[color:var(--prism-info-foreground)]",
  primary: "border-primary/35 bg-primary/10 text-primary"
};

const noticeTone: Record<Tone, string> = {
  neutral: "border-border bg-muted/45",
  success: "border-[color:var(--prism-success)]/50 bg-[color:var(--prism-success-soft)]/80",
  warning: "border-[color:var(--prism-warning)]/60 bg-[color:var(--prism-warning-soft)]/85",
  danger: "border-destructive/45 bg-destructive/10 text-destructive",
  info: "border-[color:var(--prism-info)]/50 bg-[color:var(--prism-info-soft)]/80",
  primary: "border-primary/35 bg-primary/10"
};

const metricTone: Record<Tone, string> = {
  neutral: "bg-muted/35",
  success: "bg-[color:var(--prism-success-soft)]/70",
  warning: "bg-[color:var(--prism-warning-soft)]/75",
  danger: "bg-destructive/10",
  info: "bg-[color:var(--prism-info-soft)]/75",
  primary: "bg-primary/10"
};

export function Button({
  variant = "primary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return <ShadcnButton className={className} variant={buttonVariant(variant)} size="lg" {...props} />;
}

export function LinkButton({
  variant = "primary",
  className,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: ButtonVariant }) {
  return (
    <ShadcnButton asChild className={className} variant={buttonVariant(variant)} size="lg">
      <a {...props} />
    </ShadcnButton>
  );
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
    <Card
      className={cn("gap-5 rounded-2xl bg-card/95 py-5 shadow-sm ring-0 backdrop-blur-sm", toneBorder[accent], className)}
      role="region"
      aria-labelledby={titleId}
      {...props}
    >
      <CardHeader className="grid gap-3 px-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <div className="min-w-0">
          {eyebrow ? <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">{eyebrow}</p> : null}
          <h2 id={titleId} className="text-xl font-semibold tracking-tight text-foreground">
            {title}
          </h2>
        </div>
        {badge ? <div className="flex flex-wrap items-center gap-2 sm:justify-end">{badge}</div> : null}
      </CardHeader>
      <CardContent className="grid gap-4 px-5 text-sm leading-6 text-muted-foreground">{children}</CardContent>
      {actions ? <div className="flex flex-wrap gap-2 px-5 pt-1">{actions}</div> : null}
    </Card>
  );
}

export function StatusBadge({ tone = "neutral", className, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return <Badge className={cn("h-6 rounded-full border px-2.5 font-semibold", badgeTone[tone], className)} variant="outline" {...props} />;
}

export function Notice({
  tone = "info",
  title,
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { tone?: Tone; title: ReactNode }) {
  return (
    <Alert className={cn("rounded-xl px-4 py-3", noticeTone[tone], className)} {...props}>
      <AlertTitle className="text-sm font-semibold text-foreground">{title}</AlertTitle>
      <AlertDescription className="text-sm leading-6 text-muted-foreground">{children}</AlertDescription>
    </Alert>
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
    <article className={cn("rounded-xl p-3 sm:p-4", metricTone[tone], className)}>
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tracking-tight text-foreground sm:mt-3 sm:text-2xl">{value}</p>
      <p className="mt-2 hidden text-sm leading-6 text-muted-foreground lg:block">{detail}</p>
    </article>
  );
}

export { cn };

function buttonVariant(variant: ButtonVariant): "default" | "secondary" | "outline" | "destructive" {
  if (variant === "secondary") return "secondary";
  if (variant === "quiet") return "outline";
  if (variant === "danger") return "destructive";
  return "default";
}
