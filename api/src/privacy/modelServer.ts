import { isIP } from "node:net";
import { getSavedCoachModel, type SavedCoachProvider } from "../settings/coachModelStore.js";
import { getSelfHostedConnection, selfHostedHost } from "../settings/selfHostedStore.js";

/**
 * Where coaching context goes. For Anthropic there is no host to show. For a
 * self-hosted server, its hostname and whether that host is on the athlete's
 * own network; both are null when the server's address cannot be read.
 */
export type ModelServer = {
  provider: SavedCoachProvider;
  host: string | null;
  onNetwork: boolean | null;
};

export async function getModelServer(): Promise<ModelServer> {
  const provider = (await getSavedCoachModel())?.provider ?? "anthropic";
  if (provider !== "self_hosted") return { provider, host: null, onNetwork: null };
  const connection = await getSelfHostedConnection();
  const host = connection.baseUrl ? selfHostedHost(connection.baseUrl) : null;
  return { provider, host, onNetwork: host ? isOnAthleteNetwork(host) : null };
}

function ipv4OnNetwork(host: string): boolean {
  const [a = -1, b = -1] = host.split(".").map((part) => Number(part));
  return (
    a === 127 || // loopback 127.0.0.0/8
    a === 10 || // 10.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 169 && b === 254) || // link-local 169.254.0.0/16
    (a === 100 && b >= 64 && b <= 127) // CGNAT 100.64.0.0/10 (Tailscale)
  );
}

function ipv6OnNetwork(host: string): boolean {
  if (host === "::1") return true;
  const first = host.startsWith("::") ? 0 : parseInt(host.split(":")[0] || "0", 16);
  return (
    (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (first & 0xfe00) === 0xfc00 // unique local fc00::/7
  );
}

/**
 * Whether a model server host is on the athlete's own network: loopback,
 * `host.docker.internal`, a private, link-local or CGNAT address, a `.local`
 * or `.lan` name, or a bare name with no dot. Everything else is remote.
 * `rawHost` is a URL hostname, so IPv6 may come bracketed.
 */
export function isOnAthleteNetwork(rawHost: string): boolean {
  const host = rawHost
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (!host) return false;
  const family = isIP(host);
  if (family === 4) return ipv4OnNetwork(host);
  if (family === 6) return ipv6OnNetwork(host);
  if (host === "localhost" || host === "host.docker.internal") return true;
  if (host.endsWith(".local") || host.endsWith(".lan")) return true;
  return !host.includes(".");
}
