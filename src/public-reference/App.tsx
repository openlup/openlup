export type PublicReferenceEntry = {
  path: string;
  title: string;
  summary: string;
  detail: string;
};

export const PUBLIC_REFERENCE_ENTRIES: readonly PublicReferenceEntry[] = [
  {
    path: "/items/field-notes",
    title: "Field notes",
    summary: "A small static record for reviewing the public runtime surface.",
    detail: "This entry is intentionally read-only. It demonstrates list and detail rendering without an account or external service.",
  },
];

function NotFound(): JSX.Element {
  return (
    <main>
      <h1>Public reference not found</h1>
      <p>The requested reference page is not declared.</p>
      <a href="/">Return to the reference collection</a>
    </main>
  );
}

function ReferenceIndex(): JSX.Element {
  return (
    <main>
      <h1>Reference collection</h1>
      <p>A zero-configuration, read-only example for the exported public runtime.</p>
      <ul>
        {PUBLIC_REFERENCE_ENTRIES.map((entry) => (
          <li key={entry.path}>
            <a href={entry.path}>{entry.title}</a>
            <p>{entry.summary}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}

function ReferenceDetail({ entry }: { entry: PublicReferenceEntry }): JSX.Element {
  return (
    <main>
      <h1>{entry.title}</h1>
      <p>{entry.detail}</p>
      <a href="/">Back to the reference collection</a>
    </main>
  );
}

/** The complete page switch for the public-reference client and SSR roots. */
export function PublicReferenceApp({ pathname }: { pathname: string }): JSX.Element {
  if (pathname === "/") return <ReferenceIndex />;
  const entry = PUBLIC_REFERENCE_ENTRIES.find((candidate) => candidate.path === pathname);
  return entry ? <ReferenceDetail entry={entry} /> : <NotFound />;
}
