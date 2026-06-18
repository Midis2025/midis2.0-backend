/**
 * enquiry controller
 *
 * Extends the default Strapi controller to send a Meta Lead event
 * after a contact form entry is successfully created.
 */

import { factories } from '@strapi/strapi';
import metaConversionService from '../../meta/services/meta-conversion';

export default factories.createCoreController(
  'api::enquiry.enquiry',
  ({ strapi }) => ({
    /**
     * Override the default `create` action.
     *
     * Flow:
     *   1. Save the contact entry via Strapi's default create logic
     *   2. Fire a Meta Lead event (non-blocking, errors are swallowed)
     *   3. Return the original response to the frontend
     */
    async create(ctx) {
      // 1. Call the default Strapi create action
      const response = await super.create(ctx);

      // 2. Send Meta Lead event (fire-and-forget, never block the response)
      try {
        const contactData = ctx.request.body?.data || ctx.request.body || {};

        await metaConversionService.sendLeadEvent({
          email: contactData.email,
          phoneNumber: contactData.phoneNumber,
          name: contactData.name,
        });
      } catch (error) {
        // Meta failures must NEVER break the contact form submission
        console.error(
          '[Enquiry Controller] Failed to send Meta Lead event, but contact was saved successfully.',
          error instanceof Error ? error.message : error
        );
      }

      // 3. Return the original Strapi response
      return response;
    },
  })
);
