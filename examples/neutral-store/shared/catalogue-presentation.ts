import { z } from 'zod';
import { configuredLocales, type Localized } from './locales.ts';

const localized = z.object(Object.fromEntries(configuredLocales.map(locale => [locale, z.string()])))
  .transform(value => value as Localized);
const blank = () => Object.fromEntries(configuredLocales.map(locale => [locale, ''])) as Localized;

/** Selects the starter's display copy from the public product presentation. */
export const starterPresentationSchema = z.object({
  title: z.string().refine(value => value.trim().length > 0),
  name: localized,
  description: localized,
  media: z.string().regex(/^\/media\/[A-Za-z0-9][A-Za-z0-9._-]*(?![\s\S])/u),
  mediaAlt: localized,
  details: localized.optional().transform(value => value ?? blank()),
  contents: z.string().default(''),
});
export type StarterPresentation = z.output<typeof starterPresentationSchema>;

export function mapStarterPresentation(value: unknown): StarterPresentation | undefined {
  return starterPresentationSchema.safeParse(value).data;
}
