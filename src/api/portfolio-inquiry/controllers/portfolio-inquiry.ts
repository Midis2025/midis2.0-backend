/**
 * portfolio-inquiry controller
 *
 * Implements strict input validation, sanitization,
 * automated HubSpot CRM synchronization, and optional Meta Conversions API events.
 */

import { factories } from '@strapi/strapi';
import { normalizePhoneNumber } from '../services/hubspot';
import metaConversionService from '../../meta/services/meta-conversion';

const VALID_SERVICES = [
  'new-website-development',
  'website-redesign',
  'e-commerce-website',
  'landing-page-development',
  'not-sure-yet',
] as const;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^[0-9\s\-()]{6,20}$/;

export default factories.createCoreController(
  'api::portfolio-inquiry.portfolio-inquiry',
  ({ strapi }) => ({
    /**
     * Override default create action to validate input and trigger CRM synchronization.
     */
    async create(ctx) {
      const rawData = ctx.request.body?.data || ctx.request.body || {};

      // ── 1. Validation & Sanitization ─────────────────────────────────

      // Name
      const name = typeof rawData.name === 'string' ? rawData.name.trim() : '';
      if (!name) {
        return ctx.badRequest('Full name is required.');
      }

      // Business Email
      const email = typeof rawData.businessEmail === 'string' ? rawData.businessEmail.trim().toLowerCase() : '';
      if (!email || !EMAIL_REGEX.test(email)) {
        return ctx.badRequest('A valid business email address is required.');
      }

      // Phone Country Code
      let phoneCountryCode = typeof rawData.phoneCountryCode === 'string' ? rawData.phoneCountryCode.trim() : '';
      if (!phoneCountryCode) {
        return ctx.badRequest('Phone country code is required (e.g. +91).');
      }
      if (!phoneCountryCode.startsWith('+')) {
        phoneCountryCode = `+${phoneCountryCode.replace(/\D/g, '')}`;
      }

      // Phone Number
      const phoneNumber = typeof rawData.phoneNumber === 'string' ? rawData.phoneNumber.trim() : '';
      const cleanPhoneDigits = phoneNumber.replace(/\D/g, '');
      if (!cleanPhoneDigits || cleanPhoneDigits.length < 5 || cleanPhoneDigits.length > 15) {
        return ctx.badRequest('A valid phone number is required (5 to 15 digits).');
      }

      // Service Needed (Enum)
      const serviceNeeded = typeof rawData.serviceNeeded === 'string' ? rawData.serviceNeeded.trim() : '';
      if (!VALID_SERVICES.includes(serviceNeeded as any)) {
        return ctx.badRequest(
          `Invalid or missing serviceNeeded. Must be one of: ${VALID_SERVICES.join(', ')}.`
        );
      }

      // Website URL (Optional)
      let websiteUrl: string | null = null;
      if (rawData.websiteUrl && typeof rawData.websiteUrl === 'string') {
        const trimmedUrl = rawData.websiteUrl.trim();
        if (trimmedUrl.length > 0) {
          // If protocol omitted, add https:// for validation
          const urlToTest = /^https?:\/\//i.test(trimmedUrl) ? trimmedUrl : `https://${trimmedUrl}`;
          try {
            new URL(urlToTest);
            websiteUrl = urlToTest;
          } catch {
            return ctx.badRequest('Provided website URL is invalid.');
          }
        }
      }

      // Source Website: enforce 'midis-portfolio'
      const sourceWebsite = 'midis-portfolio';

      // Submission Type (Optional) — persisted so the HubSpot sync middleware
      // can read it off the created document.
      const submissionType =
        typeof rawData.submissionType === 'string' && rawData.submissionType.trim().length > 0
          ? rawData.submissionType.trim()
          : null;

      // Prepare sanitized data for Strapi Document Service
      const sanitizedData = {
        name,
        businessEmail: email,
        phoneCountryCode,
        phoneNumber: cleanPhoneDigits,
        websiteUrl,
        serviceNeeded,
        sourceWebsite,
        submissionType,
        hubspotSyncStatus: 'pending',
      };

      ctx.request.body = { data: sanitizedData };

      // ── 2. Save inquiry to Strapi ─────────────────────────────────────
      let response;
      try {
        response = await super.create(ctx);
      } catch (err: any) {
        console.error('[Portfolio Inquiry] Error persisting inquiry to Strapi:', err);
        return ctx.badRequest(err?.message || 'Failed to save portfolio inquiry.');
      }

      // ── 3. Post-save Asynchronous Integrations ────────────────────────
      // NOTE: HubSpot synchronization is NOT triggered here. It runs in the
      // Document Service middleware registered in `src/index.ts`, so that
      // inquiries created through the admin Content Manager are synced too.
      // Calling it here as well would sync every API submission twice.

      // Send Meta Conversions API event if configured
      const fullPhone = normalizePhoneNumber(phoneCountryCode, cleanPhoneDigits);
      metaConversionService
        .sendLeadEvent({
          email,
          phoneNumber: fullPhone,
          name,
        })
        .catch((metaErr) => {
          console.error('[Portfolio Inquiry] Failed to send Meta Lead event:', metaErr);
        });

      // ── 4. Return standard Strapi response ────────────────────────────
      return response;
    },
  })
);
