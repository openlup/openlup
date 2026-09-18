import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  createAdminNotificationRecipient,
  deleteAdminNotificationRecipient,
  getAdminNotificationRecipients,
  updateAdminNotificationRecipient,
} from '@/domains/communications/adminNotificationRecipientsClient';
import type {
  NotificationRecipientType as NotificationType,
} from '@/domains/communications/contracts';
import { useAuth } from '@/lib/authContext';
import { parseNotificationRecipientInput } from './notificationRecipientFormModel';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Trash2, Loader2, Package, UserPlus, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { bffErrorMessage } from "@/lib/bff/errorMessage";

function isDuplicateError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const maybeError = err as { message?: unknown; code?: unknown };
  return (
    (typeof maybeError.message === 'string' && maybeError.message.includes('duplicate')) ||
    (typeof maybeError.message === 'string' && maybeError.message.includes('już istnieje')) ||
    maybeError.code === '23505' ||
    maybeError.code === 'CONFLICT'
  );
}

function RecipientList({
  type,
  title,
  description,
  icon,
  banner,
}: {
  type: NotificationType;
  title: string;
  description: string;
  icon: React.ReactNode;
  banner?: React.ReactNode;
}) {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const accessToken = session?.access_token;
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');

  const { data: recipients = [], isLoading } = useQuery({
    queryKey: ['notification-recipients', type],
    queryFn: async () => {
      if (!accessToken) throw new Error('Admin session required');
      const { recipients } = await getAdminNotificationRecipients(accessToken, {
        notification_type: type,
      });
      return recipients;
    },
  });

  const addRecipient = useMutation({
    mutationFn: async () => {
      if (!accessToken) throw new Error('Admin session required');
      const recipient = parseNotificationRecipientInput({ email: newEmail, name: newName });
      await createAdminNotificationRecipient(accessToken, {
        email: recipient.email,
        name: recipient.name,
        notification_type: type,
        active: true,
      });
    },
    onSuccess: () => {
      toast.success('Odbiorca dodany');
      setNewEmail('');
      setNewName('');
      queryClient.invalidateQueries({ queryKey: ['notification-recipients', type] });
    },
    onError: (err: unknown) => {
      if (isDuplicateError(err)) {
        toast.error('Ten email już istnieje dla tego typu powiadomień');
      } else {
        toast.error(`Błąd: ${bffErrorMessage(err)}`);
      }
    },
  });

  const toggleActive = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      if (!accessToken) throw new Error('Admin session required');
      await updateAdminNotificationRecipient(accessToken, { recipientId: id, active });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['notification-recipients', type] }),
  });

  const deleteRecipient = useMutation({
    mutationFn: async (id: string) => {
      if (!accessToken) throw new Error('Admin session required');
      await deleteAdminNotificationRecipient(accessToken, { recipientId: id });
    },
    onSuccess: () => {
      toast.success('Odbiorca usunięty');
      queryClient.invalidateQueries({ queryKey: ['notification-recipients', type] });
    },
  });

  return (
    <Card className="border-warm-sand bg-white">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base text-teal-dark">
          {icon}
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-text-muted">{description}</p>

        {banner}

        {isLoading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-text-muted">
            <Loader2 size={14} className="animate-spin" />
            Ładowanie...
          </div>
        ) : recipients.length === 0 ? (
          <p className="py-4 text-sm text-text-muted">Brak odbiorców.</p>
        ) : (
          <div className="space-y-2">
            {recipients.map((r) => (
              <div
                key={r.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-warm-sand bg-offwhite/2 px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-teal-dark">
                    {r.name ? `${r.name} ` : ''}
                    <span className="font-normal text-text-muted">({r.email})</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={r.active}
                    onCheckedChange={(active) => toggleActive.mutate({ id: r.id, active })}
                  />
                  <button
                    onClick={() => deleteRecipient.mutate(r.id)}
                    title="Usuń"
                    className="rounded-lg p-1.5 text-text-muted hover:bg-warm-coral/10 hover:text-warm-coral transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-end gap-2 border-t border-warm-sand pt-3">
          <div className="min-w-[180px] flex-1">
            <label className="mb-1 block text-xs text-text-muted">Email *</label>
            <Input
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="osoba@firma.pl"
              className="border-warm-sand bg-offwhite text-teal-dark placeholder:text-text-muted"
            />
          </div>
          <div className="min-w-[140px] flex-1">
            <label className="mb-1 block text-xs text-text-muted">Imię (opcjonalne)</label>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Marzena"
              className="border-warm-sand bg-offwhite text-teal-dark placeholder:text-text-muted"
            />
          </div>
          <button
            onClick={() => addRecipient.mutate()}
            disabled={addRecipient.isPending || !newEmail.trim()}
            className="flex items-center gap-2 rounded-xl bg-teal px-4 py-2 text-sm font-semibold text-void hover:opacity-90 disabled:opacity-50"
          >
            {addRecipient.isPending ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />}
            Dodaj
          </button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function NotificationsTab() {
  return (
    <div className="space-y-6">
      <RecipientList
        type="packaging_digest"
        title="Codzienna lista do pakowania"
        description="Historyczna lista odbiorców wycofanego digestu pakowania; zachowana wyłącznie do administracji danych."
        icon={<Package size={18} className="text-soft-lavender" />}
      />

      <RecipientList
        type="new_signup"
        title="Powiadomienia o nowych zapisach"
        description="Mail po każdej nowej rejestracji testera do aktywnych odbiorców z tej listy."
        icon={<UserPlus size={18} className="text-warm-amber" />}
      />

      <RecipientList
        type="commerce_payment_critical"
        title="Krytyczne alerty płatności"
        description="Odbiorcy alarmów o krytycznych błędach płatności i odzyskiwania subskrypcji. Lista jest wymagana przed włączeniem dunningu."
        icon={<TriangleAlert size={18} className="text-warm-coral" />}
      />
    </div>
  );
}
