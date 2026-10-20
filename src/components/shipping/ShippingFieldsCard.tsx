import type { ReactNode } from "react";

/** Manual address entry; format policy and validation belong to the caller. */
export function ShippingFieldsCard({ data, errors, update, children }: {
  data: { street: string; postalCode: string; city: string; country: string; phone: string };
  errors: Partial<Record<keyof typeof data, string>>;
  update: (patch: Partial<typeof data>) => void;
  children?: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-warm-sand bg-white p-5">
      <h2 className="font-display text-[16px] font-semibold text-teal-dark">Adres dostawy</h2>
      {([
        ["street", "Ulica i numer", "street-address"],
        ["postalCode", "Kod pocztowy", "postal-code"],
        ["city", "Miejscowość", "address-level2"],
        ["country", "Kraj", "country-name"],
        ["phone", "Telefon do dostawy", "tel"],
      ] as const).map(([field, label, autoComplete]) => (
        <label key={field} className="mb-2 flex flex-col gap-1 text-sm">
          {label}
          <input value={data[field]} autoComplete={autoComplete} type={field === "phone" ? "tel" : "text"}
            onChange={(event) => update({ [field]: event.target.value })}
            aria-invalid={Boolean(errors[field])} aria-describedby={errors[field] ? `ship-${field}-error` : undefined}
            className="rounded-lg border border-warm-sand p-2" />
          {errors[field] && <span id={`ship-${field}-error`} role="alert">{errors[field]}</span>}
        </label>
      ))}
      {children}
    </section>
  );
}
