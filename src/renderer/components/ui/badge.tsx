import { forwardRef } from "react";
import type { HTMLAttributes } from "react";

import { cn } from "./utils.js";

export type BadgeVariant = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge({ className, variant = "neutral", ...props }, ref) {
  return <span {...props} ref={ref} className={cn("ui-badge", className)} data-slot="badge" data-variant={variant} />;
});
