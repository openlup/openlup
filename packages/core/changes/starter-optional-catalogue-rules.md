### Starter catalogue rules

Keep your existing `owned/catalogue.ts` validator when you upgrade. The
upgrade leaves the new rules bundle and test absent. To switch to installed
rules, copy `owned/catalogue-rules.cjs` and `owned/catalogue-rules.test.cjs`
from a fresh extraction of the target starter and move your content checks
to the bundle's `validateContent`. Run `node --test owned/catalogue-rules.test.cjs`,
then `./lifecycle up` to use those rules in the operator form.
