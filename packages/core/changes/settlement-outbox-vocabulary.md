- Recognize `commerce.settlement.settled`, already emitted by the platform settlement rail, in `PLATFORM_EVENT_VOCABULARY`. A known settlement fact without a registered consumer can remain pending without blocking a later paid receipt on the same order aggregate. This adds no handler, acknowledgement, delivery or SQL seed.

Migration:

Hosts using the complete vocabulary for readiness must supply an explicit owned `ignored` or `dormant` exemption for this type when they select no consumer. The claim allowlist still derives from handlers; readiness refusal for an unhandled, unexempted type is unchanged. No schema, grant or package-version change is needed in this source fix.
