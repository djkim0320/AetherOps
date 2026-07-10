import { forwardRef } from "react";
import type { HTMLAttributes } from "react";

import { cn } from "./utils.js";

export type CardProps = HTMLAttributes<HTMLDivElement>;

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card({ className, ...props }, ref) {
  return <div {...props} ref={ref} className={cn("ui-card", className)} data-slot="card" />;
});

export const CardHeader = forwardRef<HTMLDivElement, CardProps>(function CardHeader({ className, ...props }, ref) {
  return <div {...props} ref={ref} className={cn("ui-card-header", className)} data-slot="card-header" />;
});

export type CardTitleProps = HTMLAttributes<HTMLHeadingElement>;

export const CardTitle = forwardRef<HTMLHeadingElement, CardTitleProps>(function CardTitle({ className, ...props }, ref) {
  return <h3 {...props} ref={ref} className={cn("ui-card-title", className)} data-slot="card-title" />;
});

export type CardDescriptionProps = HTMLAttributes<HTMLParagraphElement>;

export const CardDescription = forwardRef<HTMLParagraphElement, CardDescriptionProps>(function CardDescription({ className, ...props }, ref) {
  return <p {...props} ref={ref} className={cn("ui-card-description", className)} data-slot="card-description" />;
});

export const CardContent = forwardRef<HTMLDivElement, CardProps>(function CardContent({ className, ...props }, ref) {
  return <div {...props} ref={ref} className={cn("ui-card-content", className)} data-slot="card-content" />;
});

export const CardFooter = forwardRef<HTMLDivElement, CardProps>(function CardFooter({ className, ...props }, ref) {
  return <div {...props} ref={ref} className={cn("ui-card-footer", className)} data-slot="card-footer" />;
});
