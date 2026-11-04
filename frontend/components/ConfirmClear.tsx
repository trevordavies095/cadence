import { Button } from "@/components/ui";

/** Asks before a saved connection or key is removed (Settings). */
export function ConfirmClear({
  question,
  consequence,
  onConfirm,
  onCancel,
}: {
  question: string;
  consequence: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div role="alertdialog" aria-label={question} className="flex flex-col gap-2 border-l-4 border-ink bg-raised px-3 py-2">
      <p className="m-0 font-semibold">{question}</p>
      <p className="m-0 text-muted">{consequence}</p>
      <div className="flex gap-3">
        <Button onClick={onConfirm}>Remove</Button>
        <Button variant="quiet" onClick={onCancel}>
          Keep it
        </Button>
      </div>
    </div>
  );
}
