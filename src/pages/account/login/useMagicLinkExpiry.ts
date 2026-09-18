import { useEffect, useMemo, useState } from 'react';

const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;

export function useMagicLinkExpiry(active: boolean, language: string) {
  const [sentAtMs, setSentAtMs] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const displaySentAtMs = active ? sentAtMs ?? nowMs : null;
  const expiresAtMs = displaySentAtMs ? displaySentAtMs + MAGIC_LINK_TTL_MS : null;
  const expired = Boolean(expiresAtMs && nowMs >= expiresAtMs);
  const timeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(language, {
        hour: '2-digit',
        minute: '2-digit',
      }),
    [language],
  );

  useEffect(() => {
    if (!active || !expiresAtMs || expired) return undefined;
    const tick = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [active, expiresAtMs, expired]);

  return {
    expired,
    sentAtLabel: displaySentAtMs ? timeFormatter.format(new Date(displaySentAtMs)) : '',
    expiresAtLabel: expiresAtMs ? timeFormatter.format(new Date(expiresAtMs)) : '',
    markSent() {
      const sentAt = Date.now();
      setSentAtMs(sentAt);
      setNowMs(sentAt);
    },
    reset() {
      setSentAtMs(null);
    },
  };
}
