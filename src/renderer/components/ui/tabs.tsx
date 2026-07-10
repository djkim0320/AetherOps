import * as TabsPrimitive from "@radix-ui/react-tabs";
import { forwardRef } from "react";
import type { ComponentPropsWithoutRef, ElementRef } from "react";

import { cn } from "./utils.js";

export type TabsOrientation = ComponentPropsWithoutRef<typeof TabsPrimitive.Root>["orientation"];
export type TabsActivationMode = ComponentPropsWithoutRef<typeof TabsPrimitive.Root>["activationMode"];

export type TabsProps = ComponentPropsWithoutRef<typeof TabsPrimitive.Root>;

export const Tabs = forwardRef<ElementRef<typeof TabsPrimitive.Root>, TabsProps>(function Tabs({ className, ...props }, ref) {
  return <TabsPrimitive.Root {...props} ref={ref} className={cn("ui-tabs", className)} data-slot="tabs" />;
});

export type TabsListProps = ComponentPropsWithoutRef<typeof TabsPrimitive.List>;

export const TabsList = forwardRef<ElementRef<typeof TabsPrimitive.List>, TabsListProps>(function TabsList({ className, ...props }, ref) {
  return <TabsPrimitive.List {...props} ref={ref} className={cn("ui-tabs-list", className)} data-slot="tabs-list" />;
});

export type TabsTriggerProps = ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>;

export const TabsTrigger = forwardRef<ElementRef<typeof TabsPrimitive.Trigger>, TabsTriggerProps>(function TabsTrigger({ className, ...props }, ref) {
  return <TabsPrimitive.Trigger {...props} ref={ref} className={cn("ui-tabs-trigger", className)} data-slot="tabs-trigger" />;
});

export type TabsContentProps = ComponentPropsWithoutRef<typeof TabsPrimitive.Content>;

export const TabsContent = forwardRef<ElementRef<typeof TabsPrimitive.Content>, TabsContentProps>(function TabsContent({ className, ...props }, ref) {
  return <TabsPrimitive.Content {...props} ref={ref} className={cn("ui-tabs-content", className)} data-slot="tabs-content" />;
});
