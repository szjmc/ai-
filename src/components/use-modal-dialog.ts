"use client";
import { useEffect, useRef } from "react";

/** Native modal dialogs supply focus containment, Escape handling and inert backgrounds. */
export function useModalDialog(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      document.body.style.overflow = overflow;
      if (focused?.isConnected) focused.focus();
    };
  }, [open]);
  return ref;
}
