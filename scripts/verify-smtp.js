/**
 * SMTP connectivity check for the MIDIS thank-you email.
 *
 * Boots Strapi, then sends one test email through the configured Email plugin
 * provider. Use this to confirm the GoDaddy / Titan mailbox credentials before
 * relying on the automatic thank-you email.
 *
 *   node scripts/verify-smtp.js you@yourdomain.com
 *
 * Reads SMTP_* from the environment (and therefore from .env in development).
 * It prints no credentials. Nothing is written to the portfolio-inquiries
 * collection, so this cannot trigger a HubSpot sync or a duplicate contact.
 */

// Load .env up front: Strapi does this itself, but only once it boots, and the
// configuration check below needs the values before that.
require('dotenv').config();

const RECIPIENT = process.argv[2];

(async () => {
  if (!RECIPIENT) {
    console.error('Usage: node scripts/verify-smtp.js <test-recipient@example.com>');
    process.exit(1);
  }

  const required = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(`Missing required environment variable(s): ${missing.join(', ')}`);
    console.error('Set them in .env (development) or the deployment environment.');
    process.exit(1);
  }

  console.log('SMTP configuration in use (password withheld):');
  console.log(`  host   : ${process.env.SMTP_HOST}`);
  console.log(`  port   : ${process.env.SMTP_PORT}`);
  console.log(`  secure : ${process.env.SMTP_SECURE ?? '(default true)'}`);
  console.log(`  user   : ${process.env.SMTP_USER}`);
  console.log(`  from   : ${process.env.SMTP_FROM_NAME ?? 'MIDIS'} <${process.env.SMTP_FROM_EMAIL ?? 'connect@midis.in'}>`);
  console.log('');

  const strapiFactory = require('@strapi/strapi');
  const app = await strapiFactory.createStrapi(await strapiFactory.compileStrapi()).load();

  try {
    await app.service('api::portfolio-inquiry.thank-you-email').sendTestEmail(RECIPIENT);
    console.log(`\n✅ SMTP accepted the message for ${RECIPIENT}.`);
    console.log('Check that address (including spam) to confirm delivery and rendering.');
    await app.destroy();
    process.exit(0);
  } catch (error) {
    const code = error && error.code ? ` code=${error.code}` : '';
    const smtp = error && error.responseCode ? ` smtp=${error.responseCode}` : '';
    console.error(`\n❌ SMTP send failed: ${error && error.message}${code}${smtp}`);
    if (error && error.code === 'EAUTH') {
      console.error('EAUTH means the mailbox rejected the credentials: check SMTP_USER / SMTP_PASSWORD.');
    }
    await app.destroy();
    process.exit(1);
  }
})();
