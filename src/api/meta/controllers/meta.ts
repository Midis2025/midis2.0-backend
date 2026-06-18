/**
 * Meta test controller
 *
 * Provides a temporary test endpoint to verify Meta Conversions API integration.
 */

import metaConversionService from '../services/meta-conversion';

export default {
  /**
   * POST /api/meta/test-lead
   *
   * Sends a sample Lead event to Meta and returns the result.
   */
  async testLead(ctx) {
    try {
      const body = ctx.request.body || {};

      const sampleData = {
        email: body.email || 'test@example.com',
        phoneNumber: body.phoneNumber || '+1234567890',
        name: body.name || 'Test User',
      };

      // Accept test_event_code from request body or env variable
      const testEventCode =
        body.test_event_code || process.env.META_TEST_EVENT_CODE;

      const result = await metaConversionService.sendLeadEvent(
        sampleData,
        testEventCode
      );

      if (result) {
        ctx.body = {
          success: true,
          message: 'Lead event sent',
          data: result,
        };
      } else {
        ctx.body = {
          success: false,
          error:
            'Lead event could not be sent. Check server logs and ensure META_PIXEL_ID and META_ACCESS_TOKEN are configured.',
        };
      }
    } catch (error) {
      ctx.body = {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  },
};
