import type { ReactNode } from "react";

/**
 * Shared cream form primitives for the V2 account editors (Address, Pet,
 * Profile, Billing). Kept minimal + tokenised so every form looks identical.
 */

export const inputCls =
  "focus-ring w-full rounded-control border border-teal-dark/15 bg-card px-3 py-2 text-foreground outline-none";

export function FieldShell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-foreground/65">{label}</span>
      {children}
    </label>
  );
}

export function TextField({
  label,
  value,
  onChange,
  required,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  type?: "text" | "tel" | "email" | "number";
}) {
  return (
    <FieldShell label={label}>
      <input
        className={inputCls}
        type={type}
        value={value}
        required={required}
        onChange={(event) => onChange(event.target.value)}
      />
    </FieldShell>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
}) {
  return (
    <FieldShell label={label}>
      <select className={inputCls} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

export function CheckboxField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-foreground/75">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="size-4 accent-teal"
      />
      {label}
    </label>
  );
}
