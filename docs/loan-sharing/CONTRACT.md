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
     kept as `partnerConsentAt`. Assign it to the partner's loan counsellor
     (`businessPartners.loanOwnerUid`, set by a Super Admin in Loan →
     Partners), never round-robin, so the partner always works with the same
     person. No owner (or an inactive one): the lead waits unassigned with a
     timeline note until an admin picks one.
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
Never sent: application number, processing fee, collateral,
co-applicant, payout %, notes.

Optional (loan commission, 20 Nov 2026): `"tranches": [{ "date": "<ISO>" | null,
"amount": 1000000 | null }]`, the disbursement tranches oldest first, so
Converge can open a commission line per tranche. Converge accepts it now; the
Enrollment App does not send it yet. Without it Converge takes the first
`disbursedAmount` it sees as the first tranche (normally the only one that
earns commission).

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
3. Writes the message into the lead's partner chat (section 4a) as
   `partnerChat/pm_{messageId}`, `side: "partner"`, with `files` =
   `[{ name, path, size }]`; no partner names (business partners are private).
   (Before section 4 this was a `partner_message` timeline activity.)
4. If the lead is in an open stage, sets `nextFollowUpAt` to now so it
   surfaces in the counsellor's Follow Ups.

Response **200** `{ "result": "stored", "activityId": "..." }` (the same answer
again for a repeated `messageId`). **400** malformed or bad file (permanent),
**404** unknown lead (permanent), **401**, **503**, **5xx** (Converge retries).

## 4. Chat between the loan counsellor and the partner (19 Nov 2026)

The lead has two partner-facing channels, kept apart:

- **Updates** (sections 2 and 3a): stage changes, lender results, and notes the
  counsellor ticks *Share with partner*. One-way, read-only for the partner.
- **Chat** (this section): a two-way conversation per lead. Everything a
  partner writes (3b) and everything a counsellor types in the lead's
  *Partner chat* tab.

### 4a. Where the chat lives in the Enrollment App

`loanLeads/{leadId}/partnerChat/{msgId}`:

| field | |
| --- | --- |
| `side` | `"staff"` or `"partner"` |
| `text` | 0–2000 characters |
| `files` | `[{ name, path, size }]` (partner PDFs only; staff send text only for now) |
| `authorUid` | staff: the counsellor's uid; partner: `null` |
| `authorName` | staff: the counsellor's name; partner: `"Referring partner"` (no partner names) |
| `createdAt` | server time |

- Partner messages (3b) are written here as `partnerChat/pm_{messageId}`
  instead of a `partner_message` timeline activity. Files keep the 3b Storage path.
- Staff create only `side: "staff"`, as themselves, with no files, on leads
  they may edit; nobody updates or deletes a chat message.
- On the lead: `partnerChatUnread` (partner messages the loan team hasn't
  opened; +1 per partner message, reset to 0 when a counsellor opens the
  tab), `partnerChatLastAt`, `partnerChatLastSide`. A partner message still
  sets `nextFollowUpAt` to now on an open lead.

### 4b. Counsellor message — Enrollment → Converge

A staff chat message is sent through the outbox as:

```json
{
  "eventId": "chat:<leadId>:<msgId>",
  "kind": "chat.message",
  "referralId": "...", "loanLeadId": "...", "occurredAt": "<ISO>",
  "chat": { "messageId": "<msgId>", "text": "...", "by": "Anita Rao", "at": "<ISO>" }
}
```

`text` 1–2000 characters; `by` the counsellor's name (or `null`). Partner
messages are never echoed back. Converge stores it once per `messageId`.

Read state is not synced: each side tracks its own unread counts.

## 5. Loan documents from the partner (19 Nov 2026)

Partners upload the documents the loan team needs; the loan counsellor
reviews each one. Decided by Suraj: the loan team's own list, Accept /
Needs re-upload shown to the partner, one-click reuse of documents already on
the student's Converge profile, PDF / JPG / PNG.

### 5a. The list lives in the Enrollment App

Master list `loanDocTypes/{key}` (admins edit it in Loan → Settings):

| field | |
| --- | --- |
| `key` | stable slug, e.g. `student_pan`, `coapp_itr` (never reused) |
| `label` | what the partner reads, e.g. "Co-applicant ITR (last 2 years)" |
| `group` | `student` · `coapplicant` · `collateral` |
| `required` | kept for older data; nothing is mandatory and no screen shows it (21 Nov 2026) |
| `active` | inactive items leave every lead's list |
| `order` | sort within the group |
| `convergeDocType` | optional Converge student document type this can be filled from: one of `passport`, `national_id`, `marksheet_10th`, `marksheet_12th`, `transcript_bachelors`, `transcript_masters`, `degree_certificate`, `english_test`, `aptitude_test`, `offer_letter` |

Seed (order as listed): student — PAN card, Aadhaar (`national_id`),
Passport (`passport`), 10th marksheet (`marksheet_10th`), 12th marksheet
(`marksheet_12th`), Degree marksheets / transcripts (`transcript_bachelors`),
Admission / offer letter (`offer_letter`), Test score reports
(`english_test`), Student bank statement (6 months); co-applicant — PAN card,
Aadhaar, ITR (last 2 years), Salary slips (last 3 months) / Form 16, Bank
statement (6 months), Address proof; collateral — Property papers, Valuation
report. No document is mandatory (Suraj, 21 Nov 2026): partners send what
they have and the counsellor asks for more.

Additional documents (21 Nov 2026): besides the list, a partner may upload
any number of other documents for case-specific requests, each under a label
they type. These use the reserved `typeKey` **`additional`** (never a list
key: list keys start with their group) and carry `label` (5c).

Per lead, `loanLeads/{leadId}/docRequests/{key}` adjusts the list:
`{ state: "not_needed" }` hides a master item for this lead;
`{ state: "extra", label, group, required }` adds one (key `extra_<id>`).

A lead's list = active master items, minus `not_needed`, plus `extra`.

Uploads: `loanLeads/{leadId}/partnerDocs/{docId}`:
`{ typeKey, typeLabel, files: [{ name, path, size, contentType }], source: "upload" | "converge_profile",
status: "received" | "accepted" | "reupload", reason, uploadedAt, reviewedBy, reviewedByName, reviewedAt }`.
Files at `loanLeads/{leadId}/partnerDocs/{docId}/{n}-{safe name}` (same
Storage read rule as partner chat files). Only counsellors who may work the
lead review (status/reason/reviewed* only); nobody else writes.

### 5b. Enrollment → Converge

Two event kinds through the outbox:

```json
{ "eventId": "docs:<leadId>:<updateTimeMillis>", "kind": "docs.checklist", ...,
  "checklist": [ { "key": "coapp_itr", "label": "Co-applicant ITR (last 2 years)",
                   "group": "coapplicant", "required": true, "convergeDocType": null } ] }
```

The lead's whole current list (ordered: group student, coapplicant,
collateral, then `order`). Sent when the referral's lead is created, when its
`docRequests` change, and in every nightly snapshot (the snapshot event
carries `checklist` too), so master edits reach Converge by the next night.
Converge replaces its copy (newest `occurredAt` wins).

```json
{ "eventId": "docrev:<leadId>:<docId>:<updateTimeMillis>", "kind": "docs.reviewed", ...,
  "review": { "documentId": "<Converge documentId>", "typeKey": "coapp_itr",
              "status": "accepted" | "reupload", "reason": null | "Page 2 missing", "by": "Anita Rao", "at": "<ISO>" } }
```

`documentId` is the id Converge sent (5c). Converge applies the newest per document.

### 5c. Partner document — Converge → Enrollment

Same URL, signing and secret as the referral; body `"type": "document"`:

```json
{ "type": "document", "documentId": "<uuid>", "referralId": "...", "loanLeadId": "...",
  "typeKey": "coapp_itr", "author": { "userId": 45, "name": "Priya Shah" },
  "source": "upload",
  "files": [ { "name": "ITR-2025.pdf", "contentType": "application/pdf", "size": 482113, "sha256": "<hex>", "data": "<base64>" } ] }
```

- `files`: 1–5, each `application/pdf` (`%PDF`), `image/jpeg` (`FF D8 FF`) or
  `image/png` (`89 50 4E 47`), ≤ 10 MB decoded, ≤ 20 MB total.
- `typeKey` must be on the lead's current list (else **400**), or be
  `additional`, which then needs `label`: 2–160 characters, the partner's
  name for the document, stored as the upload's `typeLabel`. Only
  `"source": "upload"` for additional documents.
- Enrollment stores it as `partnerDocs/pd_{documentId}`, status `received`
  (a newer upload for the same `typeKey` does not delete older ones; each is
  reviewed on its own), increments the lead's `partnerDocsPending`, and
  sets `nextFollowUpAt` to now on an open lead.
- Idempotent on `documentId`. Response **200** `{ "result": "stored", "docId": "pd_..." }`;
  **400** bad file / unknown type, **404** unknown lead (both permanent), **401**, **503**, **5xx** (retry).

## Changelog

- 21 Nov 2026: Additional documents (`typeKey: "additional"` + `label`, 5a/5c);
  no document is mandatory (`required` no longer shown).

- 20 Nov 2026: optional `application.tranches` (loan commission). Converge
  accepts it; Enrollment to send it in a later change (both copies to be
  updated together then).

- 19 Nov 2026: Phase 1. Synced after the Enrollment build (afcc9d5): duplicate
  note wording and privacy, nullable `timeline.by`, busy = 500, idempotent
  `created`, outbox TTL.
- 19 Nov 2026: Phase 2 contract — shared notes (3a), partner messages with
  inline PDF files (3b).
- 19 Nov 2026: partner leads go to the partner's own loan counsellor, not
  round-robin (Suraj).
- 19 Nov 2026: section 4, counsellor ↔ partner chat; partner messages move
  from the timeline into the chat.
- 19 Nov 2026: section 5, loan documents from the partner (list, uploads,
  review).
