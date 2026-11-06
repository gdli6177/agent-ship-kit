import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "accent" | "mint" | "warm" | "danger";

export function Badge({
  tone = "neutral",
  dot = false,
  children,
  className,
}: {
  tone?: BadgeTone;
  dot?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={`ui-badge ui-badge--${tone}${className ? ` ${className}` : ""}`}>
      {dot && <i className="ui-badge__dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

/** State label with the semantic dot used by goal status and attention cards. */
export function StatusPill({
  tone = "neutral",
  children,
  className,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Badge tone={tone} dot className={className}>
      {children}
    </Badge>
  );
}
