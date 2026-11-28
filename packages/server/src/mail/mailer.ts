import { createTransport } from "nodemailer";
import { randomToken } from "../auth/crypto.js";
import type { MailConfig } from "../config.js";

/** One email, with a plain-text and an HTML body. `tag` names the kind, for the provider's logs. */
export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
  tag: string;
}

export interface Mailer {
  /** Sends one email. Throws when the provider refuses it; callers decide whether that matters. */
  send(mail: Mail): Promise<void>;
}

/** Keeps every email in memory. For tests. */
export class MemoryMailer implements Mailer {
  readonly sent: Mail[] = [];
  async send(mail: Mail): Promise<void> {
    this.sent.push(mail);
  }
  /** The last email sent to this address. */
  last(to: string): Mail | undefined {
    return [...this.sent].reverse().find((m) => m.to.toLowerCase() === to.toLowerCase());
  }
}

/** Prints each email to the console. Development only: configuration refuses it in production. */
class LogMailer implements Mailer {
  async send(mail: Mail): Promise<void> {
    console.log(`\n--- email to ${mail.to}: ${mail.subject}\n${mail.text}\n---\n`);
  }
}

class ResendMailer implements Mailer {
  constructor(
    private readonly cfg: MailConfig,
    private readonly fetchFn: typeof fetch,
  ) {}
  async send(mail: Mail): Promise<void> {
    const res = await this.fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.cfg.resendApiKey}`,
        "content-type": "application/json",
        // A retried request is not sent twice.
        "idempotency-key": randomToken(16),
      },
      body: JSON.stringify({
        from: this.cfg.from,
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        ...(this.cfg.replyTo ? { reply_to: this.cfg.replyTo } : {}),
        tags: [{ name: "kind", value: mail.tag.replace(/[^A-Za-z0-9_-]/g, "_") }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    // The response body can echo the request; only the status is reported.
    if (!res.ok) throw new Error(`Resend refused the email (${res.status}).`);
  }
}

class SmtpMailer implements Mailer {
  private readonly transport;
  constructor(private readonly cfg: MailConfig) {
    this.transport = createTransport(cfg.smtpUrl);
  }
  async send(mail: Mail): Promise<void> {
    await this.transport.sendMail({
      from: this.cfg.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      ...(this.cfg.replyTo ? { replyTo: this.cfg.replyTo } : {}),
      headers: { "X-Anywhere-Kind": mail.tag },
    });
  }
}

/** On staging and previews, mail goes only to the allowlist; the rest is dropped with a log line. */
class AllowlistMailer implements Mailer {
  constructor(
    private readonly inner: Mailer,
    private readonly allow: string[],
  ) {}
  async send(mail: Mail): Promise<void> {
    const to = mail.to.trim().toLowerCase();
    const domain = to.slice(to.lastIndexOf("@"));
    if (!this.allow.some((a) => a === to || a === domain)) {
      console.warn(`mail: not sending "${mail.tag}" to an address outside ANYWHERE_MAIL_ALLOWLIST`);
      return;
    }
    await this.inner.send(mail);
  }
}

class NoMailer implements Mailer {
  async send(): Promise<void> {
    throw new Error("This server has no way to send email.");
  }
}

export function createMailer(cfg: MailConfig, fetchFn: typeof fetch = fetch): Mailer {
  const inner =
    cfg.provider === "resend"
      ? new ResendMailer(cfg, fetchFn)
      : cfg.provider === "smtp"
        ? new SmtpMailer(cfg)
        : cfg.provider === "log"
          ? new LogMailer()
          : new NoMailer();
  return cfg.allowlist.length ? new AllowlistMailer(inner, cfg.allowlist) : inner;
}
