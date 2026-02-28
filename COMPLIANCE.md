# COMPLIANCE.md

Compliance mapping for `@systima/aiact-audit-log` against the EU AI Act (Regulation (EU) 2024/1689).

This document defines the precise boundary of what the library covers and what it does not.

## 1. Scope of Compliance Claims

### 1.1 What this package provides

- **Article 12(1) — technical capability for automatic recording**: Once configured, the logger captures events without manual intervention and operates over the lifetime of the system. The middleware integration automates capture for LLM calls. However, Article 12(1) requires recording of all relevant "events," not only LLM calls. Non-LLM events (human interventions, session boundaries, system events) require explicit instrumentation by the integrator. The package provides the mechanism; the integrator must ensure all relevant event types are captured.
- **Article 12(2) — data infrastructure for traceability**: The schema captures fields that can support risk identification (12(2)(a)), post-market monitoring (12(2)(b)), and deployer monitoring (12(2)(c)). However, whether the captured events are actually "relevant" for these purposes depends on what the integrator instruments and how the system is deployed. The package provides the data capture layer; it does not determine what constitutes a risk-relevant event (that is domain-specific), implement monitoring procedures, or provide deployer access controls.
- **Article 19(1) — retention floor enforcement**: When correctly configured, the logger enforces a 180-day minimum and stores logs in customer-controlled infrastructure. Ongoing retention depends on operational discipline (S3 lifecycle policies, IAM permissions).

### 1.2 This package supports but does not implement

- **Article 9**: Risk management system. The logger provides raw data that feeds into risk management, but does not define what constitutes a risk for a given system, does not implement risk scoring, and does not generate risk assessments.
- **Article 14**: Human oversight design. The logger records human interventions when they occur, but does not design the oversight mechanism, define when human review is required, or enforce oversight procedures.
- **Article 72**: Post-market monitoring procedures. The logger provides the data layer for monitoring (via stats, query, and export), but does not define monitoring KPIs, alert thresholds, or escalation procedures.
- **Annex IV**: Technical documentation. The logger's COMPLIANCE.md and schema documentation contribute to technical documentation, but do not constitute the complete technical documentation package required by Annex IV.
- **Articles 43-44**: Conformity assessment. The hash chain and verification tooling provide evidence for conformity assessment, but the assessment itself is conducted by a notified body or through internal procedures, not by a logging library.

### 1.3 What correct integration requires

Installing the package is not sufficient for Article 12 compliance. The deploying organisation must also:

1. **Ensure coverage**: all relevant events must be logged. This includes every inference call, tool invocation, system error, human override, configuration change, and session boundary. The middleware integration automates capture for LLM calls; other event types require explicit instrumentation. The coverage diagnostic helps identify gaps.
2. **Define "relevant events"**: Article 12(2)(a) requires logging events "relevant for identifying situations that may result in the AI system presenting a risk." What constitutes a relevant event depends on the system's risk profile and intended purpose. The organisation must define this, not the library.
3. **Maintain operational governance**: the library validates configuration on startup and provides health checks, but cannot prevent an operations team from deleting S3 lifecycle policies, disabling Object Lock, or misconfiguring IAM permissions. Ongoing compliance depends on operational discipline.
4. **Integrate with broader compliance architecture**: the logs must feed into the organisation's risk management system (Article 9), post-market monitoring plan (Article 72), and technical documentation (Annex IV).

## 2. What This Package Does Not Cover

The following obligations require organisational processes that a logging library cannot provide:

| Article | Obligation | Why the library cannot implement it |
|---|---|---|
| Article 9 | Risk management system | Requires defining risk criteria specific to the system's intended purpose, performing risk assessments, and implementing mitigation measures. These are organisational and domain-specific decisions. |
| Article 14 | Human oversight design | Requires designing oversight mechanisms, defining intervention criteria, and training personnel. The library records interventions; it cannot design or enforce them. |
| Article 72 | Post-market monitoring | Requires defining KPIs, setting alert thresholds, establishing escalation procedures, and reporting to authorities. The library provides data; the monitoring procedure is organisational. |
| Annex IV | Technical documentation | Requires a comprehensive documentation package covering system description, design choices, training data, validation methods, and more. The audit log schema documentation is one input among many. |
| Article 13 | Transparency and information | Requires providing information to deployers about the system's capabilities, limitations, and intended purpose. Outside the scope of a logging library. |
| Article 15 | Accuracy, robustness, cybersecurity | Requires technical measures for system performance. The logger's hash chain provides integrity evidence; it does not implement accuracy testing or cybersecurity measures. |

## 3. Article-by-Article Field Mapping

### Article 12(1): Automatic recording of events

> "High-risk AI systems shall technically allow for the automatic recording of events (logs) over the lifetime of the system."

| Schema field | How it supports the requirement |
|---|---|
| `entryId` (UUIDv7) | Unique identification of each recorded event |
| `systemId` | Identifies which AI system produced the log |
| `timestamp` (ISO 8601) | Records when each event occurred |
| `seq` (monotonic integer) | Establishes event ordering |
| `prevHash` + `hash` (SHA-256) | Provides tamper evidence for trustworthy recording |
| `captureMethod` | Documents how the event was captured (middleware = automatic) |

The middleware integration (`auditMiddleware`) automates capture for LLM calls by intercepting every model invocation without manual instrumentation. Other event types (human interventions, session boundaries, system events) require explicit `logger.log()` calls by the integrator.

### Article 12(2)(a): Risk identification

> "...events relevant for identifying situations that may result in the high-risk AI system presenting a risk..."

**Note**: This sub-paragraph requires that the events recorded are "relevant for identifying situations that may result in... a risk." What constitutes a relevant event is domain-specific and depends on the system's risk profile and intended purpose. The library provides fields that _can_ support risk identification; whether they _do_ depends on the integrator capturing the right events for their system.

| Schema field | How it supports the requirement |
|---|---|
| `eventType` | Categorises events for risk pattern detection |
| `modelId` | Tracks which model version produced each output |
| `input` | Captures what the system received (raw or hashed) |
| `output` | Captures what the system produced (raw or hashed) |
| `error` | Records error states that may indicate risk |
| `parameters` | Records model configuration at inference time |
| `decisionId` | Correlates related events for decision-level risk analysis |
| `toolCall` | Records tool invocations (key risk vector in agentic systems) |
| `humanIntervention` | Records when humans intervened in system decisions |

### Article 12(2)(b): Post-market monitoring

> "...facilitating the post-market monitoring referred to in Article 72..."

**Note**: This sub-paragraph requires that the logs "facilitate" the post-market monitoring system required by Article 72. The library provides raw data and basic aggregation. It does not implement monitoring procedures, define KPIs, set alert thresholds, or generate the monitoring plan required by Article 72(3). These are organisational responsibilities.

| Schema field | How it supports the requirement |
|---|---|
| `latencyMs` | Enables performance degradation detection |
| `usage` (token counts) | Enables cost and usage trend analysis |
| `error` | Enables error rate monitoring |
| `modelId` | Enables model version drift tracking |
| `output.finishReason` | Enables output quality monitoring |

The `stats` API and CLI command aggregate these fields for monitoring dashboards.

### Article 12(2)(c): Deployer monitoring

> "...monitoring the operation of high-risk AI systems referred to in Article 26(5)."

**Note**: This sub-paragraph requires that the logs support deployer monitoring. The library produces structured, exportable logs but does not address deployer access control, deployer-facing dashboards, or the operational procedures a deployer needs to meet Article 26(5) obligations.

| Schema field | How it supports the requirement |
|---|---|
| All fields | The entire schema is documented and export-friendly (JSON Lines) |
| `metadata` | Extensible key-value pairs for deployer-specific context |
| `humanIntervention` | Records deployer oversight activities |

The `query`, `export`, and `stats` APIs enable deployers to access and analyse log data. How deployers are granted access to the storage backend is an operational concern outside the library's scope.

### Article 12(3): Additional requirements for biometric identification systems

**Scope**: Article 12(3) applies **only** to high-risk AI systems referred to in Annex III, point 1(a) (remote biometric identification systems). It does not apply to other high-risk AI systems.

#### Article 12(3)(a): Usage period recording

> "...recording of the period of each use of the system (start date and time and end date and time of each use)..."

| Schema field | How it supports the requirement |
|---|---|
| `eventType: 'session_start'` | Records the start of a usage session |
| `eventType: 'session_end'` | Records the end of a usage session |
| `timestamp` | Provides the date and time for each boundary |

The library provides these event types but does not auto-detect session boundaries. The integrator must emit `session_start` and `session_end` events explicitly.

#### Article 12(3)(b-d): Biometric-specific fields

| Schema field | How it supports the requirement |
|---|---|
| `referenceDatabase` | 12(3)(b): identifies the reference database checked |
| `matchResult` | 12(3)(c): records whether input matched a database record |
| `humanIntervention.userId` | 12(3)(d): identifies the natural person who verified results |

These fields are optional in the schema. For biometric systems where they are legally required, the integrator must ensure they are populated. The library does not enforce their presence or validate that Article 14(5) dual-person verification requirements are met.

### Article 19(1): Log retention

> "...the logs shall be kept for a period appropriate to the intended purpose of the high-risk AI system, of at least six months..."

| Mechanism | How it supports the requirement |
|---|---|
| `retention.minimumDays` default of 180 | Enforces the six-month floor |
| `ComplianceConfigError` on sub-minimum | Refuses to initialise below 180 days without explicit acknowledgement |
| S3 lifecycle policy management | Automates retention enforcement at the storage layer |
| Health check: `lifecycle_policy_exists` | Detects post-deployment drift in retention configuration |

### Article 19(2): Financial services

> "...providers that are financial institutions subject to requirements regarding their internal governance...shall maintain the logs...as part of the documentation kept under the relevant financial services law."

Supported via `retention.minimumDays: 2555` (7 years) for MiFID II compliance. The logs are stored in S3-compatible storage that can be integrated with existing financial services record-keeping infrastructure.

## 4. Hash Chain Integrity

Each log entry participates in a SHA-256 hash chain:

1. The genesis entry's `prevHash` is the SHA-256 of `@systima/aiact-audit-log:genesis:{systemId}`
2. Each subsequent entry's `prevHash` is the `hash` of the previous entry
3. Each entry's `hash` is the SHA-256 of the entry serialised with deterministic key ordering (excluding the `hash` field itself)

If any entry is modified, deleted, or inserted:
- The `hash` of the modified entry will not match its content
- The `prevHash` of the next entry will not match the `hash` of the modified entry
- The `verify` CLI command reports the break at the exact position

Combined with S3 Object Lock (Compliance mode), this provides strong evidence of log integrity for conformity assessment under Articles 43-44.

## 5. Coverage Diagnostic

The coverage diagnostic (`coverage` command / `analyseCoverage` API) addresses the real compliance risk: not the schema, but incomplete instrumentation. It analyses logs and reports:

- Event type distribution (what is logged, what is missing)
- Capture method distribution (middleware vs. manual)
- Warnings for common gaps (no human interventions, no session boundaries, tool call/result mismatches, long gaps)
- Recommendations for improving coverage

### Warning rules

| Code | Severity | Condition |
|---|---|---|
| `NO_HUMAN_INTERVENTIONS` | medium | Zero `human_intervention` events in period |
| `NO_SESSION_BOUNDARIES` | medium | Zero `session_start`/`session_end` events |
| `TOOL_CALL_RESULT_MISMATCH` | high | Tool call count differs from tool result count by >5% |
| `NO_SYSTEM_EVENTS` | low | Zero `system_event` entries |
| `ALL_MANUAL_CAPTURE` | medium | 100% of entries have `captureMethod: 'manual'` |
| `NO_ERROR_EVENTS` | low | Zero error entries across >1,000 entries |
| `SINGLE_MODEL_ID` | low | Only one model across >100 inference entries |
| `LONG_GAP` | high | Gap of >24 hours between consecutive weekday entries |

## 6. From Logging to Full Compliance

The audit log is the data layer. For a compliance assessment of your specific system covering risk management (Article 9), human oversight design (Article 14), monitoring procedures (Article 72), and technical documentation (Annex IV), contact [Systima](https://systima.ai).
