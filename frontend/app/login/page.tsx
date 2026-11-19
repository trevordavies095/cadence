"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, ErrorNote, Field, Input, Muted, Page, PageHead, PageTitle } from "@/components/ui";
import { signIn, type SignInResult } from "@/lib/session";

const MESSAGES: Record<Exclude<SignInResult, "ok">, string> = {
  invalid: "That username and password don’t match your Tempo account.",
  unreachable: "Cadence couldn’t reach Tempo. Try again in a minute.",
  throttled: "Too many attempts. Try again in 15 minutes.",
  failed: "Something went wrong. Try again, and if it keeps happening, ask whoever set up the app.",
};

/** Sign in with Tempo (ADR 0008): the athlete's Tempo username and password, checked by Tempo. */
export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await signIn(username, password);
    if (result === "ok") {
      router.replace("/");
      return;
    }
    setPassword("");
    setError(MESSAGES[result]);
    setBusy(false);
  }

  return (
    <Page flow>
      <PageHead>
        <PageTitle>Sign in</PageTitle>
        <Muted>Use your Tempo username and password.</Muted>
      </PageHead>
      <form onSubmit={(e) => void onSubmit(e)} className="flex w-full max-w-md flex-col gap-4">
        <Field label="Username">
          <Input
            name="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
          />
        </Field>
        <Field label="Password">
          <Input
            name="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>
        <ErrorNote error={error} />
        <div>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </div>
      </form>
    </Page>
  );
}
