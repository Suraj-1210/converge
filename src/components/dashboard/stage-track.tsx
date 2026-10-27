import { Fragment, type CSSProperties } from "react";
import {
  APPLICATION_STAGE_ORDER,
  isClosedStage,
  isNegativeClosedStage,
  stageIndex,
  stageShortLabel,
} from "~/lib/application-stages";
import { UniApplicationStatus } from "~/server/db/enums";

// How an application's stage track is drawn, in both portals: the admin
// (counsellor) Stepper and the partner portal's read-only track. Stage order,
// labels and open/closed come from ~/lib/application-stages; this file only
// turns them into dots, ticks and connecting lines.
//
//   passed stage   — green dot with a tick, green line into it
//   current stage  — solid dot with a halo: blue while in progress, green at
//                    Enrolled, red with an X where it closed negatively,
//                    grey with a tick where it closed neutrally
//   later stage    — hollow grey dot, grey line

export type StageState = "done" | "current" | "todo";

const DONE = "#12B76A";
const DONE_TEXT = "#027A48";
const TODO_BORDER = "#D0D5DD";
const TODO_LINE = "#E4E7EC";
const TODO_TEXT = "#98A2B3";

// The "you are here" marker and its label, by the application's status.
function marker(status: number): { dot: string; text: string } {
  if (isClosedStage(status)) {
    return isNegativeClosedStage(status)
      ? { dot: "#F04438", text: "#B42318" }
      : { dot: "#667085", text: "#475467" };
  }
  if (status === UniApplicationStatus.ENROLLED) return { dot: DONE, text: DONE_TEXT };
  return { dot: "#1570EF", text: "#1570EF" };
}

/** `app.stage` is the current (or, once closed, furthest) stage on the track. */
export function stageStateOf(stage: number, app: { stage: number }): StageState {
  const at = stageIndex(app.stage);
  const i = stageIndex(stage);
  return i < at ? "done" : i === at ? "current" : "todo";
}


function halo(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `0 0 0 4px rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0.18)`;
}

export function stageDotStyle(state: StageState, status: number): CSSProperties {
  if (state === "done") return { borderColor: DONE, background: DONE };
  if (state === "todo") return { borderColor: TODO_BORDER, background: "#fff" };
  const c = marker(status).dot;
  return { borderColor: c, background: c, boxShadow: halo(c) };
}

export function stageLabelStyle(state: StageState, status: number): CSSProperties {
  if (state === "done") return { color: DONE_TEXT, fontWeight: 600 };
  if (state === "todo") return { color: TODO_TEXT, fontWeight: 500 };
  return { color: marker(status).text, fontWeight: 600 };
}

/** The line leading into a stage. */
export function stageLineColour(state: StageState): string {
  return state === "todo" ? TODO_LINE : DONE;
}

/** Tick, X, or nothing, sized for the dot. */
export function StageMark({
  state,
  status,
  className = "h-3.5 w-3.5",
}: {
  state: StageState;
  status: number;
  className?: string;
}) {
  if (state === "todo") return null;
  if (state === "current" && isNegativeClosedStage(status)) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={2.5} className={className} aria-hidden>
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={3} className={className} aria-hidden>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

/**
 * Read-only track for the partner portal: compact dots, lines and short
 * labels, the same colours as the admin Stepper. `title` per stage carries
 * the full label and the date it was reached.
 */
export function StageTrack({
  app,
  titleFor,
}: {
  app: { status: number; stage: number };
  titleFor?: (stage: number) => string;
}) {
  return (
    <ol className="flex items-start" aria-label="Application progress">
      {APPLICATION_STAGE_ORDER.map((stage, i) => {
        const state = stageStateOf(stage, app);
        return (
          <Fragment key={stage}>
            {i > 0 && (
              <li
                aria-hidden
                className="mt-[9px] h-0.5 min-w-1 flex-1 rounded-full"
                style={{ background: stageLineColour(state) }}
              />
            )}
            <li
              className="flex w-[60px] shrink-0 flex-col items-center gap-1 sm:w-[68px]"
              title={titleFor?.(stage)}
              aria-current={state === "current" ? "step" : undefined}
            >
              <span
                className="flex h-5 w-5 items-center justify-center rounded-full border-2"
                style={stageDotStyle(state, app.status)}
              >
                <StageMark state={state} status={app.status} className="h-3 w-3" />
              </span>
              <span
                className="w-full text-center text-[10px] leading-tight break-words"
                style={stageLabelStyle(state, app.status)}
              >
                {stageShortLabel(stage)}
              </span>
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}
