/*
 * Finds keys, tokens and passwords in text an agent is about to save. Anywhere refuses to store
 * them: pages are shared with every agent a person connects, and may live on a hosted server.
 *
 * The patterns match the shape of a real credential, not words about one, so a page can still say
 * "the Stripe key is in Vercel as STRIPE_SECRET_KEY". Nothing here returns or logs the value found:
 * only its kind and line, so an error can say what to remove without repeating it.
 */

export type SecretKind =
  | "Anthropic API key"
  | "OpenAI API key"
  | "Stripe secret key"
  | "GitHub token"
  | "AWS access key"
  | "Google API key"
  | "Slack token"
  | "SendGrid key"
  | "npm token"
  | "Twilio key"
  | "Supabase secret key"
  | "Resend API key"
  | "Hugging Face token"
  | "private key"
  | "JSON web token"
  | "bearer token"
  | "password in a URL"
  | "secret assignment";

export interface SecretMatch {
  kind: SecretKind;
  line: number;
}

// More specific prefixes first, so an Anthropic key is not reported as an OpenAI one.
const PREFIXED: [RegExp, SecretKind][] = [
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, "Anthropic API key"],
  [/\b[sr]k_live_[A-Za-z0-9]{16,}/g, "Stripe secret key"],
  [/\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g, "OpenAI API key"],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}/g, "GitHub token"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, "GitHub token"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "AWS access key"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "Google API key"],
  [/\bxox[baprse]-[A-Za-z0-9-]{10,}/g, "Slack token"],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, "SendGrid key"],
  [/\bnpm_[A-Za-z0-9]{30,}/g, "npm token"],
  [/\bSK[0-9a-f]{32}\b/g, "Twilio key"],
  [/\bsb_secret_[A-Za-z0-9_-]{20,}/g, "Supabase secret key"],
  [/\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}/g, "Resend API key"],
  [/\bhf_[A-Za-z0-9]{30,}/g, "Hugging Face token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, "private key"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "JSON web token"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/g, "bearer token"],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]{4,}@/gi, "password in a URL"],
];

// NAME=value or NAME: value, where the name says it is a secret and the value looks like one.
const ASSIGNMENT = /^[\s>*-]*(?:export\s+)?["'`]?([A-Za-z][A-Za-z0-9_]*)["'`]?\s*[:=]\s*["'`]?([^\s"'`#]+)["'`]?\s*[,;]?\s*$/gm;
const SECRETISH = /(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE)/i;
const NOT_A_VALUE = /^(?:\$|<|\{|\[|\(|%|process\.|env\.|os\.|import\.)|^(?:x+|\*+|\.+|-+)$|^(?:your[-_].*|changeme|placeholder|redacted|todo|tbd|none|null|undefined|true|false|example|secret|password|string|required|optional|set|unset|yes|no)$/i;

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) line++;
  return line;
}

/** Every credential-shaped string in the text, by kind and line, first one first. */
export function findSecrets(text: string): SecretMatch[] {
  const found: { index: number; kind: SecretKind }[] = [];
  const taken: [number, number][] = [];
  const add = (start: number, end: number, kind: SecretKind) => {
    if (taken.some(([s, e]) => start < e && end > s)) return;
    taken.push([start, end]);
    found.push({ index: start, kind });
  };
  for (const [re, kind] of PREFIXED) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) add(m.index, m.index + m[0].length, kind);
  }
  ASSIGNMENT.lastIndex = 0;
  for (let m = ASSIGNMENT.exec(text); m; m = ASSIGNMENT.exec(text)) {
    const [whole, name, value] = m;
    if (!name || !value || !SECRETISH.test(name)) continue;
    if (value.length < 12 || NOT_A_VALUE.test(value)) continue;
    // Words are not secrets: a real value mixes letters with digits or symbols.
    if (/^[A-Za-z_-]+$/.test(value)) continue;
    // A plain URL is an address, not a credential (one with a password in it is caught above).
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) continue;
    const start = m.index + whole.lastIndexOf(value);
    add(start, start + value.length, "secret assignment");
  }
  return found.sort((a, b) => a.index - b.index).map((f) => ({ kind: f.kind, line: lineAt(text, f.index) }));
}

/** A sentence for an error message: what was found and where, never the value itself. */
export function describeSecrets(matches: SecretMatch[]): string {
  const what = (k: SecretKind) => (k === "secret assignment" ? "a value assigned to a secret name" : `${/^(?:[AEIO]|npm)/.test(k) ? "an" : "a"} ${k}`);
  const parts = matches.slice(0, 3).map((m) => `${what(m.kind)} on line ${m.line}`);
  const more = matches.length > 3 ? `, and ${matches.length - 3} more` : "";
  return parts.join(", ") + more;
}
