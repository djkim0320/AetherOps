import * as LabelPrimitive from "@radix-ui/react-label";
import { forwardRef } from "react";
import type { ComponentPropsWithoutRef, ElementRef } from "react";

import { cn } from "./utils.js";

export type LabelProps = ComponentPropsWithoutRef<typeof LabelPrimitive.Root>;

export const Label = forwardRef<ElementRef<typeof LabelPrimitive.Root>, LabelProps>(function Label({ className, ...props }, ref) {
  return <LabelPrimitive.Root {...props} ref={ref} className={cn("ui-label", className)} data-slot="label" />;
});
