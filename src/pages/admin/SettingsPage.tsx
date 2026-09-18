import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getAdminSettings,
  inviteAdminUser,
  removeAdminUser,
  updateAdminSetting,
  updateAdminUserRole,
} from '@/domains/platform/adminSettingsClient';
import type { AdminSettingWriteValue, AdminUserRole } from '@/domains/platform/contracts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { useAuth } from '@/lib/authContext';
import NotificationsTab from '@/components/admin/NotificationsTab';
import { normalizeAdminInviteEmail } from './settingsInviteValidation';
import { bffErrorMessage } from "@/lib/bff/errorMessage";

function settingString(value: unknown, fallback: string): string {
  if (value === null || value === undefined) return fallback;
  return typeof value === 'string' ? value : String(value);
}

function settingBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const { user, role, session } = useAuth();
  const adminPrincipalKey = session?.user?.id ?? 'admin-session';

  function requireAdminAccessToken(): string {
    const token = session?.access_token;
    if (!token) throw new Error("Admin session required");
    return token;
  }

  const { data: settingsRead } = useQuery({
    queryKey: ['admin-settings', adminPrincipalKey],
    queryFn: () => getAdminSettings(requireAdminAccessToken()),
  });

  const settings = settingsRead?.settings;
  const adminUsers = settingsRead?.adminUsers ?? [];

  const [cap, setCap] = useState('300');
  const [counterDisplay, setCounterDisplay] = useState(true);
  const [newAdminEmail, setNewAdminEmail] = useState('');
  const [newAdminRole, setNewAdminRole] = useState<AdminUserRole>('admin');

  const [dhlShipper, setDhlShipper] = useState({
    dhl_shipper_name: '',
    dhl_shipper_street: '',
    dhl_shipper_house_number: '',
    dhl_shipper_postal_code: '',
    dhl_shipper_city: '',
    dhl_shipper_contact_person: '',
    dhl_shipper_phone: '',
    dhl_shipper_email: '',
  });

  useEffect(() => {
    if (settings) {
      setCap(String(settings.tester_cap ?? 300));
      setCounterDisplay(settingBoolean(settings.counter_display, true));

      setDhlShipper((prev) => ({
        dhl_shipper_name: settingString(settings.dhl_shipper_name, prev.dhl_shipper_name),
        dhl_shipper_street: settingString(settings.dhl_shipper_street, prev.dhl_shipper_street),
        dhl_shipper_house_number: settingString(settings.dhl_shipper_house_number, prev.dhl_shipper_house_number),
        dhl_shipper_postal_code: settingString(settings.dhl_shipper_postal_code, prev.dhl_shipper_postal_code),
        dhl_shipper_city: settingString(settings.dhl_shipper_city, prev.dhl_shipper_city),
        dhl_shipper_contact_person: settingString(settings.dhl_shipper_contact_person, prev.dhl_shipper_contact_person),
        dhl_shipper_phone: settingString(settings.dhl_shipper_phone, prev.dhl_shipper_phone),
        dhl_shipper_email: settingString(settings.dhl_shipper_email, prev.dhl_shipper_email),
      }));
    }
  }, [settings]);

  const updateSetting = useMutation({
    mutationFn: ({ key, value }: { key: string; value: AdminSettingWriteValue }) =>
      updateAdminSetting(requireAdminAccessToken(), { key, value }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-settings'] }),
  });

  const addAdmin = useMutation({
    mutationFn: async ({ email, role }: { email: string; role: AdminUserRole }) => {
      const normalizedEmail = normalizeAdminInviteEmail(email);
      return inviteAdminUser(requireAdminAccessToken(), { email: normalizedEmail, role });
    },
    onSuccess: (data) => {
      toast.success(data?.message || 'Użytkownik dodany');
      queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      setNewAdminEmail('');
      setNewAdminRole('admin');
    },
    onError: (err: unknown) => {
      toast.error(bffErrorMessage(err));
    },
  });

  const updateRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: AdminUserRole }) =>
      updateAdminUserRole(requireAdminAccessToken(), { userId: id, role }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-settings'] }),
  });

  const removeAdmin = useMutation({
    mutationFn: (id: string) =>
      removeAdminUser(requireAdminAccessToken(), { userId: id }),
    onSuccess: () => {
      toast.success('Dostęp odebrany');
      queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
    },
    onError: (err: unknown) => {
      toast.error(bffErrorMessage(err));
    },
  });

  return (
    <div className="p-4 md:p-8">
      <div className="mb-6 md:mb-8">
        <h1 className="font-display text-xl font-semibold tracking-tight md:text-2xl">Ustawienia</h1>
      </div>

      <div className="max-w-2xl space-y-6">
        {/* Tester Cap */}
        <Card className="border-warm-sand bg-white">
          <CardHeader>
            <CardTitle className="text-base text-teal-dark">Limit testerów</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-text-muted">
              Maksymalna liczba testerów, którzy mogą się zarejestrować.
            </p>
            <div className="flex items-center gap-3">
              <Input
                type="number"
                value={cap}
                onChange={(e) => setCap(e.target.value)}
                className="w-32 border-warm-sand bg-offwhite text-teal-dark"
              />
              <button
                onClick={() => updateSetting.mutate({ key: 'tester_cap', value: Number(cap) })}
                className="rounded-xl bg-teal px-5 py-2.5 text-sm font-semibold text-void hover:opacity-90"
              >
                Zapisz
              </button>
            </div>
          </CardContent>
        </Card>

        {/* Counter Display */}
        <Card className="border-warm-sand bg-white">
          <CardHeader>
            <CardTitle className="text-base text-teal-dark">Wyświetlanie licznika</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <p className="text-sm text-text-muted">
                Pokazuj licznik testerów na stronie publicznej.
              </p>
              <Switch
                checked={counterDisplay}
                onCheckedChange={(checked) => {
                  setCounterDisplay(checked);
                  updateSetting.mutate({ key: 'counter_display', value: checked });
                }}
              />
            </div>
          </CardContent>
        </Card>

        {/* DHL Shipper Settings */}
        <Card className="border-warm-sand bg-white">
          <CardHeader>
            <CardTitle className="text-base text-teal-dark">DHL: Adres nadawcy</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-text-muted">
              Dane nadawcy używane przy generowaniu etykiet DHL.
            </p>
            {([
              ['dhl_shipper_name', 'Nazwa firmy'],
              ['dhl_shipper_street', 'Ulica'],
              ['dhl_shipper_house_number', 'Numer domu'],
              ['dhl_shipper_postal_code', 'Kod pocztowy'],
              ['dhl_shipper_city', 'Miasto'],
              ['dhl_shipper_contact_person', 'Osoba kontaktowa'],
              ['dhl_shipper_phone', 'Telefon'],
              ['dhl_shipper_email', 'Email'],
            ] as const).map(([key, label]) => (
              <div key={key}>
                <label className="mb-1 block text-xs text-text-muted">{label}</label>
                <Input
                  value={dhlShipper[key as keyof typeof dhlShipper]}
                  onChange={(e) => setDhlShipper((prev) => ({ ...prev, [key]: e.target.value }))}
                  className="border-warm-sand bg-offwhite text-teal-dark"
                />
              </div>
            ))}
            <button
              onClick={() => {
                for (const [key, value] of Object.entries(dhlShipper)) {
                  updateSetting.mutate({ key, value });
                }
              }}
              className="rounded-xl bg-teal px-5 py-2.5 text-sm font-semibold text-void hover:opacity-90"
            >
              Zapisz dane nadawcy
            </button>
          </CardContent>
        </Card>

        {/* Notifications (admin only) */}
        {role === 'admin' && <NotificationsTab />}

        {/* Admin Users */}
        <Card className="border-warm-sand bg-white">
          <CardHeader>
            <CardTitle className="text-base text-teal-dark">Użytkownicy panelu</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-text-muted">
              Dodaj osoby które będą miały dostęp do panelu. Dostaną maila z zaproszeniem.
            </p>

            <div className="space-y-2">
              {adminUsers.map((a) => (
                <div
                  key={a.id}
                  className="flex items-center justify-between rounded-lg border border-warm-sand px-4 py-2.5"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-teal-dark">{a.email}</span>
                    <Badge
                      variant="outline"
                      className={`text-[10px] ${
                        a.role === 'admin'
                          ? 'border-teal/30 text-teal'
                          : 'border-soft-lavender/30 text-soft-lavender'
                      }`}
                    >
                      {a.role === 'admin' ? 'Admin' : 'Dystrybutor'}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-3">
                    {a.id !== user?.id && (
                      <Select
                        value={a.role || 'admin'}
                        onValueChange={(role) =>
                          updateRole.mutate({ id: a.id, role: role as AdminUserRole })
                        }
                      >
                        <SelectTrigger className="w-36 h-8 text-xs border-warm-sand bg-offwhite text-teal-dark">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="border-warm-sand bg-white text-teal-dark">
                          <SelectItem value="admin">Admin</SelectItem>
                          <SelectItem value="distributor">Dystrybutor</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                    {a.id !== user?.id && (
                      <button
                        type="button"
                        onClick={() => {
                          if (window.confirm(`Czy na pewno odebrać dostęp użytkownikowi ${a.email}?`)) {
                            removeAdmin.mutate(a.id);
                          }
                        }}
                        disabled={removeAdmin.isPending}
                        className="text-xs text-warm-coral hover:text-warm-coral/80 disabled:opacity-50"
                      >
                        {removeAdmin.isPending ? 'Odbieranie dostępu...' : 'Odbierz dostęp'}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex items-center gap-3">
              <Input
                type="email"
                placeholder="email@example.com"
                value={newAdminEmail}
                onChange={(e) => setNewAdminEmail(e.target.value)}
                className="flex-1 border-warm-sand bg-offwhite text-teal-dark placeholder:text-text-muted"
              />
              <Select
                value={newAdminRole}
                onValueChange={(role) => setNewAdminRole(role as AdminUserRole)}
              >
                <SelectTrigger className="w-36 border-warm-sand bg-offwhite text-teal-dark">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-warm-sand bg-white text-teal-dark">
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="distributor">Dystrybutor</SelectItem>
                </SelectContent>
              </Select>
              <button
                onClick={() => newAdminEmail && addAdmin.mutate({ email: newAdminEmail, role: newAdminRole })}
                disabled={!newAdminEmail || addAdmin.isPending}
                className="whitespace-nowrap rounded-xl bg-teal px-5 py-2.5 text-sm font-semibold text-void hover:opacity-90 disabled:opacity-50"
              >
                {addAdmin.isPending ? 'Wysyłanie...' : 'Wyślij zaproszenie'}
              </button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
