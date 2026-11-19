# Loan lead sharing — wire contract (Phase 1)

Converge (B2B partner portal) ↔ Collegepond Enrollment App (Firebase).
Spec: "B2B Loan Lead Sharing — Converge ↔ Enrollment App" (Claude Doc, 19 Nov 2026).
Both repos must follow this file exactly. Change it in both places together.

## Signing (both directions)

Every request is `POST`, `Content-Type: application/json`, with:

| Header | Value |
| --- | --- |
| `x-cp-timestamp` | Unix time in **seconds**, as a decimal string |
| `x-cp-signature` | lowercase hex `HMAC-SHA256(secret, "<timestamp>.<raw body>")` |

The receiver recomputes over the **raw** body bytes, compares with a timing-safe
equal (length checked first), and rejects with **401** when the signature is
wrong or `|now − timestamp| > 300` seconds.

Two secrets, one per direction:

| Direction | Converge env | Enrollment `secureSettings/integrations` field |
| --- | --- | --- |
| Converge → Enrollment | `ENROLLMENT_LOAN_SECRET` | `convergeInboundSecret` |
| Enrollment → Converge | `ENROLLMENT_WEBHOOK_SECRET` | `convergeOutboundSecret` |

Enrollment also needs `convergeWebhookUrl` (full URL of the Converge route
below) in the same doc. Converge needs `ENROLLMENT_LOAN_URL` (full URL of the
`partnerLoanIntake` function). Either side with its secret unset answers
**503** and sends nothing.

## 1. Referral — Converge → Enrollment

`POST <ENROLLMENT_LOAN_URL>` (Cloud Function `partnerLoanIntake`, us-central1)

```json
{
  "referralId": "0f9c6c1e-6a52-4f0e-9a43-7d3d2b1c9e10",
  "partner": { "key": "org:12", "name": "Bright Futures Overseas" },
  "referredBy": { "userId": 45, "name": "Priya Shah" },
  "student": {
    "convergeStudentId": 1234,
    "name": "Rohan Mehta",
    "phone": "+919812345678",
    "email": "rohan@example.com",
    "intake": "Fall 2027",
    "country": "United Kingdom",
    "university": "University of Leeds",
    "courseLevel": "Masters",
    "loanAmount": 2500000,
    "note": "Father is co-applicant"
  },
  "consentAt": "2026-11-19T10:15:00.000Z"
}
```

- `partner.key` is `org:<organization.id>` for an agency, `user:<user.id>` for an
  independent counsellor. It is the stable identity; `name` is display only.
- `student.convergeStudentId` is `null` for a loan-only referral.
- `phone` is E.164 (`+` and digits). `university`, `courseLevel`, `loanAmount`
  (INR, number), `note`, `country` may be `null`. `name`, `phone`, `email`,
  `intake` are always present.
- `referralId` is the idempotency key: the same id sent again must return the
  first answer and create nothing.

Response **200**:

```json
{ "result": "created", "loanLeadId": "AbC123..." }
```

`result` is `"created"` (new lead, carries `convergeRef`) or `"duplicate"`
(the student was already a loan lead; nothing is mirrored back for it).

Errors: **400** `{ "error": "<why>" }` for a malformed body (Converge marks the
referral failed and does not retry), **401** bad signature, **503** not
configured, **5xx** anything else (Converge retries). A referral another
request is still processing answers **500** (retry); a processing claim left by
a crash is taken over after 2 minutes. A retry whose earlier attempt already
created the lead answers `created` again.

### What Enrollment does

1. `partnerReferrals/{referralId}` exists → return its stored `{result, loanLeadId}`.
2. Find `businessPartners` where `convergePartnerKey == partner.key`; none →
   create one (`name` from payload, `convergePartnerKey`, `active: true`,
   `viewerUids`: admins and loan managers, `createdBy: "converge"`).
3. Duplicate check by phone / email exactly as the existing intake does.
   - New → create the loan lead: source `Converge (B2B)`, category `p2p`,
     status `open`, `businessPartnerId`, and
     `convergeRef: { referralId, partnerKey, convergeStudentId }`; consent time
     kept as `partnerConsentAt`; assign by the loan round-robin.
   - Existing → add an activity `type: "note"`, message
     `Also referred by a business partner via Converge` (plus the partner's
     note); the business partner id goes in the note's metadata, never the name
     (business partners are private, but every loan user reads the timeline).
     Do **not** add `convergeRef`. Lead `sourceDetail` is "Converge partner
     portal", never a partner name.
4. Write `partnerReferrals/{referralId} = { result, loanLeadId, partnerKey, at }`.

Clients can never write `convergeRef`, `partnerReferrals`, or `convergeOutbox`
(firestore.rules); only functions do.

## 2. Events — Enrollment → Converge

`POST <convergeWebhookUrl>` = `https://<converge host>/api/v1/webhooks/enrollment-loan`

```json
{ "events": [ { ... }, { ... } ] }
```

Up to 100 events per request. Every event:

| Field | Type | Notes |
| --- | --- | --- |
| `eventId` | string | Unique forever. Converge ignores ids it has seen. |
| `kind` | `"lead.updated"` \| `"timeline.added"` \| `"application.updated"` \| `"snapshot"` | |
| `referralId` | string | From `convergeRef.referralId` |
| `loanLeadId` | string | |
| `occurredAt` | ISO 8601 | When the change happened in Enrollment |

Plus, by kind:

**`lead.updated`** and **`snapshot`** carry `lead`:

```json
"lead": {
  "stage": "document_collection",
  "counsellorName": "Anita Rao",
  "nextFollowUpAt": "2026-11-22T04:30:00.000Z",
  "closureReason": null,
  "lastUpdateAt": "2026-11-19T11:02:00.000Z"
}
```

`stage` is one of the Enrollment `LOAN_STAGES` values: `open`, `not_connected`,
`follow_up`, `deferred`, `document_collection`, `credit_review`, `sanctioned`,
`pf_paid`, `disbursed`, `declined`, `closed`. `closureReason` is the reason
**name** only (never the internal note). Converge applies a `lead` only when
`occurredAt` is newer than the last one it applied.

**`timeline.added`** carries `timeline` (Phase 1: stage changes only):

```json
"timeline": { "type": "stage_change", "toStage": "credit_review", "by": "Anita Rao", "at": "2026-11-19T11:02:00.000Z" }
```

`by` is the lead's assigned counsellor (the lead doesn't record who moved the
stage), so it is `null` on an unassigned lead.

Emitted by the lead trigger when `status` changes (alongside `lead.updated`),
with `eventId` `stage:<leadId>:<updateTimeMillis>`, so a re-run trigger is ignored.

**`application.updated`** carries `application`:

```json
"application": {
  "id": "appDocId",
  "lender": "ICICI Bank Limited",
  "status": "sanctioned",
  "loanAmount": 2500000,
  "sanctionedAmount": 2200000,
  "roi": 10.25,
  "disbursedAmount": null,
  "disbursedAt": null,
  "deleted": false
}
```

Amounts INR numbers or `null`; `roi` percent number or `null`; `disbursedAt`
ISO or `null`. `deleted: true` removes the row from the partner's view.
Never sent: application number, processing fee, tranches, collateral,
co-applicant, payout %, notes.

**`snapshot`** carries `lead` and `applications` (array, same shape as
`application`, the **complete** current list — Converge removes rows not in it).
Sent nightly for every lead with `convergeRef` not in `disbursed`/`declined`/
`closed` for more than 30 days.

Response **200** `{ "accepted": <events stored>, "ignored": <duplicates, unknown referrals or malformed events> }`.
An event for a `referralId` Converge does not know is ignored (counted), not an
error. **401** bad signature, **400** malformed body, **503** not configured.
Enrollment retries non-2xx with backoff.

`eventId` conventions (Enrollment side): `lead:<leadId>:<updateTimeMillis>`,
`stage:<leadId>:<updateTimeMillis>`, `app:<appId>:<updateTimeMillis>`,
`snap:<leadId>:<yyyymmdd>`.

Outbox entries (`convergeOutbox`) carry `expireAt` (60 days) for a Firestore
TTL policy, which must be switched on in the console.

## 3. Phase 2 additions (19 Nov 2026)

### 3a. Shared notes — Enrollment → Converge

A counsellor note (activity `type: "note"`) reaches the partner only while it
carries `sharedWithPartner: true` (the *Share with partner* tick, off by
default, shown only on leads with `convergeRef`). Three more `timeline` events:

| kind | when | `timeline` |
| --- | --- | --- |
| `timeline.added` | a note is saved ticked, or an existing note gets ticked | `{ "type": "note", "noteId": "<activityId>", "text": "...", "by": "Anita Rao", "at": "<ISO>" }` |
| `timeline.updated` | a ticked note's text is edited | same shape as added |
| `timeline.removed` | a ticked note is un-ticked or deleted | `{ "type": "note", "noteId": "<activityId>", "at": "<ISO>" }` |

- `text` ≤ 2000 characters (trimmed); `by` = the note's author name (or `null`).
- `eventId` = `note:<leadId>:<activityId>:<updateTimeMillis>`.
- Converge keys a note by `noteId`; the newest `occurredAt` wins, so an older
  `added` arriving after a `removed` does not bring the note back.
- Only `type: "note"` activities are ever sent. `status_change` keeps its
  Phase 1 path; `partner_message` (below) is never echoed back.

### 3b. Partner message — Converge → Enrollment

Same URL, signing and secret as the referral (`ENROLLMENT_LOAN_URL`,
`partnerLoanIntake`, `convergeInboundSecret`). The body carries
`"type": "message"`; a body without `type` (or `"type": "referral"`) is a
referral as in section 1.

```json
{
  "type": "message",
  "messageId": "7d3c2b0e-1f0a-4c6e-9e55-2a1b3c4d5e6f",
  "referralId": "0f9c6c1e-6a52-4f0e-9a43-7d3d2b1c9e10",
  "loanLeadId": "AbC123...",
  "author": { "userId": 45, "name": "Priya Shah" },
  "text": "Father's ITR for 2 years attached.",
  "files": [
    { "name": "ITR-2025.pdf", "contentType": "application/pdf", "size": 482113,
      "sha256": "<lowercase hex>", "data": "<base64>" }
  ]
}
```

- `text` 0–2000 characters; at least one of `text` / `files` is non-empty.
- `files`: 0–3 entries, PDF only (`contentType` `application/pdf` and the bytes
  start with `%PDF`), each ≤ 10 MB decoded, ≤ 20 MB in total. The file travels
  inside the signed body, so the signature covers it; no download links.
- `messageId` is the idempotency key (`partnerMessages/{messageId}`).

Enrollment:

1. Rejects (**404** `{ "error": ... }`, permanent) when `loanLeads/{loanLeadId}`
   doesn't exist or its `convergeRef.referralId` ≠ `referralId`.
2. Checks each file's size, `%PDF` header and SHA-256 (**400** on mismatch), and
   stores it at `loanLeads/{loanLeadId}/partner/{messageId}/{n}-{safe name}`
   in Firebase Storage (loan staff may read; nobody writes from a client).
3. Adds an activity `type: "partner_message"`: `message` = text, `files` =
   `[{ name, path, size }]`, `createdBy: "converge"`, shown as
   "Message from the referring partner" (author kept as hidden metadata, no
   partner names on the timeline — business partners are private).
4. If the lead is in an open stage, sets `nextFollowUpAt` to now so it
   surfaces in the counsellor's Follow Ups.

Response **200** `{ "result": "stored", "activityId": "..." }` (the same answer
again for a repeated `messageId`). **400** malformed or bad file (permanent),
**404** unknown lead (permanent), **401**, **503**, **5xx** (Converge retries).

## Changelog

- 19 Nov 2026: Phase 1. Synced after the Enrollment build (afcc9d5): duplicate
  note wording and privacy, nullable `timeline.by`, busy = 500, idempotent
  `created`, outbox TTL.
- 19 Nov 2026: Phase 2 contract — shared notes (3a), partner messages with
  inline PDF files (3b).
