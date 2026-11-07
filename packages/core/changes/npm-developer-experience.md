- Ship declaration maps that navigate to the packaged TypeScript sources,
  consumer-first installation guidance and release-tagged agent source citations.
- Allow Node `>=24` while
  retaining Node 24 for contributor verification. Pin exact package versions and
  upgrade the OpenLup set together.
- The tool-only installed context lookup accepts release citations only for its
  own package and installed version, and deduplicates shared canonical owners
  across the matching package set without fetching links.
