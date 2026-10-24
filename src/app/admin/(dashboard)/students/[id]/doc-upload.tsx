// Uploads live only in the Documents tab, on both portals (Day 5 testing:
// the per-section upload slots duplicated the Documents tab). Sections that
// used to carry their own slots point there instead.
export function DocumentsTabNote({ what }: { what: string }) {
  return (
    <div className="mt-4 rounded-lg border border-[#E4E7EC] bg-[#F9FAFB] px-4 py-2.5 text-[13px] text-[#667085]">
      {what} are uploaded in the{" "}
      <span className="font-semibold text-[#344054]">Documents</span> tab.
    </div>
  );
}
