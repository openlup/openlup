For the next 1.x release. Adds JSDoc `@deprecated` notices to legacy 1.x
fulfillment UI label helpers (`stepLabelKey`, `timelineLabelForStep`) and the
legacy `PaymentMethodCaptureHandoff` union, pointing adopters to their existing
1.x replacements (`FULFILLMENT_STATUS_EFFECTS` and `toCoreCaptureHandoff` /
`fromCoreCaptureHandoff`) ahead of 2.0.0.

Migration: no runtime or type changes in 1.x. Adopters can migrate incrementally
to `FULFILLMENT_STATUS_EFFECTS`, application-owned i18n, and
`toCoreCaptureHandoff` / `fromCoreCaptureHandoff` before 2.0.0.
