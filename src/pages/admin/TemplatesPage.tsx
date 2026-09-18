import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getAdminEmailTemplates,
  updateAdminEmailTemplateActive,
  updateAdminEmailTemplateContent,
} from '@/domains/communications/adminTemplatesClient';
import {
  getAdminNotificationControls,
  setAdminNotificationControl,
} from '@/domains/communications/adminNotificationControlsClient';
import type { AdminEmailTemplate } from '@/domains/communications/contracts';
import { buildTemplateCanonRows, type TemplateCanonRow } from './emailTemplateCanonView';
import { buildEmailTemplatePreviewSrcDoc } from './emailTemplatePreview';
import { hasCanonPreview, renderCanonPreview } from './emailCanonPreview';
import TemplateEditDialog, { type EmailTemplateFormState } from './TemplateEditDialog';
import { useAuth } from '@/lib/authContext';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Eye } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

type Template = AdminEmailTemplate;

export default function TemplatesPage() {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const accessToken = session?.access_token;
  const [editing, setEditing] = useState<Template | null>(null);
  const [previewing, setPreviewing] = useState<{ name: string; subject: string; srcDoc: string } | null>(null);
  const [formState, setFormState] = useState<EmailTemplateFormState>({ name: '', subject: '', body_html: '', body_text: '' });
  const [showPreview, setShowPreview] = useState(false);

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ['admin-templates', accessToken],
    enabled: Boolean(accessToken),
    queryFn: async () => {
      if (!accessToken) throw new Error('Admin session required');
      return (await getAdminEmailTemplates(accessToken)).templates;
    },
  });

  const rows = useMemo(() => buildTemplateCanonRows(templates), [templates]);
  const editableCount = useMemo(() => rows.filter((r) => r.editable).length, [rows]);

  const { data: notificationControls = [] } = useQuery({
    queryKey: ['admin-notification-controls', accessToken],
    enabled: Boolean(accessToken),
    queryFn: async () => {
      if (!accessToken) throw new Error('Admin session required');
      return (await getAdminNotificationControls(accessToken)).controls;
    },
  });
  const controlBySlug = useMemo(
    () => new Map(notificationControls.map((c) => [c.slug, c.enabled])),
    [notificationControls],
  );

  const toggleActive = useMutation({
    mutationFn: async ({ id, slug, active }: { id: string; slug: string; active: boolean }) => {
      if (!accessToken) throw new Error('Admin session required');
      await updateAdminEmailTemplateActive(accessToken, { templateId: id, active });
      await setAdminNotificationControl(accessToken, { slug, enabled: active });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-templates'] });
      queryClient.invalidateQueries({ queryKey: ['admin-notification-controls'] });
    },
  });

  const toggleNotificationControl = useMutation({
    mutationFn: async ({ slug, enabled }: { slug: string; enabled: boolean }) => {
      if (!accessToken) throw new Error('Admin session required');
      await setAdminNotificationControl(accessToken, { slug, enabled });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-notification-controls'] }),
  });

  const updateTemplate = useMutation({
    mutationFn: async () => {
      if (!editing) return;
      if (!accessToken) throw new Error('Admin session required');
      await updateAdminEmailTemplateContent(accessToken, {
        templateId: editing.id,
        name: formState.name,
        subject: formState.subject,
        bodyHtml: formState.body_html,
        bodyText: formState.body_text || null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-templates'] });
      setEditing(null);
    },
  });

  function openEdit(t: Template) {
    setFormState({
      name: t.name,
      subject: t.subject,
      body_html: t.body_html,
      body_text: t.body_text ?? '',
    });
    setEditing(t);
  }

  function canPreview(r: TemplateCanonRow): boolean {
    return (r.editable && r.dbRow !== null) || hasCanonPreview(r.slug);
  }

  function openPreview(r: TemplateCanonRow) {
    if (r.editable && r.dbRow) {
      setPreviewing({
        name: r.name,
        subject: r.dbRow.subject,
        srcDoc: buildEmailTemplatePreviewSrcDoc(r.dbRow.body_html),
      });
      return;
    }
    const canon = renderCanonPreview(r.slug);
    if (canon) {
      setPreviewing({ name: r.name, subject: canon.subject, srcDoc: canon.html });
    }
  }

  return (
    <div className="p-4 md:p-8">
      <div className="mb-6">
        <h1 className="font-display text-xl font-semibold tracking-tight md:text-2xl">Szablony maili</h1>
        <p className="mt-1 text-sm text-text-muted">
          {editableCount} z {rows.length} edytowalnych tutaj
        </p>
        <p className="mt-1 max-w-2xl text-xs text-text-muted">
          Edytowalne są szablony przechowywane w bazie (DB). Maile oznaczone „W kodzie" są
          renderowane w kodzie aplikacji: widoczne tu dla pełnego obrazu, ale ich treść zmienia
          się przez wdrożenie, nie z tego panelu.
        </p>
      </div>

      <div className="-mx-4 overflow-x-auto border border-warm-sand md:mx-0 md:rounded-xl md:overflow-hidden">
        <Table className="min-w-[860px] md:min-w-0">
          <TableHeader>
            <TableRow className="border-warm-sand hover:bg-transparent">
              <TableHead className="text-text-muted">#</TableHead>
              <TableHead className="text-text-muted">Nazwa</TableHead>
              <TableHead className="text-text-muted">Slug</TableHead>
              <TableHead className="text-text-muted">Kategoria</TableHead>
              <TableHead className="text-text-muted">Temat</TableHead>
              <TableHead className="text-text-muted">Renderer</TableHead>
              <TableHead className="text-text-muted">Aktywny</TableHead>
              <TableHead className="text-text-muted text-right">Podgląd</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-text-muted py-12">
                  Ładowanie...
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow
                  key={r.key}
                  className={
                    r.editable
                      ? 'border-offwhite/6 cursor-pointer hover:bg-white'
                      : 'border-offwhite/6'
                  }
                  onClick={r.editable && r.dbRow ? () => openEdit(r.dbRow as Template) : undefined}
                >
                  <TableCell className="text-text-muted">{r.dbRow?.sequence_order ?? '–'}</TableCell>
                  <TableCell className={r.editable ? 'font-medium text-teal-dark' : 'font-medium text-text-muted'}>
                    {r.name}
                  </TableCell>
                  <TableCell>
                    <code className="rounded bg-offwhite px-1.5 py-0.5 text-xs text-text-muted">
                      {r.slug}
                    </code>
                  </TableCell>
                  <TableCell className="text-text-muted text-sm">{r.category}</TableCell>
                  <TableCell className="text-text-muted">{r.subject}</TableCell>
                  <TableCell>
                    <Badge
                      className={
                        r.editable
                          ? 'border-teal/30 bg-teal/10 text-teal'
                          : 'border-warm-sand bg-offwhite text-text-muted'
                      }
                    >
                      {r.rendererLabel}
                    </Badge>
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    {r.editable && r.dbRow ? (
                      <Switch
                        checked={r.dbRow.active && (controlBySlug.get(r.controlSlug) ?? true)}
                        onCheckedChange={(active) =>
                          toggleActive.mutate({ id: (r.dbRow as Template).id, slug: r.controlSlug, active })
                        }
                      />
                    ) : controlBySlug.has(r.controlSlug) ? (
                      <Switch
                        checked={controlBySlug.get(r.controlSlug) ?? true}
                        aria-label={`Powiadomienie aktywne: ${r.name}`}
                        onCheckedChange={(enabled) =>
                          toggleNotificationControl.mutate({ slug: r.controlSlug, enabled })
                        }
                      />
                    ) : (
                      <span className="text-text-muted">–</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                    {canPreview(r) ? (
                      <button
                        onClick={() => openPreview(r)}
                        aria-label={`Podgląd maila: ${r.name}`}
                        className="rounded-lg p-1.5 text-text-muted hover:bg-offwhite hover:text-teal transition-colors"
                        title="Podgląd maila"
                      >
                        <Eye size={16} />
                      </button>
                    ) : (
                      <span
                        className="text-xs text-text-muted"
                        title="Podgląd niedostępny: ten mail nie ma renderera podglądu w kodzie"
                      >
                        bez podglądu
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Preview Dialog */}
      <Dialog open={!!previewing} onOpenChange={(open) => !open && setPreviewing(null)}>
        <DialogContent className="max-h-[90vh] w-[calc(100vw-1.5rem)] max-w-[calc(100vw-1.5rem)] overflow-y-auto border-warm-sand bg-offwhite text-teal-dark md:max-w-2xl md:max-h-[85vh]">
          <DialogHeader>
            <DialogTitle className="font-display text-teal-dark">
              Podgląd: {previewing?.name}
            </DialogTitle>
          </DialogHeader>
          <div className="mt-2 space-y-3">
            <div className="rounded-lg bg-offwhite px-4 py-2">
              <span className="text-xs text-text-muted">Temat: </span>
              <span className="text-sm text-teal-dark">{previewing?.subject}</span>
            </div>
            <iframe
              title={`Podgląd maila ${previewing?.name ?? ''}`}
              sandbox=""
              srcDoc={previewing?.srcDoc ?? ''}
              className="min-h-[300px] w-full rounded-xl border border-warm-sand bg-white"
            />
          </div>
        </DialogContent>
      </Dialog>

      <TemplateEditDialog
        editing={editing}
        formState={formState}
        setFormState={setFormState}
        showPreview={showPreview}
        setShowPreview={setShowPreview}
        onClose={() => setEditing(null)}
        onSave={() => updateTemplate.mutate()}
        isSaving={updateTemplate.isPending}
      />
    </div>
  );
}
