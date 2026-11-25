import { z } from 'zod';
import { configuredLocales, type Localized } from './locales.ts';

const localized = (copy: (locale: typeof configuredLocales[number]) => string) =>
  Object.fromEntries(configuredLocales.map(locale => [locale, copy(locale)])) as Localized;

/** Selects the starter's display copy from the public product presentation. */
export const starterPresentationSchema = z.object({
  title: z.string().max(500).refine(value => value.trim().length > 0),
  shortName: z.record(z.string(), z.string().min(1).max(500)).optional(),
  mediaRef: z.string().max(240).regex(/^\/media\/[A-Za-z0-9][A-Za-z0-9._-]*(?![\s\S])/u).optional(),
}).transform(({ title, shortName, mediaRef }) => {
  const name = localized(locale => shortName?.[locale] ?? title);
  return { title, name, media: mediaRef ?? '', mediaAlt: { ...name },
    description: localized(() => ''), details: localized(() => ''), contents: '' };
});
export type StarterPresentation = z.output<typeof starterPresentationSchema>;

export function mapStarterPresentation(value: unknown): StarterPresentation | undefined {
  return starterPresentationSchema.safeParse(value).data;
}
