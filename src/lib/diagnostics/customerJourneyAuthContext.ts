let currentAccessToken: string | null = null;

export function setCustomerJourneyAuthContext(accessToken: string | null): void {
  currentAccessToken = accessToken;
}

export function readCustomerJourneyAuthContext(): string | null {
  return currentAccessToken;
}
