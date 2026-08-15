export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Server routes (secrets live ONLY in env)
    if (url.pathname === '/health') {
      return Response.json({
        ok: true,
        hasPaystackSecret: !!env.PAYSTACK_SECRET_KEY,
        hasSupabaseService: !!env.SUPABASE_SERVICE_ROLE_KEY
      });
    }

    // Everything else = your website (index.html etc.)
    return env.ASSETS.fetch(request);
  }
};
