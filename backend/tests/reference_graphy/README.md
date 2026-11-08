# Legacy behavior oracle — tests only

Snapshot of the Python backend before the complete Rust migration. Retained solely
for original regression tests and differential fixtures. Not included in the wheel,
not used by the production launcher, and never called by the Rust runtime.
Legacy test assertions remain intact; new Rust unit/integration and black-box HTTP
tests validate the actual migrated backend. Report their results separately.
