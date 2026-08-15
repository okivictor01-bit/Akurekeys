const PAYSTACK = 'https://api.paystack.co';

async function authUser(env, request) {
  const auth = request.headers.get('Authorization');
  if (!auth) return null;
  const r = await fetch(env.SUPABASE_URL + '/auth/v1/user', {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: auth }
  });
  if (!r.ok) return null;
  return await r.json();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({
        ok: true,
        hasPaystackSecret: !!env.PAYSTACK_SECRET_KEY,
        hasSupabaseService: !!env.SUPABASE_SERVICE_ROLE_KEY
      });
    }

    if (url.pathname === '/api/pay/initialize' && request.method === 'POST') {
      const user = await authUser(env, request);
      if (!user) return Response.json({ error: 'Sign in first.' }, { status: 401 });

      const init = await fetch(PAYSTACK + '/transaction/initialize', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + env.PAYSTACK_SECRET_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          email: user.email,
          amount: 1000 * 100,
          callback_url: url.origin + '/',
          metadata: { purpose: 'akurekeys_test_payment' }
        })
      });
      const data = await init.json();
      if (!data.status) return Response.json({ error: data.message || 'Initialize failed' }, { status: 400 });
      return Response.json({ authorization_url: data.data.authorization_url, reference: data.data.reference });
    }

    if (url.pathname === '/api/pay/verify' && request.method === 'POST') {
      const user = await authUser(env, request);
      if (!user) return Response.json({ error: 'Sign in first.' }, { status: 401 });
      const { reference } = await request.json();
      if (!reference) return Response.json({ error: 'Missing reference' }, { status: 400 });

      const v = await fetch(PAYSTACK + '/transaction/verify/' + encodeURIComponent(reference), {
        headers: { Authorization: 'Bearer ' + env.PAYSTACK_SECRET_KEY }
      });
      const data = await v.json();
      if (!data.status) return Response.json({ error: data.message }, { status: 400 });
      const ok = data.data.status === 'success' && data.data.amount === 1000 * 100;
      return Response.json({ paid: ok, reference: reference, amount: data.data.amount });
    }

    return env.ASSETS.fetch(request);
  }
};
