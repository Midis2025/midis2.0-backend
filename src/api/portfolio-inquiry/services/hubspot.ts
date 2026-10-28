/**
 * HubSpot CRM Integration Service for Portfolio Inquiries
 *
 * Handles:
 *  - Contact search by email (deduplication)
 *  - Contact creation and property updates
 *  - Full international phone normalization
 *  - Creating and associating submission notes for inquiry history
 *  - Graceful fallback if custom properties do not yet exist in HubSpot
 *  - Retries with backoff for transient network / rate-limit failures
 *  - Recording sync status and contact ID back to Strapi
 */

interface InquiryData {
  id: number | string;
  documentId?: string;
  name: string;
  businessEmail: string;
  phoneCountryCode: string;
  phoneNumber: string;
  websiteUrl?: string | null;
  serviceNeeded: string;
  sourceWebsite: string;
  submissionType?: string | null;
  hubspotContactId?: string | null;
  hubspotSyncStatus?: string | null;
}

interface NameParts {
  firstname: string;
  lastname?: string;
}

/**
 * Split full name into first and last name.
 * Handles single-word names safely without failure.
 */
export function parseFullName(fullName: string): NameParts {
  const trimmed = fullName.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) {
    return { firstname: parts[0] };
  }
  return {
    firstname: parts[0],
    lastname: parts.slice(1).join(' '),
  };
}

/**
 * Normalize phone number with country calling code.
 * Strips non-digits from local number and ensures leading '+' on country code.
 * Prevents duplicating country code if entered in both fields.
 */
export function normalizePhoneNumber(countryCode: string, localNumber: string): string {
  let cleanCode = countryCode.trim().replace(/[^\d+]/g, '');
  if (!cleanCode.startsWith('+')) {
    cleanCode = `+${cleanCode}`;
  }

  const cleanLocal = localNumber.trim().replace(/\D/g, '');
  const codeDigits = cleanCode.replace(/\D/g, '');

  // If the user included the country code in the phone number field as well, don't duplicate
  if (cleanLocal.startsWith(codeDigits)) {
    return `+${cleanLocal}`;
  }

  return `${cleanCode}${cleanLocal}`;
}

/**
 * Sleep helper for retries.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Route logs through Strapi's logger when running inside Strapi so that HubSpot
 * failures show up in the application log (and in whatever ships it in
 * production), falling back to the console in plain unit-test contexts.
 *
 * Never pass the access token or a full inquiry payload in here.
 */
const log = {
  info(message: string): void {
    // @ts-ignore strapi is a runtime global inside Strapi
    if (typeof strapi !== 'undefined' && strapi.log) strapi.log.info(message);
    else console.log(message);
  },
  warn(message: string): void {
    // @ts-ignore
    if (typeof strapi !== 'undefined' && strapi.log) strapi.log.warn(message);
    else console.warn(message);
  },
  error(message: string): void {
    // @ts-ignore
    if (typeof strapi !== 'undefined' && strapi.log) strapi.log.error(message);
    else console.error(message);
  },
};

/**
 * Reduce an error to a loggable string.
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * HubSpot echoes submitted property values back in validation errors, which can
 * include the contact's email and phone. Keep the status and error shape, drop
 * the personal data.
 */
function redactErrorBody(body: string): string {
  return (
    body
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email redacted]')
      // E.164 or a bare run of digits. Deliberately narrow so that HubSpot
      // correlation IDs (hex blocks joined by hyphens) stay readable — they are
      // what HubSpot support asks for.
      .replace(/\+\d{7,15}\b/g, '[phone redacted]')
      .replace(/\b\d{10,15}\b/g, '[phone redacted]')
  );
}

export default {
  /**
   * Main synchronization entry point.
   */
  async syncInquiry(inquiry: InquiryData) {
    const token = process.env.HUBSPOT_ACCESS_TOKEN;
    const strapiRecordId = String(inquiry.documentId || inquiry.id);

    if (process.env.HUBSPOT_SYNC_ENABLED === 'false') {
      log.info(
        `[HubSpot Sync] HubSpot synchronization is disabled via HUBSPOT_SYNC_ENABLED=false. Skipping inquiry #${strapiRecordId}.`
      );
      return { success: false, reason: 'SYNC_DISABLED' };
    }

    if (!token) {
      log.warn(
        `[HubSpot Sync] ⚠️ HUBSPOT_ACCESS_TOKEN is not configured in environment variables. Skipping HubSpot sync for inquiry #${strapiRecordId}.`
      );
      return { success: false, reason: 'MISSING_CREDENTIALS' };
    }

    try {
      log.info(`[HubSpot Sync] Starting HubSpot sync for inquiry #${strapiRecordId}`);

      // 1. Prepare and normalize data
      const { firstname, lastname } = parseFullName(inquiry.name);
      const fullPhone = normalizePhoneNumber(inquiry.phoneCountryCode, inquiry.phoneNumber);
      const trimmedWebsite = inquiry.websiteUrl?.trim();

      // Standard HubSpot Contact Properties
      const standardProperties: Record<string, string> = {
        email: inquiry.businessEmail.trim().toLowerCase(),
        firstname,
        phone: fullPhone,
      };

      if (lastname && lastname.length > 0) {
        standardProperties.lastname = lastname;
      }

      if (trimmedWebsite && trimmedWebsite.length > 0) {
        standardProperties.website = trimmedWebsite;
      }

      // MIDIS Custom Contact Properties
      const customProperties: Record<string, string> = {
        ...standardProperties,
        midis_contact_name: inquiry.name.trim(),
        midis_business_email: inquiry.businessEmail.trim().toLowerCase(),
        midis_contact_phone: fullPhone,
        midis_portfolio_service_needed: inquiry.serviceNeeded,
        midis_portfolio_lead_source: inquiry.sourceWebsite || 'midis-portfolio',
        midis_portfolio_last_strapi_record_id: strapiRecordId,
      };

      if (trimmedWebsite && trimmedWebsite.length > 0) {
        customProperties.midis_website_url = trimmedWebsite;
      }

      if (
        inquiry.submissionType &&
        (inquiry.submissionType === 'consultation-popup' ||
          inquiry.submissionType === 'main-contact-form')
      ) {
        customProperties.midis_portfolio_last_submission_type = inquiry.submissionType;
      }

      // 2. Find or Create/Update Contact
      let contactId: string | null = null;

      // Check if contact already exists
      const existingContact = await this.searchContactByEmail(token, inquiry.businessEmail);

      if (existingContact) {
        contactId = existingContact.id;
        log.info(`[HubSpot Sync] Existing contact found with ID ${contactId}. Updating contact...`);
        await this.updateContact(token, contactId, customProperties, standardProperties);
      } else {
        log.info(`[HubSpot Sync] Contact does not exist. Creating new contact...`);
        contactId = await this.createContact(token, customProperties, standardProperties);
      }

      if (!contactId) {
        throw new Error('Failed to obtain a valid HubSpot contact ID.');
      }

      // 3. Create Note for submission history and associate with contact
      await this.createInquiryNote(token, contactId, inquiry, fullPhone, strapiRecordId);

      // 4. Update Strapi Record with sync status and contact ID
      await this.updateStrapiStatus(inquiry, 'synced', contactId);

      log.info(
        `[HubSpot Sync] ✅ Successfully synced inquiry #${strapiRecordId} to HubSpot contact ${contactId}.`
      );

      return { success: true, contactId };
    } catch (error) {
      log.error(
        `[HubSpot Sync] ❌ Failed to sync inquiry #${strapiRecordId} to HubSpot: ${describeError(error)}`
      );

      // Mark Strapi entry as failed so it can be audited or retried
      await this.updateStrapiStatus(inquiry, 'failed', null).catch((statusErr) => {
        log.error(
          `[HubSpot Sync] Failed to update Strapi status to 'failed': ${describeError(statusErr)}`
        );
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'UNKNOWN_ERROR',
      };
    }
  },

  /**
   * Search for an existing contact by email.
   */
  async searchContactByEmail(token: string, email: string): Promise<{ id: string } | null> {
    const url = 'https://api.hubapi.com/crm/v3/objects/contacts/search';
    const payload = {
      filterGroups: [
        {
          filters: [
            {
              propertyName: 'email',
              operator: 'EQ',
              value: email.trim().toLowerCase(),
            },
          ],
        },
      ],
      properties: ['id', 'email', 'firstname', 'lastname'],
      limit: 1,
    };

    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = redactErrorBody(await response.text());
      throw new Error(`Contact search failed (${response.status}): ${errText}`);
    }

    const data: any = await response.json();
    if (data.results && data.results.length > 0) {
      return { id: String(data.results[0].id) };
    }

    return null;
  },

  /**
   * Create a new contact, with fallback to standard properties if custom properties do not exist.
   */
  async createContact(
    token: string,
    propertiesWithCustom: Record<string, string>,
    standardProperties: Record<string, string>
  ): Promise<string> {
    const url = 'https://api.hubapi.com/crm/v3/objects/contacts';

    let response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ properties: propertiesWithCustom }),
    });

    // If 409 Conflict (contact already exists concurrently)
    if (response.status === 409) {
      const errData: any = await response.json();
      const match = errData?.message?.match(/Existing ID: (\d+)/i);
      if (match && match[1]) {
        log.info(`[HubSpot Sync] Contact already exists (ID: ${match[1]}). Updating instead...`);
        await this.updateContact(token, match[1], propertiesWithCustom, standardProperties);
        return match[1];
      }
      throw new Error(`Contact conflict (409): ${redactErrorBody(JSON.stringify(errData))}`);
    }

    // If custom property error (PROPERTY_DOESNT_EXIST), retry with standard properties.
    // Only a genuinely missing property justifies dropping the custom payload —
    // any other validation error (an invalid email, a value outside an
    // enumeration) must surface as-is instead of being reported as a missing
    // property and silently losing the MIDIS fields.
    if (!response.ok && response.status === 400) {
      const errData: any = await response.json();
      const errMsg = redactErrorBody(JSON.stringify(errData));
      if (errMsg.includes('PROPERTY_DOESNT_EXIST')) {
        log.warn(
          `[HubSpot Sync] ⚠️ Custom properties are missing in your HubSpot account (${errMsg}). Falling back to standard contact properties.\n` +
          `To enable custom property tracking, create the following HubSpot Contact Properties:\n` +
          `  - 'midis_portfolio_service_needed' (Dropdown Select or Single-line text)\n` +
          `  - 'midis_portfolio_lead_source' (Single-line text)\n` +
          `  - 'midis_portfolio_last_submission_type' (Single-line text)\n` +
          `  - 'midis_portfolio_last_strapi_record_id' (Single-line text)`
        );

        response = await this.fetchWithRetry(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ properties: standardProperties }),
        });
      } else {
        throw new Error(`Contact creation failed (400): ${errMsg}`);
      }
    }

    if (!response.ok) {
      const errText = redactErrorBody(await response.text());
      throw new Error(`Contact creation failed (${response.status}): ${errText}`);
    }

    const created: any = await response.json();
    return String(created.id);
  },

  /**
   * Update an existing contact, with fallback to standard properties if custom properties do not exist.
   */
  async updateContact(
    token: string,
    contactId: string,
    propertiesWithCustom: Record<string, string>,
    standardProperties: Record<string, string>
  ): Promise<void> {
    const url = `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`;

    let response = await this.fetchWithRetry(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ properties: propertiesWithCustom }),
    });

    if (!response.ok && response.status === 400) {
      const errData = await response.json();
      const errMsg = redactErrorBody(JSON.stringify(errData));
      // See createContact: narrow to a genuinely missing property so other
      // validation failures are not mislabelled.
      if (errMsg.includes('PROPERTY_DOESNT_EXIST')) {
        log.warn(
          `[HubSpot Sync] ⚠️ Custom properties missing in HubSpot. Updating contact with standard properties only.`
        );

        response = await this.fetchWithRetry(url, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ properties: standardProperties }),
        });
      } else {
        throw new Error(`Contact update failed (400): ${errMsg}`);
      }
    }

    if (!response.ok) {
      const errText = redactErrorBody(await response.text());
      throw new Error(`Contact update failed (${response.status}): ${errText}`);
    }
  },

  /**
   * Create an inquiry note and associate it with the contact.
   * associationTypeId 202 is the HubSpot defined standard for note_to_contact.
   */
  async createInquiryNote(
    token: string,
    contactId: string,
    inquiry: InquiryData,
    fullPhone: string,
    strapiRecordId: string
  ): Promise<void> {
    const url = 'https://api.hubapi.com/crm/v3/objects/notes';

    const timestamp = new Date().toISOString();
    const noteBody = [
      '📋 Midis Portfolio Consultation Inquiry',
      '───────────────────────────────────────',
      `• Name: ${inquiry.name}`,
      `• Business Email: ${inquiry.businessEmail}`,
      `• Phone Number: ${fullPhone}`,
      `• Website URL: ${inquiry.websiteUrl || 'Not provided'}`,
      `• Requested Service: ${inquiry.serviceNeeded}`,
      `• Source Website: ${inquiry.sourceWebsite || 'midis-portfolio'}`,
      `• Strapi Record ID: ${strapiRecordId}`,
      `• Submission Timestamp: ${timestamp}`,
    ].join('\n');

    const payload = {
      properties: {
        hs_timestamp: timestamp,
        hs_note_body: noteBody,
      },
      associations: [
        {
          to: {
            id: String(contactId),
          },
          types: [
            {
              associationCategory: 'HUBSPOT_DEFINED',
              associationTypeId: 202,
            },
          ],
        },
      ],
    };

    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = redactErrorBody(await response.text());
      log.error(`[HubSpot Sync] Warning: Note creation failed (${response.status}): ${errText}`);
      // Note creation failure should not throw if contact was already created/updated
    } else {
      log.info(`[HubSpot Sync] ✅ Associated inquiry note created for contact ${contactId}.`);
    }
  },

  /**
   * Update Strapi record with HubSpot sync status and contact ID.
   */
  async updateStrapiStatus(
    inquiry: InquiryData,
    status: 'synced' | 'failed',
    contactId: string | null
  ): Promise<void> {
    const documentId = inquiry.documentId;
    if (!documentId) return;

    try {
      const updateData: Record<string, any> = {
        hubspotSyncStatus: status,
      };
      if (contactId) {
        updateData.hubspotContactId = String(contactId);
      }

      // @ts-ignore strapi is globally available in Strapi runtime
      if (typeof strapi !== 'undefined' && strapi.documents) {
        // @ts-ignore
        await strapi.documents('api::portfolio-inquiry.portfolio-inquiry').update({
          documentId,
          data: updateData,
        });
      }
    } catch (err) {
      log.error(
        `[HubSpot Sync] Failed to update Strapi sync status for document ${documentId}: ${describeError(err)}`
      );
    }
  },

  /**
   * HTTP request with exponential backoff retry for transient network issues or rate limits (429/5xx).
   */
  async fetchWithRetry(url: string, options: RequestInit, retries = 2, delayMs = 1000): Promise<Response> {
    let attempt = 0;
    while (attempt <= retries) {
      try {
        const response = await fetch(url, options);

        // If rate limited or server error, retry
        if ((response.status === 429 || response.status >= 500) && attempt < retries) {
          attempt++;
          log.warn(
            `[HubSpot Sync] Transient response status ${response.status}. Retrying attempt ${attempt}/${retries} in ${delayMs}ms...`
          );
          await sleep(delayMs * attempt);
          continue;
        }

        return response;
      } catch (err) {
        attempt++;
        if (attempt <= retries) {
          log.warn(
            `[HubSpot Sync] Network error during request. Retrying attempt ${attempt}/${retries} in ${delayMs}ms: ${describeError(err)}`
          );
          await sleep(delayMs * attempt);
          continue;
        }
        throw err;
      }
    }

    throw new Error('Unexpected retry loop exit');
  },
};
