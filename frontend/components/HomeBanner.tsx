"use client";

import { useState } from "react";
import { retryReplyRun, type HomeBanner as HomeBannerData } from "@/lib/api";
import { describeError, type UiError } from "@/lib/errors";
import { Banner, Button, ButtonLink, ErrorNote } from "./ui";

/** The one line on Home that says something needs the athlete. */
export function HomeBanner({
  banner,
  weekSessionId,
  onChanged,
}: {
  banner: HomeBannerData;
  weekSessionId: string | null;
  /** Called after an action the banner performed, so Home can look again. */
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UiError | null>(null);

  async function retry() {
    if (!weekSessionId) return;
    setBusy(true);
    setError(null);
    try {
      await retryReplyRun(weekSessionId);
      onChanged();
    } catch (err) {
      setError(describeError(err, "Couldn’t restart that. Try again in a minute."));
    } finally {
      setBusy(false);
    }
  }

  const cta = banner.cta;
  return (
    <div className="flex flex-col gap-2">
      <Banner
        tone={banner.kind === "reply_failed" ? "danger" : "info"}
        action={
          cta ? (
            "href" in cta ? (
              <ButtonLink href={cta.href} variant="primary">
                {cta.label}
              </ButtonLink>
            ) : (
              <Button variant="primary" disabled={busy} onClick={() => void retry()}>
                {cta.label}
              </Button>
            )
          ) : undefined
        }
      >
        {banner.text}
      </Banner>
      <ErrorNote error={error} />
    </div>
  );
}
