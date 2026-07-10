import * as SwitchPrimitive from "@radix-ui/react-switch";
import { forwardRef } from "react";
import type { ComponentPropsWithoutRef, ElementRef } from "react";

import { cn } from "./utils.js";

export type SwitchProps = ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>;

export const Switch = forwardRef<ElementRef<typeof SwitchPrimitive.Root>, SwitchProps>(function Switch({ className, ...props }, ref) {
  return (
    <SwitchPrimitive.Root {...props} ref={ref} className={cn("ui-switch", className)} data-slot="switch">
      <SwitchPrimitive.Thumb className="ui-switchThumb" data-slot="switch-thumb" />
    </SwitchPrimitive.Root>
  );
});
