### Validate checkout destination addresses with a host policy

- Use the experimental checkout schema and address policy to admit subdivision,
  normalize postal codes and classify destinations. Discover native issuance
  readiness with `destinationV2Capabilities` and find the host binding through
  the read-only `shipping.addressPolicy` setting. Managed v2 issuance and v2
  saved addresses report unsupported. Existing v1 checkout commands retain
  their address contract.
