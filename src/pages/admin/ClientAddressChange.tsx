import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { LucideIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Customer360Address } from "@/domains/support/customer360Contracts";
import {
  operatorNewShippingAddressSchema,
  type OperatorChangeShippingAddressPayload,
  type OperatorNewShippingAddress,
} from "@/domains/support/customerSupportAddressContracts";
import { ActionButton } from "./OrderDetailBlocks";

/**
 * Where the next parcel of one subscription goes.
 *
 * Two destinations, never both: an address the subscriber already saved, or one
 * the operator writes down during the call. The exclusion is the command's own
 * (see `./../../domains/support/customerSupportAddressContracts.ts`), so this
 * panel expresses it the way the operator experiences it - a single choice -
 * rather than as two buttons that can disagree.
 *
 * The three states of `addresses` are three different screens, because they are
 * three different facts. An ABSENT key means the lane never read the address
 * book: saying "this customer has none" there would have an operator take a new
 * address down by hand for a customer who already has the right one saved. An
 * EMPTY array is that positive statement and is allowed to make it. Only a
 * present, non-empty list may be offered as a choice.
 */
export type ChangeAddressPayload = OperatorChangeShippingAddressPayload;

/** The one radio value that is not an address id. */
const NEW_ADDRESS = "new";

const FIELDS = ["recipientName", "line1", "line2", "postalCode", "city", "country", "contactPhone"] as const;
type Field = (typeof FIELDS)[number];
type Draft = Record<Field, string>;

const EMPTY_DRAFT: Draft = {
  recipientName: "", line1: "", line2: "", postalCode: "", city: "", country: "", contactPhone: "",
};

export function ClientAddressChange({
  subscriptionId, currentAddressId, addresses, busy, blockedReason, confirm, icon, onSubmit,
}: {
  subscriptionId: string;
  /** The address this subscription is routed to today, when the lane reported one. */
  currentAddressId: string | null | undefined;
  /** Absent when the address book was not read at all; empty when it holds nothing. */
  addresses: Customer360Address[] | undefined;
  busy: boolean;
  /** Why the whole action is unavailable - an unknown template version, today. */
  blockedReason: string | null;
  confirm: { title: string; description: string; actionLabel: string; cancelLabel: string };
  icon: LucideIcon;
  onSubmit: (payload: ChangeAddressPayload) => void;
}) {
  const { t } = useTranslation("admin");
  const leaf = (name: string) => t(`admin:adminClients.detail.actions.address.${name}`);
  const saved = addresses ?? [];
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState(() => initialChoice(saved, currentAddressId));
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);

  const newAddress = parseNewAddress(draft);
  const payload = choicePayload(choice, currentAddressId, newAddress);
  /**
   * Re-pointing a subscription at the address it already uses is not a change, and
   * the authority would answer `noop`. The operator learns that here instead, where
   * the sentence can say which of the three things is missing.
   */
  const reason = blockedReason
    ?? (choice === "" ? leaf("needChoice") : null)
    ?? (choice === currentAddressId ? leaf("needDifferent") : null)
    ?? (payload === null ? leaf("needFields") : null);

  return (
    <>
      <ActionButton
        icon={icon}
        label={t("admin:adminClients.detail.actions.changeAddress")}
        disabled={busy || blockedReason !== null}
        disabledReason={blockedReason}
        testId={`admin-client-change-address-${subscriptionId}`}
        onClick={() => setOpen(true)}
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="admin-client-address-dialog" className="border-warm-sand bg-white text-teal-dark">
          <DialogHeader>
            <DialogTitle className="text-teal-dark">{leaf("heading")}</DialogTitle>
            <DialogDescription className="text-text-muted">{leaf("intro")}</DialogDescription>
          </DialogHeader>

          {/* The absent case says so out loud. An operator who is not told that the
              address book went unread has no way to tell it apart from an empty one. */}
          {addresses === undefined ? (
            <p className="text-sm text-text-muted" data-testid="admin-client-address-unknown">{leaf("unknownSavedNote")}</p>
          ) : null}

          {saved.length > 0 ? (
            <fieldset className="space-y-2" data-testid="admin-client-address-saved">
              <legend className="label-text text-teal">{leaf("savedHeading")}</legend>
              {saved.map((address) => (
                <AddressOption
                  key={address.addressId}
                  name={`admin-client-address-${subscriptionId}`}
                  value={address.addressId}
                  checked={choice === address.addressId}
                  onSelect={setChoice}
                  label={describeAddress(address)}
                  badge={address.addressId === currentAddressId ? leaf("currentBadge") : null}
                  testId={`admin-client-address-option-${address.addressId}`}
                />
              ))}
              <AddressOption
                name={`admin-client-address-${subscriptionId}`}
                value={NEW_ADDRESS}
                checked={choice === NEW_ADDRESS}
                onSelect={setChoice}
                label={leaf("newOption")}
                badge={null}
                testId="admin-client-address-option-new"
              />
            </fieldset>
          ) : null}

          <fieldset className="space-y-2">
            <legend className="label-text text-teal">{leaf("newHeading")}</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {FIELDS.map((field) => (
                <div key={field} className="space-y-1">
                  <label className="label-text text-text-muted" htmlFor={`admin-client-address-new-${field}`}>
                    {leaf(`field.${field}`)}
                  </label>
                  <Input
                    id={`admin-client-address-new-${field}`}
                    data-testid={`admin-client-address-new-${field}`}
                    className="h-8 text-xs"
                    maxLength={field === "country" ? 3 : undefined}
                    value={draft[field]}
                    // Typing IS the choice: a form filled in under a saved address still
                    // selected would send that saved address and throw the typing away.
                    onChange={(event) => {
                      setChoice(NEW_ADDRESS);
                      setDraft((current) => ({ ...current, [field]: event.target.value }));
                    }}
                  />
                  {field === "country" ? <p className="text-xs text-text-muted">{leaf("countryHint")}</p> : null}
                </div>
              ))}
            </div>
          </fieldset>

          <ActionButton
            icon={icon}
            label={leaf("submit")}
            disabled={busy || payload === null}
            disabledReason={reason}
            confirm={confirm}
            testId="admin-client-address-submit"
            onClick={() => {
              if (payload === null) return;
              onSubmit(payload);
              setOpen(false);
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * What is selected when the panel opens.
 *
 * The address in use is preselected so the operator reads back where parcels go
 * today before moving them, and it submits nothing until something else is
 * chosen. With addresses saved but none of them the current one, nothing is
 * preselected: a guess here would be a guess about somebody's doorstep.
 */
function initialChoice(saved: Customer360Address[], currentAddressId: string | null | undefined): string {
  if (saved.length === 0) return NEW_ADDRESS;
  return saved.some((address) => address.addressId === currentAddressId) ? currentAddressId! : "";
}

/**
 * The payload for the current selection, or `null` while there is not one.
 *
 * The saved arm refuses the current address by construction rather than by a
 * separate guard, so the disabled button and the sent command can never disagree.
 */
function choicePayload(
  choice: string,
  currentAddressId: string | null | undefined,
  newAddress: OperatorNewShippingAddress | null,
): ChangeAddressPayload | null {
  if (choice === NEW_ADDRESS) return newAddress === null ? null : { newAddress };
  if (choice === "" || choice === currentAddressId) return null;
  return { shippingAddressId: choice };
}

/**
 * The command's own schema decides whether the typed address is sendable, rather
 * than a second copy of its rules that could drift from it. Blank optional fields
 * are dropped instead of sent empty, because the schema accepts an absent key and
 * refuses an empty string.
 */
function parseNewAddress(draft: Draft): OperatorNewShippingAddress | null {
  const candidate: Record<string, string> = {};
  for (const field of FIELDS) {
    const value = draft[field].trim();
    if (value !== "") candidate[field] = value;
  }
  const parsed = operatorNewShippingAddressSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** One line an operator can read back over the phone. */
function describeAddress(address: Customer360Address): string {
  return [
    address.label,
    address.recipientName,
    address.line1,
    address.line2,
    [address.postalCode, address.city].join(" "),
    address.country,
  ].filter((part) => part !== null && part.trim() !== "").join(", ");
}

function AddressOption({ name, value, checked, onSelect, label, badge, testId }: {
  name: string;
  value: string;
  checked: boolean;
  onSelect: (value: string) => void;
  label: string;
  badge: string | null;
  testId: string;
}) {
  return (
    <label className="flex items-start gap-2 rounded-control border border-warm-sand p-2 text-sm text-teal-dark">
      <input
        type="radio"
        className="focus-ring mt-1"
        name={name}
        value={value}
        checked={checked}
        data-testid={testId}
        onChange={() => onSelect(value)}
      />
      <span>
        <span className="block">{label}</span>
        {badge === null ? null : (
          <span className="label-text mt-0.5 block text-teal" data-testid={`${testId}-current`}>{badge}</span>
        )}
      </span>
    </label>
  );
}
