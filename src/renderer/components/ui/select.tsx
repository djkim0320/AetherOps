import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { forwardRef } from "react";
import type { ComponentPropsWithoutRef, ElementRef } from "react";

import { cn } from "./utils.js";

export type SelectProps = ComponentPropsWithoutRef<typeof SelectPrimitive.Root>;
export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;
export const SelectLabel = SelectPrimitive.Label;
export const SelectSeparator = SelectPrimitive.Separator;

export const SelectTrigger = forwardRef<ElementRef<typeof SelectPrimitive.Trigger>, ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>>(
  function SelectTrigger({ className, children, ...props }, ref) {
    return (
      <SelectPrimitive.Trigger {...props} ref={ref} className={cn("ui-selectTrigger", className)} data-slot="select-trigger">
        {children}
        <SelectPrimitive.Icon asChild>
          <ChevronDown size={14} />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
    );
  }
);

export const SelectScrollUpButton = forwardRef<
  ElementRef<typeof SelectPrimitive.ScrollUpButton>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpButton>
>(function SelectScrollUpButton({ className, ...props }, ref) {
  return (
    <SelectPrimitive.ScrollUpButton {...props} ref={ref} className={cn("ui-selectScrollButton", className)}>
      <ChevronUp size={14} />
    </SelectPrimitive.ScrollUpButton>
  );
});

export const SelectScrollDownButton = forwardRef<
  ElementRef<typeof SelectPrimitive.ScrollDownButton>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownButton>
>(function SelectScrollDownButton({ className, ...props }, ref) {
  return (
    <SelectPrimitive.ScrollDownButton {...props} ref={ref} className={cn("ui-selectScrollButton", className)}>
      <ChevronDown size={14} />
    </SelectPrimitive.ScrollDownButton>
  );
});

export const SelectContent = forwardRef<ElementRef<typeof SelectPrimitive.Content>, ComponentPropsWithoutRef<typeof SelectPrimitive.Content>>(
  function SelectContent({ className, children, position = "popper", ...props }, ref) {
    return (
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content {...props} ref={ref} position={position} className={cn("ui-selectContent", className)} data-slot="select-content">
          <SelectScrollUpButton />
          <SelectPrimitive.Viewport className="ui-selectViewport">{children}</SelectPrimitive.Viewport>
          <SelectScrollDownButton />
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    );
  }
);

export const SelectItem = forwardRef<ElementRef<typeof SelectPrimitive.Item>, ComponentPropsWithoutRef<typeof SelectPrimitive.Item>>(function SelectItem(
  { className, children, ...props },
  ref
) {
  return (
    <SelectPrimitive.Item {...props} ref={ref} className={cn("ui-selectItem", className)} data-slot="select-item">
      <SelectPrimitive.ItemIndicator className="ui-selectItemIndicator">
        <Check size={14} />
      </SelectPrimitive.ItemIndicator>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
});
