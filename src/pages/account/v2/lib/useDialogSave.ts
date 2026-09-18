import { useEffect, useState } from "react";

import type { AccountMutate } from "../../AccountWorkspaceTypes";

/**
 * Save/close wiring shared by the account form dialogs. `AccountMutate` reports
 * a failed save as `false` rather than a rejection - `runMutation` swallows the
 * exception behind its own toast - so a dialog that closed on every settled
 * promise threw away whatever the customer had typed. Closing only on success
 * keeps the draft, and `saveFailed` drives the inline notice that explains why
 * the dialog is still standing there. The `catch` is belt-and-braces for a
 * caller that rejects instead of reporting.
 */
export function useDialogSave(
  mutate: AccountMutate,
  open: boolean,
  onOpenChange: (open: boolean) => void,
) {
  const [submitting, setSubmitting] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  useEffect(() => {
    if (open) setSaveFailed(false);
  }, [open]);

  async function save(work: () => Promise<unknown>) {
    setSubmitting(true);
    setSaveFailed(false);
    try {
      if (await mutate(work)) onOpenChange(false);
      else setSaveFailed(true);
    } catch {
      setSaveFailed(true);
    } finally {
      setSubmitting(false);
    }
  }

  return { submitting, saveFailed, save };
}
