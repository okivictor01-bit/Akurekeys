// akurekeys worker v5 - duplicate-proof access fees
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

function adminHeaders(env) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json'
  };
}

async function startPaystack(env, email, reference, callbackUrl) {
  const init = await fetch(PAYSTACK + '/transaction/initialize', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.PAYSTACK_SECRET_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, amount: 1000 * 100, reference: reference, callback_url: callbackUrl })
  });
  return await init.json();
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (url.pathname === '/health') {
        return Response.json({
          ok: true,
          SUPABASE_URL: !!env.SUPABASE_URL,
          SUPABASE_ANON_KEY: !!env.SUPABASE_ANON_KEY,
          SUPABASE_SERVICE_ROLE_KEY: !!env.SUPABASE_SERVICE_ROLE_KEY,
          PAYSTACK_SECRET_KEY: !!env.PAYSTACK_SECRET_KEY
        });
      }

      if (url.pathname === '/api/fee/initialize' && request.method === 'POST') {
        const missing = ['SUPABASE_URL','SUPABASE_ANON_KEY','SUPABASE_SERVICE_ROLE_KEY','PAYSTACK_SECRET_KEY'].filter(k => !env[k]);
        if (missing.length) return Response.json({ error: 'Missing env: ' + missing.join(', ') }, { status: 500 });

        const user = await authUser(env, request);
        if (!user) return Response.json({ error: 'Sign in first.' }, { status: 401 });
        const { property_id } = await request.json();
        if (!property_id) return Response.json({ error: 'Missing property_id' }, { status: 400 });

        // payer must have a profile (foreign key)
        const prof = await fetch(env.SUPABASE_URL + '/rest/v1/profiles?id=eq.' + user.id, { headers: adminHeaders(env) });
        const profRows = await prof.json();
        if (Array.isArray(profRows) && profRows.length === 0) {
          await fetch(env.SUPABASE_URL + '/rest/v1/profiles', {
            method: 'POST',
            headers: adminHeaders(env),
            body: JSON.stringify({ id: user.id, full_name: String(user.email).split('@')[0], phone: '+2348000000000', role: 'tenant' })
          });
        }

        // duplicate-proof: check existing active fee
        const ex = await fetch(env.SUPABASE_URL + '/rest/v1/property_access_fees?tenant_id=eq.' + user.id + '&property_id=eq.' + property_id + '&select=id,status,paystack_reference', { headers: adminHeaders(env) });
        const rows = await ex.json();
        if (Array.isArray(rows) && rows.length > 0) {
          if (rows[0].status === 'paid') return Response.json({ already_paid: true });
          // reuse the initiated row (no duplicate)
          const data = await startPaystack(env, user.email, rows[0].paystack_reference, url.origin + '/browse.html');
          if (!data.status) return Response.json({ error: data.message || 'Initialize failed' }, { status: 400 });
          return Response.json({ authorization_url: data.data.authorization_url, reference: rows[0].paystack_reference });
        }

        const reference = 'AKF_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
        const ins = await fetch(env.SUPABASE_URL + '/rest/v1/property_access_fees', {
          method: 'POST',
          headers: adminHeaders(env),
          body: JSON.stringify({ tenant_id: user.id, property_id: property_id, amount_naira: 1000, paystack_reference: reference })
        });
        if (!ins.ok) return Response.json({ error: 'DB insert failed: ' + (await ins.text()).slice(0, 200) }, { status: 500 });

        const data = await startPaystack(env, user.email, reference, url.origin + '/browse.html');
        if (!data.status) return Response.json({ error: data.message || 'Initialize failed' }, { status: 400 });
        return Response.json({ authorization_url: data.data.authorization_url, reference: reference });
      }

      if (url.pathname === '/api/pay/verify' && request.method === 'POST') {
        const missing = ['PAYSTACK_SECRET_KEY','SUPABASE_SERVICE_ROLE_KEY','SUPABASE_URL'].filter(k => !env[k]);
        if (missing.length) return Response.json({ error: 'Missing env: ' + missing.join(', ') }, { status: 500 });
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

        let dbUpdated = false;
        if (ok && reference.startsWith('AKF_')) {
          const pr = await fetch(env.SUPABASE_URL + '/rest/v1/property_access_fees?paystack_reference=eq.' + encodeURIComponent(reference), {
            method: 'PATCH',
            headers: adminHeaders(env),
            body: JSON.stringify({ status: 'paid', paid_at: new Date().toISOString() })
          });
          dbUpdated = pr.ok;
        }

        return Response.json({ paid: ok, reference: reference, amount: data.data.amount, db_updated: dbUpdated });
      }

      return env.ASSETS.fetch(request);
    } catch (e) {
      return Response.json({ error: 'Worker crash: ' + (e && e.message ? e.message : String(e)) }, { status: 500 });
    }
  }
};
