/** Injectable time source — production uses system time; tests/dev can fix "now". */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class FixedClock implements Clock {
  constructor(private readonly instant: Date) {}

  now(): Date {
    return new Date(this.instant.getTime());
  }
}

/** Parse ISO-8601 instant for fixed/dev clocks. */
export function parseClockInstant(value: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid clock instant: ${value}`);
  }
  return d;
}

/**
 * Resolve clock for the process: DEV_CLOCK_NOW (ISO) when set and not production,
 * otherwise system time.
 */
export function createDefaultClock(): Clock {
  const override = process.env.DEV_CLOCK_NOW?.trim();
  const isProd = process.env.NODE_ENV === "production";
  if (override && !isProd) {
    return new FixedClock(parseClockInstant(override));
  }
  return new SystemClock();
}
