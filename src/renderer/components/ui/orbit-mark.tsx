import { forwardRef, useId } from "react";
import type { SVGProps } from "react";

import { cn } from "./utils.js";

export interface OrbitMarkProps extends SVGProps<SVGSVGElement> {
  decorative?: boolean;
  title?: string;
}

export const OrbitMark = forwardRef<SVGSVGElement, OrbitMarkProps>(function OrbitMark(
  { "aria-label": ariaLabel, "aria-labelledby": ariaLabelledBy, className, decorative: decorativeProp, title, ...props },
  ref
) {
  const generatedTitleId = useId().replace(/:/g, "");
  const titleId = `aether-orbit-title-${generatedTitleId}`;
  const hasAccessibleName = Boolean(title || ariaLabel || ariaLabelledBy);
  const decorative = decorativeProp ?? !hasAccessibleName;

  return (
    <svg
      {...props}
      ref={ref}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role={decorative ? undefined : "img"}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : ariaLabel}
      aria-labelledby={decorative ? undefined : (ariaLabelledBy ?? (title ? titleId : undefined))}
      focusable="false"
      className={cn("ui-orbit-mark", className)}
      data-slot="orbit-mark"
    >
      {!decorative && title ? <title id={titleId}>{title}</title> : null}
      <circle cx="32" cy="32" r="5" fill="currentColor" />
      <ellipse cx="32" cy="32" rx="25" ry="10" stroke="currentColor" strokeWidth="2.5" />
      <ellipse cx="32" cy="32" rx="25" ry="10" stroke="currentColor" strokeWidth="2.5" transform="rotate(60 32 32)" opacity="0.72" />
      <circle cx="54" cy="27" r="3.5" fill="currentColor" />
    </svg>
  );
});
