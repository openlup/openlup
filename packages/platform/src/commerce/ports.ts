/** Host-owned quote options are extended only with a server-bound offer. */
export type CreateQuoteOptions<Options extends object> = Options & { offerVersion?: string };

export interface CommerceQuotePort<Request, Response, Options extends object> {
  createQuote(request: Request, options?: CreateQuoteOptions<Options>): Promise<Response>;
  createServerAuthoritativeQuote?(request: Request, options?: CreateQuoteOptions<Options>): Promise<Response>;
}
