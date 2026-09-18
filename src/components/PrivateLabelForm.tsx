import { useRef, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Loader2, CheckCircle2 } from "lucide-react";
import { CompanyField } from "@/components/forms/fields/CompanyField";
import { EmailField } from "@/components/forms/fields/EmailField";
import { NameField } from "@/components/forms/fields/NameField";
import {
  B2B_COUNTRIES,
  PRIVATE_LABEL_INITIAL_VALUES,
  privateLabelSchema,
  type PrivateLabelFormValues,
} from "@/components/private-label/privateLabelFormModel";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createPartnerInquiryIdempotencyKey,
  submitPublicB2BInquiry,
} from "@/domains/partners/publicB2BInquiryClient";
import { BffClientError } from "@/lib/bff/client";
import { cn } from "@/lib/utils";

const fieldItemCls =
  "[&>label]:font-body [&>label]:text-xs [&>label]:font-semibold [&>label]:text-charcoal/70 [&>label]:uppercase [&>label]:tracking-wide [&>p]:font-body [&>p]:text-xs";
const inputCls = "aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive/30";
const textareaCls = cn("resize-none", inputCls);

export default function PrivateLabelForm() {
  const { t } = useTranslation("b2b");
  const privateLabelForm = useForm<PrivateLabelFormValues>({
    defaultValues: PRIVATE_LABEL_INITIAL_VALUES,
    resolver: zodResolver(privateLabelSchema),
  });
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const honeypotRef = useRef<HTMLInputElement>(null);
  const idempotencyKeyRef = useRef(createPartnerInquiryIdempotencyKey());
  const emailError = privateLabelForm.formState.errors.email;
  const notes = privateLabelForm.watch("notes") ?? "";

  const handleSubmit = async (form: PrivateLabelFormValues) => {
    // Honeypot — silent accept
    if (honeypotRef.current?.value) {
      setStatus("success");
      return;
    }
    setStatus("loading");
    setErrorMsg("");
    try {
      const response = await submitPublicB2BInquiry({
        company: form.company,
        country: form.country,
        firstName: form.firstName,
        lastName: form.lastName,
        email: form.email,
        phone: form.phone || null,
        notes: form.notes || null,
      }, {
        headers: { "Idempotency-Key": idempotencyKeyRef.current },
      });

      if (!response.success) {
        setErrorMsg(t("b2b:form.errorGeneric"));
        setStatus("error");
        return;
      }
      setStatus("success");
    } catch (error) {
      setErrorMsg(t(`b2b:form.${mapB2BSubmitError(error)}`));
      setStatus("error");
    }
  };

  if (status === "success") {
    return (
      <div className="flex flex-col items-center text-center gap-4 py-8">
        <CheckCircle2 className="w-12 h-12 text-teal" strokeWidth={1.5} />
        <h3 className="font-display font-semibold text-xl text-teal-dark">
          {t("b2b:form.successTitle")}
        </h3>
        <p className="font-body text-sm text-charcoal/65 leading-relaxed max-w-[280px]">
          {t("b2b:form.successBody")}
        </p>
      </div>
    );
  }

  return (
    <Form {...privateLabelForm}>
      <div
        role="form"
        aria-label={t("b2b:form.heading")}
        className="space-y-4"
      >
        <noscript>
          <p className="rounded-xl border border-border bg-muted p-4 font-body text-xs-plus text-charcoal/70">
            {t("b2b:form.noScriptPrefix")}{" "}
            <a className="font-semibold text-teal-dark underline" href="mailto:hello@openlup.com">
              hello@openlup.com
            </a>
            {t("b2b:form.noScriptSuffix")}
          </p>
        </noscript>
        <div
          onKeyDown={(event) => {
            if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement)) return;
            event.preventDefault();
            void privateLabelForm.handleSubmit(handleSubmit, () => {
              setStatus("idle");
              setErrorMsg("");
            })();
          }}
        >
        <div
          aria-hidden="true"
          style={{ position: "absolute", left: "-9999px", opacity: 0, pointerEvents: "none" }}
        >
          <input
            ref={honeypotRef}
            name="openlup_internal_check"
            type="text"
            tabIndex={-1}
            autoComplete="new-password"
            aria-hidden="true"
            data-lpignore="true"
            data-1p-ignore="true"
            data-form-type="other"
            defaultValue=""
          />
        </div>

        <CompanyField
          className={fieldItemCls}
          control={privateLabelForm.control}
          inputClassName={inputCls}
          label={t("b2b:form.companyName")}
          name="company"
          placeholder="Acme Pet Foods"
          required
        />

        <FormField
          control={privateLabelForm.control}
          name="country"
          render={({ field }) => (
            <FormItem className={fieldItemCls}>
              <FormLabel required>{t("b2b:form.country")}</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger className={inputCls}>
                    <SelectValue placeholder={t("b2b:form.selectCountry")} />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {B2B_COUNTRIES.map(({ code, label }) => (
                    <SelectItem key={code} value={code}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-2 gap-3">
          <NameField
            autoComplete="given-name"
            className={fieldItemCls}
            control={privateLabelForm.control}
            inputClassName={inputCls}
            label={t("b2b:form.firstName")}
            name="firstName"
            placeholder="Jane"
            required
          />
          <NameField
            autoComplete="family-name"
            className={fieldItemCls}
            control={privateLabelForm.control}
            inputClassName={inputCls}
            label={t("b2b:form.lastName")}
            name="lastName"
            placeholder="Smith"
            required
          />
        </div>

        <EmailField
          className={fieldItemCls}
          control={privateLabelForm.control}
          description={emailError ? undefined : t("b2b:form.emailBlockedDomain")}
          inputClassName={inputCls}
          label={t("b2b:form.email")}
          name="email"
          placeholder="jane@yourcompany.com"
          required
        />

        <FormField
          control={privateLabelForm.control}
          name="phone"
          render={({ field }) => (
            <FormItem className={fieldItemCls}>
              <FormLabel>{t("b2b:form.phone")}</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  className={inputCls}
                  inputMode="tel"
                  placeholder="+49 30 123 456"
                  type="tel"
                  value={field.value ?? ""}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={privateLabelForm.control}
          name="notes"
          render={({ field }) => (
            <FormItem className={fieldItemCls}>
              <FormLabel>{t("b2b:form.notes")}</FormLabel>
              <FormControl>
                <Textarea
                  {...field}
                  className={textareaCls}
                  maxLength={1000}
                  placeholder={t("b2b:form.notesPlaceholder")}
                  rows={3}
                  value={field.value ?? ""}
                />
              </FormControl>
              <p className="text-xxs text-muted-foreground mt-1 text-right">
                {notes.length}/1000
              </p>
              <FormMessage />
            </FormItem>
          )}
        />

        {status === "error" && errorMsg && (
          <p className="text-xs-plus text-destructive font-body">{errorMsg}</p>
        )}

        {/* This is intentionally not a native submit control. The BFF accepts JSON,
            not form encoding, so static HTML must never fall back to a GET carrying
            contact data in the URL. The noscript block above is the safe fallback. */}
        <button
          type="button"
          onClick={() => {
            void privateLabelForm.handleSubmit(handleSubmit, () => {
              setStatus("idle");
              setErrorMsg("");
            })();
          }}
          disabled={status === "loading"}
          className="w-full bg-teal-dark hover:bg-teal/90 disabled:opacity-60 disabled:cursor-not-allowed text-offwhite font-body font-bold text-sm px-6 py-3.5 rounded-xl transition-colors flex items-center justify-center gap-2"
        >
          {status === "loading" ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              {t("b2b:form.submitting")}
            </>
          ) : (
            t("b2b:form.submit")
          )}
        </button>
        </div>
      </div>
    </Form>
  );
}

function mapB2BSubmitError(error: unknown): string {
  if (!(error instanceof BffClientError)) return "errorGeneric";
  const reason = readErrorReason(error.details);
  if (error.code === "RATE_LIMITED" || reason === "rate_limit") return "errorRateLimit";
  if (reason === "blocked_email_domain") return "errorBlockedEmail";
  if (error.code === "BAD_REQUEST" || reason === "validation_error") return "errorValidation";
  return "errorGeneric";
}

function readErrorReason(details: unknown): string | null {
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const reason = (details as Record<string, unknown>).reason;
  return typeof reason === "string" ? reason : null;
}
