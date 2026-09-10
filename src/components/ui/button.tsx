import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

/**
 * WCAG 2.2 only asks for 24×24, but a thumb wants 44 — and the dense desktop
 * layout is the reason these controls are small in the first place. So the
 * floor is raised on coarse pointers only: the mouse view is untouched, and a
 * phone gets a target it can actually hit. Exported so the one-off text
 * buttons ("Edit", "Show source", a day toggle) can share the same rule.
 */
export const TOUCH_TARGET =
  "[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11";

const BASE =
  `inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-[background-color,border-color,color,box-shadow] duration-150 disabled:cursor-not-allowed disabled:opacity-55 ${TOUCH_TARGET}`;

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-accent-on shadow-card hover:bg-accent-hover disabled:hover:bg-accent",
  secondary:
    "border border-line-strong bg-surface text-ink hover:bg-raised disabled:hover:bg-surface",
  ghost: "text-ink-soft hover:bg-raised hover:text-ink",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "px-2.5 py-1.5 text-[0.8125rem]",
  md: "px-3.5 py-2 text-[0.875rem]",
  lg: "px-5 py-2.5 text-[0.9375rem]",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      className={`${BASE} ${VARIANTS[variant]} ${SIZES[size]} ${className ?? ""}`}
    >
      {children}
    </button>
  );
}

/** Anchor styled as a button — for real navigations like the Google sign-in. */
export function LinkButton({
  href,
  variant = "primary",
  size = "md",
  className,
  children,
}: {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      className={`${BASE} ${VARIANTS[variant]} ${SIZES[size]} ${className ?? ""}`}
    >
      {children}
    </a>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <span
      role="status"
      aria-label={label}
      className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}
