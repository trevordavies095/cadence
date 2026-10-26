"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { WaitingState } from "@/components/ui";

/** Legacy /thread → chat-only /chat (#53). */
export default function ThreadRedirectPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/chat");
  }, [router]);
  return (
    <WaitingState>
      <p className="m-0">Taking you to Coach Cade…</p>
    </WaitingState>
  );
}
