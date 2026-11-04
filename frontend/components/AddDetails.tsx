"use client";

import { useState } from "react";
import { ADD_DETAILS_BUSY, ADD_DETAILS_FAILED, ADD_DETAILS_LABEL } from "@/lib/planDay";
import { Button, Muted } from "./ui";

/**
 * "Add the details" under an unread day on the Plan page: asks Coach Cade for
 * that day's line once more. On success the row is re-rendered from the new
 * plan, so this goes away; on failure the day stays as it was, with a line
 * saying so.
 */
export function AddDetails({ onAdd }: { onAdd: () => Promise<boolean> }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function run() {
    setBusy(true);
    setFailed(false);
    const ok = await onAdd();
    setBusy(false);
    setFailed(!ok);
  }

  return (
    <div className="flex flex-col gap-1" data-part="add-details">
      <div>
        <Button disabled={busy} aria-busy={busy} onClick={() => void run()}>
          {busy ? ADD_DETAILS_BUSY : ADD_DETAILS_LABEL}
        </Button>
      </div>
      {failed ? <Muted className="text-sm">{ADD_DETAILS_FAILED}</Muted> : null}
    </div>
  );
}
