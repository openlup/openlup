/** @beta Structural Standard Schema v1 interface; no validator dependency required. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output };
  };
}
/** @beta */
export type Result<Output> = { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly Issue[] };
/** @beta */
export interface Issue {
  readonly message: string;
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[];
}
