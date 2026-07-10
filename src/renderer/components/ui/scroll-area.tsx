import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import { forwardRef } from "react";
import type { ComponentPropsWithoutRef, ElementRef, ReactNode } from "react";

import { cn } from "./utils.js";

export interface ScrollAreaProps extends ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> {
  children: ReactNode;
}

export const ScrollArea = forwardRef<ElementRef<typeof ScrollAreaPrimitive.Root>, ScrollAreaProps>(function ScrollArea({ children, className, ...props }, ref) {
  return (
    <ScrollAreaPrimitive.Root
      {...props}
      ref={ref}
      className={cn("ui-scroll-area", className)}
      data-slot="scroll-area"
      style={{ overflow: "hidden", ...props.style }}
    >
      <ScrollAreaPrimitive.Viewport className="ui-scroll-areaViewport" data-slot="scroll-area-viewport" tabIndex={0} style={{ width: "100%", height: "100%" }}>
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar className="ui-scroll-areaScrollbar" orientation="vertical">
        <ScrollAreaPrimitive.Thumb className="ui-scroll-areaThumb" />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Corner className="ui-scroll-areaCorner" />
    </ScrollAreaPrimitive.Root>
  );
});
