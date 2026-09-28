# Changelog

All notable changes to `@systima/aiact-audit-log` are recorded here.

## 0.2.0

Three configuration options named a protection the code did not request. Versions
before 0.2.0 are deprecated on npm for this reason.

Reported by **kta1kri**, who traced the full `write()` path through `s3.ts`,
`logger.ts` and `interface.ts` and reported the first two findings privately in
September 2026. The report was accurate down to the line numbers and is the
reason for this release.

### Fixed

- **`objectLock` never reached storage.** The option was stored in the
  constructor and serialised into `_meta/config.json`, but `PutObjectCommand`
  carried only `Bucket`, `Key`, `Body` and `ContentType`. A deployer setting
  `mode: 'COMPLIANCE'` received the same protection as one leaving the default,
  which is none. `StorageBackend.write()` now takes a `WriteOptions` argument,
  and `S3Storage` sends `ObjectLockMode` and `ObjectLockRetainUntilDate` for
  entry files and for `_chain/head.json`. Operational objects (health probe,
  schema marker, config snapshot) are written unlocked, so a restarting process
  does not accumulate locked versions of files that carry no evidence.
- **Nothing verified that a bucket had Object Lock.** The new
  `object_lock_configured` health check calls `GetObjectLockConfiguration` and
  fails when `objectLock.enabled` is set against a bucket without it. Object
  Lock can only be enabled at bucket creation, so the message says the bucket
  must be replaced rather than reconfigured. Constructing a logger with
  `objectLock.enabled` against a backend that cannot enforce write-once
  retention now throws `ComplianceConfigError`.
- **Lifecycle retention was never configured.** `src/utils/retention.ts`
  implemented lifecycle configuration correctly but had no importer and was not
  exported, so `retention.autoConfigureLifecycle` defaulting to `true`
  configured nothing. `applyRetentionPolicy()` now runs on `init()`, failures
  surface through `onError` rather than being swallowed, and the helpers are
  exported for out-of-band management when the runtime credential lacks
  `s3:PutLifecycleConfiguration`. Found while tracing the first finding.
- **`lifecycle_policy_exists` did not exist.** COMPLIANCE.md named this health
  check; the codebase had no such check. It is now real, and fails on a missing
  rule or one shorter than the configured retention.
- **Author email bounced.** `package.json` advertised `hello@systima.ai`, which
  is not a configured address. It is now `contact@systima.ai`.

### Added

- **`integrity.hmacKey`** chains entries with HMAC-SHA256 instead of bare
  SHA-256, seeding genesis under the key too. An unkeyed chain takes no secret,
  so anyone able to overwrite objects under the prefix can recompute a
  self-consistent replacement that `verifyChain` reports as valid. Entries
  record `hashAlgorithm`, but verification always uses the key the caller
  supplies and never the field, so stripping it cannot downgrade a chain.
  `AuditLogReader` takes the same option, and the CLI takes `--hmac-key` or
  `AIACT_HMAC_KEY`.
- **`logger.getChainHead()`** returns the current head for anchoring in a
  separate trust domain. The logging process necessarily holds the HMAC key, so
  a keyed chain does not survive compromise of that process, and neither the
  chain nor Object Lock carries a trusted timestamp. External anchoring is the
  only one of the three mechanisms that establishes when an entry existed.
- **Optional retention capabilities on `StorageBackend`**:
  `getObjectLockStatus`, `getRetentionPolicyStatus` and
  `configureRetentionPolicy`, implemented only by `S3Storage`. The filesystem
  and memory backends report the capability as unavailable rather than
  appearing to provide it.

### Changed

- **Integrity claims are scoped to what the code enforces.** README.md and
  COMPLIANCE.md section 4 carry the same table setting out what each
  configuration detects: unkeyed SHA-256, HMAC chaining, Object Lock, and
  external anchoring, against accidental corruption, tampering by someone with
  bucket write access, and proof of write time. The default is described as
  tamper-evident against corruption and casual modification, and no more. The
  claims that the chain "combined with S3 Object Lock (Compliance mode)"
  provided strong evidence for Articles 43-44, and that a regulator could
  independently verify integrity, are both gone.
- **Article 19(1) mapping no longer conflates a lifecycle rule with retention
  enforcement.** A rule bounds how long objects are kept; it does not prevent
  earlier deletion. That requires Object Lock or restrictive IAM.
- **Sector guidance notes the GDPR interaction.** `COMPLIANCE` mode makes an
  Article 17 erasure request unsatisfiable by deletion, so personal data under
  long retention should be hashed or held under `GOVERNANCE` mode.

### Compatibility

Existing unkeyed logs verify unchanged and entries gain no new required field.
The minor version reflects the optional `WriteOptions` parameter and capability
methods on `StorageBackend`, and the new `ComplianceConfigError` when
`objectLock.enabled` is set against a backend that cannot honour it.
