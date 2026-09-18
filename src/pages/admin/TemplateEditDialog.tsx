import type { Dispatch, SetStateAction } from 'react';
import type { AdminEmailTemplate } from '@/domains/communications/contracts';
import { buildEmailTemplatePreviewSrcDoc } from './emailTemplatePreview';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

export interface EmailTemplateFormState {
  name: string;
  subject: string;
  body_html: string;
  body_text: string;
}

interface TemplateEditDialogProps {
  editing: AdminEmailTemplate | null;
  formState: EmailTemplateFormState;
  setFormState: Dispatch<SetStateAction<EmailTemplateFormState>>;
  showPreview: boolean;
  setShowPreview: Dispatch<SetStateAction<boolean>>;
  onClose: () => void;
  onSave: () => void;
  isSaving: boolean;
}

export default function TemplateEditDialog({
  editing,
  formState,
  setFormState,
  showPreview,
  setShowPreview,
  onClose,
  onSave,
  isSaving,
}: TemplateEditDialogProps) {
  return (
    <Dialog open={!!editing} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-1.5rem)] max-w-[calc(100vw-1.5rem)] overflow-y-auto border-warm-sand bg-offwhite text-teal-dark md:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-display text-teal-dark">
            Edycja: {editing?.slug}
          </DialogTitle>
        </DialogHeader>

        <div className="mt-4 space-y-4">
          <div>
            <label className="label-text mb-1 block text-text-muted">Nazwa</label>
            <Input
              value={formState.name}
              onChange={(e) => setFormState((s) => ({ ...s, name: e.target.value }))}
              className="border-warm-sand bg-offwhite text-teal-dark"
            />
          </div>
          <div>
            <label className="label-text mb-1 block text-text-muted">Temat</label>
            <Input
              value={formState.subject}
              onChange={(e) => setFormState((s) => ({ ...s, subject: e.target.value }))}
              className="border-warm-sand bg-offwhite text-teal-dark"
            />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="label-text text-text-muted">Treść HTML</label>
              <button
                type="button"
                onClick={() => setShowPreview((p) => !p)}
                className="text-xs text-teal hover:text-teal/80"
              >
                {showPreview ? 'Edycja' : 'Podgląd'}
              </button>
            </div>
            {showPreview ? (
              <iframe
                title="Podgląd edytowanego szablonu"
                sandbox=""
                srcDoc={buildEmailTemplatePreviewSrcDoc(formState.body_html)}
                className="min-h-[200px] w-full rounded-xl border border-warm-sand bg-white"
              />
            ) : (
              <Textarea
                value={formState.body_html}
                onChange={(e) => setFormState((s) => ({ ...s, body_html: e.target.value }))}
                rows={12}
                className="border-warm-sand bg-offwhite font-mono text-xs text-teal-dark"
              />
            )}
          </div>
          <div>
            <label className="label-text mb-1 block text-text-muted">Zwykły tekst (opcjonalnie)</label>
            <Textarea
              value={formState.body_text}
              onChange={(e) => setFormState((s) => ({ ...s, body_text: e.target.value }))}
              rows={6}
              className="border-warm-sand bg-offwhite font-mono text-xs text-teal-dark"
            />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button
              onClick={onClose}
              className="rounded-xl border border-warm-sand px-5 py-2.5 text-sm font-medium text-text-muted hover:bg-offwhite"
            >
              Anuluj
            </button>
            <button
              onClick={onSave}
              disabled={isSaving}
              className="rounded-xl bg-teal px-5 py-2.5 text-sm font-semibold text-void hover:opacity-90 disabled:opacity-50"
            >
              {isSaving ? 'Zapisywanie...' : 'Zapisz'}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
