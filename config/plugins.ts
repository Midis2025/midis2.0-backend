import type { Core } from '@strapi/strapi';

/**
 * Configures Strapi's bundled Email plugin to send through the GoDaddy
 * Professional Email (Titan) mailbox over SMTP.
 *
 * Credentials come from the environment only — never commit them. See
 * `.env.example` for the variables this expects.
 */
const config = ({ env }: Core.Config.Shared.ConfigParams): Core.Config.Plugin => ({
  email: {
    config: {
      provider: 'nodemailer',
      providerOptions: {
        host: env('SMTP_HOST', 'smtpout.secureserver.net'),
        port: env.int('SMTP_PORT', 465),
        // Port 465 is implicit TLS. Set SMTP_SECURE=false only when using a
        // STARTTLS port such as 587, or a local SMTP server in tests.
        secure: env.bool('SMTP_SECURE', true),
        auth: {
          user: env('SMTP_USER'),
          pass: env('SMTP_PASSWORD'),
        },
        // Fail fast rather than letting a stuck connection hold a request open.
        connectionTimeout: env.int('SMTP_CONNECTION_TIMEOUT', 10000),
        greetingTimeout: env.int('SMTP_GREETING_TIMEOUT', 10000),
        socketTimeout: env.int('SMTP_SOCKET_TIMEOUT', 20000),
      },
      settings: {
        defaultFrom: env('SMTP_FROM_EMAIL', 'connect@midis.in'),
        defaultFromName: env('SMTP_FROM_NAME', 'MIDIS'),
        defaultReplyTo: env('SMTP_REPLY_TO', env('SMTP_FROM_EMAIL', 'connect@midis.in')),
      },
    },
  },
});

export default config;
