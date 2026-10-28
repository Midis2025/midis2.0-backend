import type { Core } from '@strapi/strapi';
import hubspotService from './api/portfolio-inquiry/services/hubspot';

const PORTFOLIO_INQUIRY_UID = 'api::portfolio-inquiry.portfolio-inquiry';

export default {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * Registers a Document Service middleware so that every portfolio inquiry is
   * pushed to HubSpot no matter how it was created: the public REST endpoint,
   * the admin Content Manager, GraphQL or a seed script. The controller alone
   * cannot do this, because the Content Manager calls
   * `strapi.documents(uid).create()` directly and never runs the API controller.
   */
  register({ strapi }: { strapi: Core.Strapi }) {
    strapi.documents.use(async (context, next) => {
      const result = await next();

      // Only brand new inquiries trigger a sync. Narrowing to `create` also keeps
      // the status write-back in `updateStrapiStatus` (a `update` call) from
      // re-entering this middleware and recursing.
      if (context.uid !== PORTFOLIO_INQUIRY_UID || context.action !== 'create') {
        return result;
      }

      const inquiry = result as any;

      if (!inquiry?.documentId || !inquiry?.name || !inquiry?.businessEmail) {
        strapi.log.warn(
          '[Portfolio Inquiry] Skipping HubSpot sync: created document is missing documentId, name or businessEmail.'
        );
        return result;
      }

      // Fire and forget: the inquiry is already persisted, so a CRM outage must
      // not fail the request. Failures are recorded on `hubspotSyncStatus`.
      hubspotService
        .syncInquiry({
          id: inquiry.id,
          documentId: inquiry.documentId,
          name: inquiry.name,
          businessEmail: inquiry.businessEmail,
          phoneCountryCode: inquiry.phoneCountryCode,
          phoneNumber: inquiry.phoneNumber,
          websiteUrl: inquiry.websiteUrl,
          serviceNeeded: inquiry.serviceNeeded,
          sourceWebsite: inquiry.sourceWebsite,
          submissionType: inquiry.submissionType,
        })
        .catch((syncErr) => {
          strapi.log.error(
            `[Portfolio Inquiry] Background HubSpot sync error for ${inquiry.documentId}: ${
              syncErr instanceof Error ? syncErr.message : syncErr
            }`
          );
        });

      return result;
    });
  },

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * Ensures the Public role has create permission for portfolio-inquiries,
   * while keeping find, findOne, update, and delete restricted.
   */
  async bootstrap({ strapi }: { strapi: Core.Strapi }) {
    try {
      const publicRole = await strapi.db
        .query('plugin::users-permissions.role')
        .findOne({ where: { type: 'public' }, populate: ['permissions'] });

      if (publicRole) {
        const requiredAction = 'api::portfolio-inquiry.portfolio-inquiry.create';
        const hasPermission = publicRole.permissions?.some(
          (p: any) => p.action === requiredAction
        );

        if (!hasPermission) {
          await strapi.db
            .query('plugin::users-permissions.permission')
            .create({
              data: {
                action: requiredAction,
                role: publicRole.id,
              },
            });
          strapi.log.info(
            `[Bootstrap] Granted public create permission for ${requiredAction}`
          );
        }
      }
    } catch (error) {
      strapi.log.error(
        '[Bootstrap] Failed to configure public permissions for portfolio-inquiry:',
        error
      );
    }
  },
};
