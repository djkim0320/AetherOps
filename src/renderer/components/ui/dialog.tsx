import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { forwardRef } from "react";
import type { ComponentPropsWithoutRef, ElementRef } from "react";
import { cn } from "./utils.js";
import { ko } from "../../platform/i18n.js";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;

export const DialogContent = forwardRef<ElementRef<typeof DialogPrimitive.Content>, ComponentPropsWithoutRef<typeof DialogPrimitive.Content>>(
  function DialogContent({ className, children, ...props }, ref) {
    return (
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="ui-dialogOverlay" />
        <DialogPrimitive.Content {...props} ref={ref} className={cn("ui-dialogContent", className)}>
          {children}
          <DialogPrimitive.Close className="ui-dialogClose" aria-label={ko.closeDialog}>
            <X aria-hidden="true" />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    );
  }
);
