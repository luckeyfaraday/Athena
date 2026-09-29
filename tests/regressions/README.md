# Backend regression tests

Permanent tests in this directory protect backend resource bounds, cleanup, session-discovery behavior, and the guarantee that Athena never writes state into user project directories. Each fixed production failure must have an executable test here.
