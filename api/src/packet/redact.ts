import type { IdentityHints } from "./types.js";

/** Identity / contact keys that must never appear in model packets. */
const IDENTITY_KEYS = new Set([
  "email",
  "emails",
  "athleteemail",
  "useremail",
  "contactemail",
  "athletename",
  "username",
  "user_name",
  "fullname",
  "full_name",
  "displayname",
  "display_name",
  "firstname",
  "first_name",
  "lastname",
  "last_name",
  "phone",
  "phonenumber",
  "phone_number",
  "mobile",
  "address",
  "homeaddress",
  "contact",
  "contacts",
]);

/**
 * GPS / geometry / raw track keys that must never appear in model packets.
 * Includes TempoPort strip keys plus common polyline/coordinate aliases.
 */
const GPS_KEYS = new Set([
  "route",
  "routes",
  "polyline",
  "polylines",
  "mappolyline",
  "encodedpolyline",
  "coordinates",
  "coordinate",
  "latitude",
  "longitude",
  "lat",
  "lon",
  "lng",
  "latlng",
  "geojson",
  "routegeojson",
  "geometry",
  "rawgpxdata",
  "rawfitdata",
  "rawstravadata",
  "rawhealthkitdata",
  "rawfiledata",
  "healthkituuid",
  "media",
]);

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/** Rough lon/lat pair detector for residual GPS fail-closed checks. */
const COORD_PAIR_RE =
  /\[\s*-?\d{1,3}(?:\.\d+)?\s*,\s*-?\d{1,2}(?:\.\d+)?\s*\]/;

const REDACTED = "[redacted]";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function normalizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

export function isIdentityKey(key: string): boolean {
  return IDENTITY_KEYS.has(normalizeKey(key));
}

export function isGpsKey(key: string): boolean {
  return GPS_KEYS.has(normalizeKey(key));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Scrub emails and known identity strings from free text. */
export function scrubString(
  text: string,
  hints?: IdentityHints,
): string {
  let out = text.replace(EMAIL_RE, REDACTED);

  const emails = hints?.emails ?? [];
  for (const email of emails) {
    const trimmed = email.trim();
    if (!trimmed) continue;
    out = out.replace(new RegExp(escapeRegExp(trimmed), "gi"), REDACTED);
  }

  const names = [...(hints?.names ?? [])]
    .map((n) => n.trim())
    .filter((n) => n.length >= 2)
    .sort((a, b) => b.length - a.length);
  for (const name of names) {
    out = out.replace(new RegExp(escapeRegExp(name), "gi"), REDACTED);
  }

  return out;
}

/**
 * Deep-redact a value for inclusion in a model packet.
 * Drops identity/GPS keys; scrubs strings; recurses into objects/arrays.
 */
export function redactValue(value: unknown, hints?: IdentityHints): unknown {
  if (typeof value === "string") {
    return scrubString(value, hints);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, hints));
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isIdentityKey(key) || isGpsKey(key)) continue;
    out[key] = redactValue(child, hints);
  }
  return out;
}

export function looksLikeResidualGps(text: string): boolean {
  if (COORD_PAIR_RE.test(text)) return true;
  if (/"type"\s*:\s*"LineString"/i.test(text)) return true;
  if (/"coordinates"\s*:/i.test(text)) return true;
  return false;
}

export function packetToJson(packet: unknown): string {
  return JSON.stringify(packet);
}

/**
 * Fail-closed privacy assert for tests and defense-in-depth.
 * Throws if identity keys, GPS keys, emails, residual coordinates, or
 * caller-supplied forbidden substrings appear in the packet JSON.
 */
export function assertPacketHasNoPiiOrGps(
  packet: unknown,
  options?: {
    forbiddenSubstrings?: string[];
    identityHints?: IdentityHints;
  },
): void {
  walkKeys(packet);

  const json = packetToJson(packet);
  // Fresh regex — avoid lastIndex sticky state on the module-level /g pattern.
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(json)) {
    throw new Error("pii_leaked:email_pattern");
  }
  if (looksLikeResidualGps(json)) {
    throw new Error("gps_leaked:residual_coordinates");
  }

  const hints = options?.identityHints;
  for (const email of hints?.emails ?? []) {
    if (email && json.toLowerCase().includes(email.toLowerCase())) {
      throw new Error(`pii_leaked:email:${email}`);
    }
  }
  for (const name of hints?.names ?? []) {
    if (name && json.toLowerCase().includes(name.toLowerCase())) {
      throw new Error(`pii_leaked:name:${name}`);
    }
  }
  for (const s of options?.forbiddenSubstrings ?? []) {
    if (s && json.includes(s)) {
      throw new Error(`privacy_leaked:${s}`);
    }
  }
}

function walkKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) walkKeys(item);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (isIdentityKey(key)) {
      throw new Error(`pii_key_leaked:${key}`);
    }
    if (isGpsKey(key)) {
      throw new Error(`gps_key_leaked:${key}`);
    }
    walkKeys(child);
  }
}
