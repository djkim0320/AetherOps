import { Slot } from "@radix-ui/react-slot";
import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";

import { cn } from "./utils.js";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, asChild, disabled, size = "md", type = "button", variant = "primary", ...props },
  ref
) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      {...props}
      ref={ref}
      type={asChild ? undefined : type}
      disabled={disabled}
      className={cn("ui-button", className)}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-icon-only={size === "icon" ? "" : undefined}
      data-disabled={disabled ? "" : undefined}
    />
  );
});
