import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getAdminCommunicationPermissions,
  updateAdminCommunicationPermission,
} from "@/domains/communications/adminPermissionsClient";
import {
  COMMUNICATION_PERMISSION_STATES,
  COMMUNICATION_PURPOSES,
  type CommunicationPermissionState,
  type CommunicationPurpose,
} from "@/domains/communications/types";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ShieldCheck } from "lucide-react";
import { toast } from "sonner";

interface Props {
  accessToken: string | undefined;
  email: string | null | undefined;
  firstName?: string | null;
  lastName?: string | null;
  legacy?: {
    newsletterConsent?: boolean | null;
    verificationConsent?: boolean | null;
    emailSequencePaused?: boolean | null;
  };
  compact?: boolean;
}

const purposeLabels: Record<CommunicationPurpose, string> = {
  transactional: "Transakcyjne",
  tester_program: "Program testera",
  marketing_launch_offer: "Start/oferty",
  marketing_newsletter: "Newsletter",
  subscription_dunning: "Płatności/subskrypcja",
  admin_notification: "Admin/internal",
};

const stateLabels: Record<CommunicationPermissionState, string> = {
  unknown: "Nieznane",
  granted: "Zgoda",
  denied: "Brak zgody",
  suppressed: "Suppressed",
};

export function AdminCommunicationPermissionsCard({
  accessToken,
  email,
  firstName,
  lastName,
  legacy,
  compact = false,
}: Props) {
  const queryClient = useQueryClient();
  const [purpose, setPurpose] = useState<CommunicationPurpose>("marketing_newsletter");
  const [state, setState] = useState<CommunicationPermissionState>("suppressed");
  const [reason, setReason] = useState("");
  const normalizedEmail = email?.trim().toLowerCase() ?? "";

  const query = useQuery({
    queryKey: ["admin-communication-permissions", normalizedEmail],
    enabled: Boolean(accessToken && normalizedEmail.includes("@")),
    queryFn: async () => {
      if (!accessToken) throw new Error("Admin session required");
      return getAdminCommunicationPermissions(accessToken, normalizedEmail);
    },
  });

  const mutation = useMutation({
    mutationFn: async () => {
      if (!accessToken) throw new Error("Admin session required");
      if (!normalizedEmail) throw new Error("Email required");
      return updateAdminCommunicationPermission(accessToken, {
        email: normalizedEmail,
        purpose,
        state,
        reason,
        firstName: firstName ?? undefined,
        lastName: lastName ?? undefined,
      });
    },
    onSuccess: () => {
      toast.success("Zgoda zapisana");
      setReason("");
      queryClient.invalidateQueries({ queryKey: ["admin-communication-permissions", normalizedEmail] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Nie udało się zapisać zgody");
    },
  });

  const permissions = query.data?.permissions ?? [];
  const events = query.data?.events ?? [];
  const links = query.data?.links ?? [];

  return (
    <section className={compact ? "" : "rounded-lg border border-warm-sand bg-offwhite/[0.03] p-4"}>
      <div className="mb-3 flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-teal" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-teal-dark/80">Zgody i komunikacja</h3>
      </div>

      <div className="mb-3 flex flex-wrap gap-2">
        <Badge variant={legacy?.verificationConsent ? "default" : "outline-solid"} className="text-xs">
          Legacy weryfikacja {legacy?.verificationConsent ? "Tak" : "Nie"}
        </Badge>
        <Badge variant={legacy?.newsletterConsent ? "default" : "outline-solid"} className="text-xs">
          Legacy newsletter {legacy?.newsletterConsent ? "Tak" : "Nie"}
        </Badge>
        <Badge variant={legacy?.emailSequencePaused ? "destructive" : "outline-solid"} className="text-xs">
          Legacy pause {legacy?.emailSequencePaused ? "Tak" : "Nie"}
        </Badge>
      </div>

      {query.isLoading ? (
        <p className="text-sm text-text-muted">Ładowanie zgód...</p>
      ) : query.isError ? (
        <p className="text-sm text-warm-coral">Nie udało się pobrać centralnych zgód.</p>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            {COMMUNICATION_PURPOSES.map((item) => {
              const permission = permissions.find((entry) => entry.purpose === item);
              return (
                <div key={item} className="rounded-md border border-warm-sand bg-offwhite p-2">
                  <div className="text-xs font-medium text-text-muted">{purposeLabels[item]}</div>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <Badge variant={permission?.state === "granted" ? "default" : "outline-solid"} className="text-xs">
                      {stateLabels[permission?.state ?? "unknown"]}
                    </Badge>
                    <span className="truncate text-[11px] text-text-muted">{permission?.source ?? "brak źródła"}</span>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <Select value={purpose} onValueChange={(value) => setPurpose(value as CommunicationPurpose)}>
              <SelectTrigger className="border-warm-sand bg-offwhite text-teal-dark">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-warm-sand bg-white text-teal-dark">
                {COMMUNICATION_PURPOSES.map((item) => (
                  <SelectItem key={item} value={item}>{purposeLabels[item]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={state} onValueChange={(value) => setState(value as CommunicationPermissionState)}>
              <SelectTrigger className="border-warm-sand bg-offwhite text-teal-dark">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-warm-sand bg-white text-teal-dark">
                {COMMUNICATION_PERMISSION_STATES.map((item) => (
                  <SelectItem key={item} value={item}>{stateLabels[item]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="min-h-[68px] border-warm-sand bg-offwhite text-sm text-teal-dark placeholder:text-text-muted"
            placeholder="Powód zmiany zgody..."
          />
          <button
            type="button"
            disabled={mutation.isPending || reason.trim().length < 3 || !accessToken}
            onClick={() => mutation.mutate()}
            className="rounded-lg border border-teal/40 bg-teal/15 px-3 py-1.5 text-sm font-medium text-teal transition-colors hover:bg-teal/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Zapisz override
          </button>

          <div className="space-y-1">
            <p className="text-xs font-medium text-text-muted">Źródła: {links.length || 0}</p>
            <p className="text-xs text-text-muted">
              Ostatnie zdarzenie: {events[0] ? `${stateLabels[events[0].state]} / ${events[0].source}` : "brak"}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
