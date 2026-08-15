export async function onRequestGet(context) {
  return new Response(JSON.stringify({
    ok: true,
    hasPaystackSecret: !!context.env.PAYSTACK_SECRET_KEY,
    hasSupabaseService: !!context.env.SUPABASE_SERVICE_ROLE_KEY
  }), {
    headers: { 'content-type': 'application/json' }
  });
}
