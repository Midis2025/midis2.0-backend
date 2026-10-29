/**
 * Thank-you email service for Portfolio Inquiries
 *
 * Handles:
 *  - Sending the branded, responsive MIDIS thank-you email via Strapi's Email
 *    plugin (nodemailer provider, configured in `config/plugins.ts`)
 *  - Rendering the MIDIS HTML template from
 *    `src/api/portfolio-inquiry/templates/thank-you-email.html`
 *  - HTML escaping of every user-supplied value
 *  - Recipient validation before any send is attempted
 *  - Idempotency through an atomic per-record status claim, so duplicate hook
 *    executions and retries cannot send a second email
 *  - Retries with backoff for transient SMTP failures only
 *  - Recording send status, timestamp and last error back onto the record
 *
 * Credentials live in the environment and are never logged.
 */

import fs from 'fs';
import path from 'path';

const UID = 'api::portfolio-inquiry.portfolio-inquiry';

const MAX_SEND_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;

interface ThankYouRecipient {
  documentId?: string | null;
  name?: string | null;
  businessEmail?: string | null;
}

type EmailStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';

/**
 * Same shape of check the controller applies to incoming submissions.
 */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && EMAIL_REGEX.test(value.trim());
}

/**
 * Escape a user-supplied value for safe interpolation into HTML.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Reduce an address to something safe to put in a log line: keeps enough to
 * correlate a delivery problem, drops the identifying local part.
 */
export function maskEmail(email: string): string {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return '[invalid address]';
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const shown = local.slice(0, 1);
  return `${shown}${'*'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as any).code;
    const responseCode = (error as any).responseCode;
    const parts = [error.message];
    if (code) parts.push(`code=${code}`);
    if (responseCode) parts.push(`smtp=${responseCode}`);
    return parts.join(' | ');
  }
  return String(error);
}

/**
 * Only transient failures are worth retrying. A network-level error has no SMTP
 * response code; a 4xx is a temporary refusal. A 5xx (bad mailbox, rejected
 * content) and an auth failure will fail identically on every attempt, so
 * retrying them only delays the inevitable.
 */
function isRetryableError(error: unknown): boolean {
  const code = (error as any)?.code;
  const responseCode = (error as any)?.responseCode;

  if (code === 'EAUTH') return false;
  if (typeof responseCode === 'number') {
    return responseCode >= 400 && responseCode < 500;
  }
  return true;
}

/**
 * The MIDIS email template, adapted from the landing-page design at
 * `scripts/midis-landingpage-template/index.html`. The only dynamic part is
 * the `{{RECIPIENT_NAME}}` token.
 */
const TEMPLATE_FILENAME = 'thank-you-email.html';
const TEMPLATE_SOURCE_PATH = `src/api/portfolio-inquiry/templates/${TEMPLATE_FILENAME}`;
const NAME_TOKEN = '{{RECIPIENT_NAME}}';

/** Booking link in the template's CTA; mirrored in the plain-text part. */
const CONSULTATION_URL = 'https://meetings-na2.hubspot.com/midis/sagar-bakshi';

/** Read once per process: the template is static and this runs per submission. */
let cachedTemplate: string | null = null;
let templateLookupDone = false;

/**
 * Locate the template in both a `strapi develop` tree and a built deployment.
 *
 * `strapi build` emits only JavaScript and JSON into `dist/`, so the HTML is
 * found either in the source tree (which a deployment keeps alongside `dist/`)
 * or next to the compiled service once `npm run build` has copied it there.
 * Both layouts are checked rather than assumed.
 */
export function resolveTemplatePath(): string | null {
  const candidates = [
    path.join(process.cwd(), TEMPLATE_SOURCE_PATH),
    path.join(__dirname, '..', 'templates', TEMPLATE_FILENAME),
    path.join(process.cwd(), 'dist', TEMPLATE_SOURCE_PATH),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Unreadable candidate: fall through to the next one.
    }
  }

  return null;
}

/**
 * Load the template, or null when it cannot be read. A missing template must
 * not stop the email going out, so callers fall back to the inline layout.
 */
export function loadTemplate(): string | null {
  if (templateLookupDone) return cachedTemplate;
  templateLookupDone = true;

  const templatePath = resolveTemplatePath();

  if (!templatePath) {
    strapi?.log?.warn(
      `[Thank-you Email] Template ${TEMPLATE_FILENAME} not found; using the built-in layout.`
    );
    return null;
  }

  try {
    cachedTemplate = fs.readFileSync(templatePath, 'utf8');
    strapi?.log?.info(`[Thank-you Email] Loaded template from ${templatePath}`);
  } catch (err) {
    strapi?.log?.warn(
      `[Thank-you Email] Could not read ${templatePath} (${describeError(err)}); ` +
        'using the built-in layout.'
    );
    cachedTemplate = null;
  }

  return cachedTemplate;
}

/**
 * Plain-text fallback, for clients that will not render HTML. Mirrors the
 * wording of the HTML template.
 */
export function buildPlainTextBody(name: string): string {
  return [
    'ENQUIRY RECEIVED',
    '',
    `Hi ${name},`,
    '',
    "Thank you for reaching out to MIDIS! We've received your details, and our team will get in touch with you shortly.",
    '',
    'Want to discuss your project sooner? Book your meeting with us directly:',
    CONSULTATION_URL,
    '',
    'Best regards,',
    'Team MIDIS',
    'connect@midis.in',
    '',
    '---',
    "You're receiving this email because you submitted an enquiry through the MIDIS website.",
  ].join('\n');
}

/**
 * Render the MIDIS template with the recipient's name.
 *
 * The name is HTML-escaped before substitution, and substitution is a literal
 * split/join rather than `String.replace`, so a `$&` or `$1` in a submitted
 * name cannot be interpreted as a replacement pattern.
 */
export function buildHtmlBody(name: string): string {
  const safeName = escapeHtml(name);
  const template = loadTemplate();

  if (template) {
    return template.split(NAME_TOKEN).join(safeName);
  }

  return buildFallbackHtmlBody(safeName);
}

/**
 * Built-in layout, used only when the template file cannot be read. Table
 * layout and inline styles, which is what mail clients reliably support.
 *
 * Takes an already-escaped name.
 */
export function buildFallbackHtmlBody(safeName: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="x-apple-disable-message-reformatting" />
    <title>Thank you for contacting MIDIS</title>
    <style>
      @media only screen and (max-width: 620px) {
        .midis-wrap { width: 100% !important; }
        .midis-pad { padding-left: 24px !important; padding-right: 24px !important; }
        .midis-title { font-size: 22px !important; }
      }
      @media (prefers-color-scheme: dark) {
        .midis-bg { background-color: #0f1115 !important; }
        .midis-card { background-color: #181b22 !important; }
        .midis-text { color: #e6e8ec !important; }
        .midis-muted { color: #a0a6b2 !important; }
      }
    </style>
  </head>
  <body class="midis-bg" style="margin:0; padding:0; background-color:#f4f5f7; -webkit-font-smoothing:antialiased;">
    <div style="display:none; max-height:0; overflow:hidden; opacity:0;">
      We have received your inquiry and will get back to you shortly.
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="midis-bg" style="background-color:#f4f5f7;">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" class="midis-wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px; max-width:600px;">
            <tr>
              <td align="left" style="padding:0 0 20px 0; font-family:Arial,Helvetica,sans-serif; font-size:20px; font-weight:bold; letter-spacing:1px; color:#1a1d24;" class="midis-text">
                MIDIS
              </td>
            </tr>
            <tr>
              <td class="midis-card" style="background-color:#ffffff; border-radius:10px; border:1px solid #e4e6ea;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td class="midis-pad" style="padding:36px 40px 8px 40px; font-family:Arial,Helvetica,sans-serif;">
                      <h1 class="midis-title midis-text" style="margin:0 0 20px 0; font-size:24px; line-height:1.3; font-weight:bold; color:#1a1d24;">
                        Thank you for contacting MIDIS
                      </h1>
                      <p class="midis-text" style="margin:0 0 16px 0; font-size:16px; line-height:1.6; color:#2d313a;">
                        Hi ${safeName},
                      </p>
                      <p class="midis-text" style="margin:0 0 16px 0; font-size:16px; line-height:1.6; color:#2d313a;">
                        Thank you for reaching out to MIDIS. We have successfully received your inquiry and appreciate your interest in our services.
                      </p>
                      <p class="midis-text" style="margin:0 0 16px 0; font-size:16px; line-height:1.6; color:#2d313a;">
                        Our team will review your requirements and get back to you as soon as possible.
                      </p>
                      <p class="midis-text" style="margin:0 0 24px 0; font-size:16px; line-height:1.6; color:#2d313a;">
                        If you have any additional information to share, you can reply directly to this email.
                      </p>
                    </td>
                  </tr>
                  <tr>
                    <td class="midis-pad" style="padding:0 40px 36px 40px; font-family:Arial,Helvetica,sans-serif;">
                      <div style="border-top:1px solid #e4e6ea; padding-top:20px;">
                        <p class="midis-text" style="margin:0; font-size:15px; line-height:1.6; color:#2d313a;">
                          Best regards,<br />
                          <strong>MIDIS Team</strong><br />
                          <a href="mailto:connect@midis.in" style="color:#2f6fed; text-decoration:none;">connect@midis.in</a>
                        </p>
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td align="center" class="midis-pad" style="padding:20px 24px 0 24px; font-family:Arial,Helvetica,sans-serif;">
                <p class="midis-muted" style="margin:0; font-size:12px; line-height:1.5; color:#8b919c;">
                  This is an automated confirmation of the inquiry you submitted to MIDIS.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export default {
  /**
   * Send the thank-you email for a freshly created inquiry.
   *
   * Safe to call more than once for the same record: the status claim below
   * means only the first caller sends anything.
   */
  async sendThankYou(inquiry: ThankYouRecipient): Promise<{ sent: boolean; reason?: string }> {
    const documentId = inquiry.documentId;

    if (process.env.THANKYOU_EMAIL_ENABLED === 'false') {
      strapi.log.info(
        '[Thank-you Email] Disabled via THANKYOU_EMAIL_ENABLED=false. Skipping.'
      );
      return { sent: false, reason: 'DISABLED' };
    }

    if (!documentId) {
      strapi.log.warn('[Thank-you Email] Skipping: record has no documentId.');
      return { sent: false, reason: 'NO_DOCUMENT_ID' };
    }

    // ── Validate the recipient before touching SMTP ────────────────────
    const recipient = typeof inquiry.businessEmail === 'string' ? inquiry.businessEmail.trim() : '';
    if (!isValidEmail(recipient)) {
      strapi.log.warn(
        `[Thank-you Email] Skipping ${documentId}: businessEmail is missing or not a valid address.`
      );
      await this.setStatus(documentId, 'skipped', { error: 'Missing or invalid businessEmail' });
      return { sent: false, reason: 'INVALID_RECIPIENT' };
    }

    // ── Idempotency claim ──────────────────────────────────────────────
    // A single conditional UPDATE is the whole guard: whichever caller flips
    // the row from `pending` to `sending` owns the send, and everyone else
    // sees count 0 and backs off. This lives in the database rather than in
    // process memory, so it also holds across restarts and multiple instances.
    const claimed = await this.claimForSending(documentId);
    if (!claimed) {
      strapi.log.info(
        `[Thank-you Email] Already claimed or sent for ${documentId}. Not sending again.`
      );
      return { sent: false, reason: 'ALREADY_CLAIMED' };
    }

    const displayName = typeof inquiry.name === 'string' && inquiry.name.trim().length > 0
      ? inquiry.name.trim()
      : 'there';

    const fromEmail = process.env.SMTP_FROM_EMAIL || 'connect@midis.in';
    const fromName = process.env.SMTP_FROM_NAME || 'MIDIS';

    const payload = {
      to: recipient,
      from: `"${fromName.replace(/"/g, '')}" <${fromEmail}>`,
      replyTo: process.env.SMTP_REPLY_TO || fromEmail,
      subject: 'Thank you for contacting MIDIS',
      text: buildPlainTextBody(displayName),
      html: buildHtmlBody(displayName),
    };

    // ── Send, retrying transient failures only ─────────────────────────
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
      try {
        // The nodemailer provider returns the transport's info object, whose
        // `response` is the SMTP server's final reply. Logging it is what makes
        // "did the provider accept this message?" answerable after the fact.
        const info: any = await strapi.plugin('email').service('email').send(payload);

        await this.setStatus(documentId, 'sent', { sentAt: new Date(), error: null });
        strapi.log.info(
          `[Thank-you Email] ✅ Sent to ${maskEmail(recipient)} for ${documentId} (attempt ${attempt}/${MAX_SEND_ATTEMPTS}).`
        );
        strapi.log.info(
          `[Thank-you Email] SMTP accepted ${documentId}: ` +
            `messageId=${info?.messageId ?? 'n/a'} response=${info?.response ?? 'n/a'}`
        );
        return { sent: true };
      } catch (error) {
        lastError = error;
        const retryable = isRetryableError(error);

        if (!retryable || attempt === MAX_SEND_ATTEMPTS) {
          break;
        }

        const delay = RETRY_BASE_DELAY_MS * attempt;
        strapi.log.warn(
          `[Thank-you Email] Attempt ${attempt}/${MAX_SEND_ATTEMPTS} failed for ${documentId} ` +
            `(${describeError(error)}). Retrying in ${delay}ms.`
        );
        await sleep(delay);
      }
    }

    const message = describeError(lastError);
    strapi.log.error(
      `[Thank-you Email] ❌ Could not send to ${maskEmail(recipient)} for ${documentId}: ${message}`
    );
    // Leave the record as `failed`, never back at `pending`, so a retry is a
    // deliberate act rather than something a later hook does by surprise.
    await this.setStatus(documentId, 'failed', { error: message });

    return { sent: false, reason: 'SEND_FAILED' };
  },

  /**
   * Atomically move the record from `pending` to `sending`.
   * Returns true only for the caller that won the claim.
   */
  async claimForSending(documentId: string): Promise<boolean> {
    try {
      const result = await strapi.db.query(UID).updateMany({
        where: { documentId, thankYouEmailStatus: 'pending' },
        data: { thankYouEmailStatus: 'sending' },
      });
      return (result?.count ?? 0) > 0;
    } catch (err) {
      strapi.log.error(
        `[Thank-you Email] Failed to claim ${documentId} for sending: ${describeError(err)}`
      );
      return false;
    }
  },

  /**
   * Record the outcome on the inquiry.
   *
   * Writes through the query engine rather than the Document Service so that
   * this bookkeeping does not re-enter the document middleware.
   */
  async setStatus(
    documentId: string,
    status: EmailStatus,
    extra: { sentAt?: Date | null; error?: string | null } = {}
  ): Promise<void> {
    try {
      const data: Record<string, unknown> = { thankYouEmailStatus: status };

      if (extra.sentAt !== undefined) {
        data.thankYouEmailSentAt = extra.sentAt;
      }
      if (extra.error !== undefined) {
        // Keep the column bounded; the full error is already in the log.
        data.thankYouEmailError = extra.error ? String(extra.error).slice(0, 1000) : null;
      }

      await strapi.db.query(UID).updateMany({ where: { documentId }, data });
    } catch (err) {
      strapi.log.error(
        `[Thank-you Email] Failed to record status '${status}' for ${documentId}: ${describeError(err)}`
      );
    }
  },

  /**
   * Verify SMTP configuration and connectivity without sending to a real
   * inquiry address. Used by the verification script and safe to call manually.
   */
  async sendTestEmail(to: string): Promise<void> {
    if (!isValidEmail(to)) {
      throw new Error('A valid test recipient address is required.');
    }

    const fromEmail = process.env.SMTP_FROM_EMAIL || 'connect@midis.in';
    const fromName = process.env.SMTP_FROM_NAME || 'MIDIS';

    await strapi.plugin('email').service('email').send({
      to,
      from: `"${fromName.replace(/"/g, '')}" <${fromEmail}>`,
      replyTo: process.env.SMTP_REPLY_TO || fromEmail,
      subject: 'MIDIS SMTP connectivity test',
      text: buildPlainTextBody('there'),
      html: buildHtmlBody('there'),
    });

    strapi.log.info(`[Thank-you Email] Test email dispatched to ${maskEmail(to)}.`);
  },
};
