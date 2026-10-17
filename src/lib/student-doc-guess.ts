// Best guess at a student document's checklist type from its file name
// (STUDENT_DOC_TYPES keys). The user always confirms or changes it before
// anything is filed. Unknown → "" (they pick, or leave it unfiled). Shared by
// the partner Documents checklist and partner chat.
const word = (w: string) => new RegExp(`(^|[^a-z0-9])(${w})([^a-z0-9]|$)`, "i");
const GUESSES: [RegExp, string][] = [
  [/passport/i, "passport"],
  [/aadh?aa?r|national.?id/i, "national_id"],
  [word("10th|x|xth|ssc|sslc|class.?10"), "marksheet_10th"],
  [word("12th|xii|xiith|hsc|class.?12"), "marksheet_12th"],
  [/resume|curriculum|(^|[^a-z0-9])cv([^a-z0-9]|$)/i, "resume"],
  [/(^|[^a-z0-9])sop([^a-z0-9]|$)|statement.?of.?purpose/i, "sop"],
  [/(^|[^a-z0-9])lor([^a-z0-9]|$)|recommendation/i, "lor"],
  [/backlog/i, "backlog"],
  [/ielts|toefl|(^|[^a-z0-9])pte([^a-z0-9]|$)|duolingo/i, "english_test"],
  [
    /transcript|bachelor|b\.?tech|b\.?e\.|b\.?com|b\.?sc|degree/i,
    "transcript_bachelors",
  ],
  [/offer/i, "offer_letter"],
  [/visa/i, "visa"],
  [/deposit/i, "deposit_receipt"],
  [/tuition|fee.?receipt/i, "tuition_receipt"],
];

export function guessStudentDocType(fileName: string): string {
  return GUESSES.find(([re]) => re.test(fileName))?.[1] ?? "";
}
