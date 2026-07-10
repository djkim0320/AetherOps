import { forwardRef } from "react";
import type { TextareaHTMLAttributes } from "react";

import { cn } from "./utils.js";

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ className, ...props }, ref) {
  return <textarea {...props} ref={ref} className={cn("ui-textarea", className)} data-slot="textarea" />;
});
