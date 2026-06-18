/**
 * Meta (Facebook) Conversions API Service
 *
 * Reusable service for sending events to Meta's Conversions API.
 * Handles SHA256 hashing of user data and API communication.
 */

import crypto from 'crypto';

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * SHA256 hash a string value after trimming and lowercasing.
 */
function hashSHA256(value: string): string {
  return crypto
    .createHash('sha256')
    .update(value.trim().toLowerCase())
    .digest('hex');
}

/**
 * Normalize a phone number by stripping all non-digit characters (except leading +).
 */
function normalizePhone(phone: string): string {
  // Keep only digits and a leading '+'
  return phone.replace(/[^\d+]/g, '');
}

// ── Types ────────────────────────────────────────────────────────────

interface ContactData {
  email?: string | null;
  phoneNumber?: string | null;
  name?: string | null;
}

interface MetaUserData {
  em?: string[];
  ph?: string[];
  fn?: string[];
}

interface MetaEvent {
  event_name: string;
  event_time: number;
  action_source: string;
  user_data: MetaUserData;
}

interface MetaPayload {
  data: MetaEvent[];
  test_event_code?: string;
}

// ── Service ──────────────────────────────────────────────────────────

export default {
  /**
   * Send a "Lead" event to Meta Conversions API.
   *
   * @param contactData - The contact form data (email, phoneNumber, name)
   * @param testEventCode - Optional test_event_code for Meta Test Events tab
   * @returns The Meta API response or null on failure
   */
  async sendLeadEvent(contactData: ContactData, testEventCode?: string) {
    const pixelId = process.env.META_PIXEL_ID;
    const accessToken = process.env.META_ACCESS_TOKEN;

    if (!pixelId || !accessToken) {
      console.warn(
        '[Meta Conversions API] META_PIXEL_ID or META_ACCESS_TOKEN is not configured. Skipping event.'
      );
      return null;
    }

    // Build user_data – send only available fields
    const userData: MetaUserData = {};

    if (contactData.email) {
      userData.em = [hashSHA256(contactData.email)];
    }

    if (contactData.phoneNumber) {
      const normalized = normalizePhone(contactData.phoneNumber);
      if (normalized) {
        userData.ph = [hashSHA256(normalized)];
      }
    }

    if (contactData.name) {
      userData.fn = [hashSHA256(contactData.name)];
    }

    // At least one identifier is required
    if (!userData.em && !userData.ph) {
      console.warn(
        '[Meta Conversions API] No email or phone available. Skipping Lead event.'
      );
      return null;
    }

    const eventTime = Math.floor(Date.now() / 1000);

    const payload: MetaPayload = {
      data: [
        {
          event_name: 'Lead',
          event_time: eventTime,
          action_source: 'website',
          user_data: userData,
        },
      ],
      ...(testEventCode ? { test_event_code: testEventCode } : {}),
    };

    const url = `https://graph.facebook.com/v23.0/${pixelId}/events?access_token=${accessToken}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const responseBody = await response.json();

      if (response.ok) {
        console.log('[Meta Conversions API] ✅ Meta Lead Event Sent', {
          event_name: 'Lead',
          event_time: eventTime,
          status: response.status,
          response: responseBody,
        });
      } else {
        console.error('[Meta Conversions API] ❌ Meta Lead Event Failed', {
          status: response.status,
          response: responseBody,
        });
      }

      return responseBody;
    } catch (error) {
      console.error('[Meta Conversions API] ❌ Meta Lead Event Failed', {
        error: error instanceof Error ? error.message : error,
      });
      return null;
    }
  },
};
