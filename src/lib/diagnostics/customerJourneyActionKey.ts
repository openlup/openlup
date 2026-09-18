let fallbackSequence = 0;

export function createCustomerJourneyActionKey(): string {
  try {
    const randomUuid = globalThis.crypto?.randomUUID;
    if (randomUuid) return randomUuid.call(globalThis.crypto);
  } catch {
    // Restricted contexts can expose Web Crypto but deny calls into it.
  }

  try {
    const bytes = new Uint8Array(16);
    const getRandomValues = globalThis.crypto?.getRandomValues;
    if (getRandomValues) return formatUuid(getRandomValues.call(globalThis.crypto, bytes));
  } catch {
    // Fall through to the anonymous non-Web-Crypto source.
  }

  try {
    const bytes = new Uint8Array(16);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
    return formatUuid(bytes);
  } catch {
    fallbackSequence = (fallbackSequence + 1) % 0x1_0000_0000;
    return `00000000-0000-4000-8000-${fallbackSequence.toString(16).padStart(12, "0")}`;
  }
}

function formatUuid(bytes: Uint8Array): string {
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return [...bytes].map((byte, index) => `${byte.toString(16).padStart(2, "0")}${[3, 5, 7, 9].includes(index) ? "-" : ""}`).join("");
}
