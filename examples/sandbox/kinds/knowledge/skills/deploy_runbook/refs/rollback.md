# Rolling back a release

1. Stop the rollout before touching data.
2. Re-deploy the previous bundle.
3. Only then reverse the migration, if it was not additive.

Reversing the migration first strands the running code against a schema it does
not expect, which turns a bad release into an outage.
