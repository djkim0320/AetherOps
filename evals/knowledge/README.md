# Knowledge gold gates

`identity-merge-gold-v1.json` measures the precision of the production exact-ID
and unique exact-alias identity path. Translation, abbreviation, similar-name,
ambiguous-alias, class-mismatch, and uncurated-alias cases are negative controls.

`evidence-span-gold-v1.json` binds UTF-8 byte offsets and SHA-256 values to exact
Korean, English, mixed-language, emoji, CRLF, trimmed, and overlapping-chunk CAS
spans. The Go gate stores every source in the real CAS and invokes the production
evidence mapper.

The release thresholds are auto-merge precision >= 99% and evidence span
accuracy >= 98%. Lowering either threshold or changing a fixture schema version
causes the tests to fail closed.
