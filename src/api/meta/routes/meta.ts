/**
 * Meta test routes
 *
 * Custom routes for the Meta Conversions API test endpoint.
 */

export default {
  routes: [
    {
      method: 'POST',
      path: '/meta/test-lead',
      handler: 'meta.testLead',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
  ],
};
