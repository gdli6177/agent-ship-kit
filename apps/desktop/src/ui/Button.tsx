import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md";

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  trailing,
  className,
  children,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <button
      {...props}
      type={type}
      className={[
        "ui-button",
        `ui-button--${variant}`,
        `ui-button--${size}`,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {icon && <span className="ui-button__icon">{icon}</span>}
      <span>{children}</span>
      {trailing && <span className="ui-button__icon">{trailing}</span>}
    </button>
  );
}

export function IconButton({
  label,
  children,
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
}) {
  return (
    <button
      {...props}
      type={type}
      className={["ui-icon-button", className].filter(Boolean).join(" ")}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}
