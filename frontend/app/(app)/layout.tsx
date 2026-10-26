import { AppShell } from "@/components/AppShell";
import { DisclaimerGate } from "@/components/DisclaimerGate";

export default function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <AppShell>
      <DisclaimerGate>{children}</DisclaimerGate>
    </AppShell>
  );
}
