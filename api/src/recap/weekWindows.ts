/** Inclusive Mon–Sun window as ISO instants (from a week session). */
export type WeekWindow = {
  start: string;
  end: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function shiftIso(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * DAY_MS).toISOString();
}

/** Shift a week window by whole weeks (negative = earlier). */
export function shiftWeekWindow(window: WeekWindow, weeks: number): WeekWindow {
  const days = weeks * 7;
  return {
    start: shiftIso(window.start, days),
    end: shiftIso(window.end, days),
  };
}

/**
 * Prior comparison windows for a recap week:
 * prev = W−1; trailing = W−1, W−2, W−3 (oldest → newest).
 */
export function priorWeekWindows(thisWeek: WeekWindow): {
  prev: WeekWindow;
  trailing: WeekWindow[];
} {
  const w1 = shiftWeekWindow(thisWeek, -1);
  const w2 = shiftWeekWindow(thisWeek, -2);
  const w3 = shiftWeekWindow(thisWeek, -3);
  return { prev: w1, trailing: [w3, w2, w1] };
}
