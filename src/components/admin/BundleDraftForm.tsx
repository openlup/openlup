import { useEffect } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { createBundleDraftPayloadSchema } from "@/domains/bundle/adminBundleContracts";
import { CARD, CARD_TITLE, BTN_PRIMARY, ERR, FIELD, LABEL } from "./bundleAdminUi";

/**
 * The bundle's own structural fields — identity and title, nothing else.
 *
 * Validated client-side against the SAME shipped write contract the BFF and the
 * MCP agent head validate against (`createBundleDraftPayloadSchema`), narrowed by
 * `.pick` to the fields this form actually offers. Narrowing rather than restating
 * is the point: the code format, the title bounds and their messages have exactly
 * one definition, so this form cannot drift into accepting something the write
 * path will refuse.
 *
 * Two modes, one form. Creating asks for a code; editing does not offer it,
 * because a bundle's code is its identity — an operator who wants a different
 * code is cloning, which is a different operation with its own route.
 *
 * `fulfillmentMode` is shown READ-ONLY as `virtual`. The stored column and the
 * contract both admit `kitted`, deliberately, so the schema never has to widen —
 * but only the exploded mode has a runtime, and `FULFILLMENT_MODE_UNSUPPORTED` is
 * the refusal an operator would earn by choosing the other one. Displaying the
 * value without offering the choice states the truth without staging a rejection.
 */

const createFields = createBundleDraftPayloadSchema.pick({ code: true, title: true });
const editFields = createBundleDraftPayloadSchema.pick({ title: true });

export interface BundleDraftFormValues {
  code?: string;
  title: string;
}

/**
 * Edit mode seeds NO `code` key at all, rather than seeding an empty one.
 *
 * Both schemas are `.strict()` (picked from a strict contract), and react-hook-form
 * validates the whole values object, not only the registered fields. A leftover
 * `code: ""` therefore made the edit form fail validation on an unrecognized key —
 * silently, since the field it named is not rendered in this mode, so there was
 * nowhere to show the error and the save button simply did nothing.
 */
function seedValues(isEdit: boolean, initialTitle: string | undefined): BundleDraftFormValues {
  return isEdit ? { title: initialTitle ?? "" } : { code: "", title: initialTitle ?? "" };
}

export function BundleDraftForm({
  editingCode,
  initialTitle,
  pending,
  onSubmit,
}: {
  /** The code being edited, or `undefined` to create a new draft. */
  editingCode?: string;
  initialTitle?: string;
  pending: boolean;
  onSubmit: (values: BundleDraftFormValues) => void;
}) {
  const { t } = useTranslation("admin");
  const isEdit = editingCode !== undefined;
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<BundleDraftFormValues>({
    resolver: zodResolver(isEdit ? editFields : createFields) as never,
    defaultValues: seedValues(isEdit, initialTitle),
  });

  // Selecting a different bundle must re-seed the field, otherwise the operator
  // edits the previous bundle's title under the new bundle's heading.
  useEffect(() => {
    reset(seedValues(isEdit, initialTitle));
  }, [isEdit, editingCode, initialTitle, reset]);

  return (
    <section className={CARD}>
      <h2 className={`mb-4 ${CARD_TITLE}`}>
        {isEdit ? t("admin:adminBundles.draft.editTitle") : t("admin:adminBundles.draft.createTitle")}
      </h2>
      <form className="grid gap-3" onSubmit={handleSubmit(onSubmit)} noValidate>
        {isEdit ? (
          <div>
            <span className={LABEL}>{t("admin:adminBundles.draft.code")}</span>
            <p className="mt-1 font-mono text-sm text-teal-dark">{editingCode}</p>
          </div>
        ) : (
          <div>
            <label className={LABEL} htmlFor="bundle-code">
              {t("admin:adminBundles.draft.code")}
            </label>
            <input
              id="bundle-code"
              className={FIELD}
              placeholder={t("admin:adminBundles.draft.codePlaceholder")}
              aria-invalid={errors.code ? true : undefined}
              {...register("code")}
            />
            {errors.code && <p className={ERR}>{errors.code.message}</p>}
          </div>
        )}

        <div>
          <label className={LABEL} htmlFor="bundle-title">
            {t("admin:adminBundles.draft.name")}
          </label>
          <input
            id="bundle-title"
            className={FIELD}
            aria-invalid={errors.title ? true : undefined}
            {...register("title")}
          />
          {errors.title && <p className={ERR}>{errors.title.message}</p>}
        </div>

        <div>
          <span className={LABEL}>{t("admin:adminBundles.draft.fulfillmentMode")}</span>
          <p className="mt-1 text-sm text-teal-dark">
            <span className="rounded bg-offwhite/10 px-2 py-0.5 font-mono text-xs">virtual</span>
            <span className="ml-2 text-xs text-text-muted">
              {t("admin:adminBundles.draft.fulfillmentModeNote")}
            </span>
          </p>
        </div>

        <div className="flex justify-end">
          <button type="submit" disabled={pending} className={BTN_PRIMARY}>
            {pending
              ? t("admin:adminBundles.draft.saving")
              : isEdit
                ? t("admin:adminBundles.draft.save")
                : t("admin:adminBundles.draft.create")}
          </button>
        </div>
      </form>
    </section>
  );
}
