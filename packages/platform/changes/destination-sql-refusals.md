### Handle native destination snapshot and read refusals

- Check for `outcome: "refused"` in the returned JSON before handling success.
  Roll back any caller-owned snapshot transaction before returning a refusal.
  Direct receipt routines retain their SQL diagnostics.
