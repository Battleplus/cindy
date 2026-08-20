-- 0093: repair malformed custom_providers.updated_at values.
-- Data repair runs in the companion script so it can normalize legacy text and
-- preserve SQLite migration replay semantics.
SELECT 1;
