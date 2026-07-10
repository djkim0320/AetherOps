import { forwardRef } from "react";
import type { InputHTMLAttributes } from "react";

import { cn } from "./utils.js";

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, ...props }, ref) {
  return <input {...props} ref={ref} className={cn("ui-input", className)} data-slot="input" />;
});
