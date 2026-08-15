// akurekeys worker v8 - paid inspections + admin confirm
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

async function ensureProfile(env, user) {
  const prof = await fetch(env.SUPABASE_URL + '/rest/v1/profiles?id=eq.' + user.id, { headers: adminHeaders(env) });
  const rows = await prof.json();
  if (Array.isArray(rows) && rows.length === 0) {
    await fetch(env.SUPABASE_URL + '/rest/v1/profiles', {
      method: 'POST',
      headers: adminHeaders(env),
      body: JSON.stringify({ id: user.id, full_name: String(user.email).split('@')[0], phone: '+2348000000000', role: 'tenant' })
    });
  }
}

async function initialize(env, email, amountKobo, reference, callbackUrl) {
  const init = await fetch(PAYSTACK + '/transaction/initialize', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.PAYSTACK_SECRET_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, amount: amountKobo, reference: reference, callback_url: callbackUrl })
  });
  return await init.json();
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (url.pathname === '/health') {
        return Response.json({ ok: true });
      }

      // ---------- ADMIN: confirm / reject inspection ----------
      if (url.pathname === '/api/admin/confirm-inspection' && request.method === 'POST') {
        const user = await authUser(env, request);
        if (!user) return Response.json({ error: 'Sign in first.' }, { status: 401 });
        const prof = await fetch(env.SUPABASE_URL + '/rest/v1/profiles?id=eq.' + user.id + '&select=role', { headers: adminHeaders(env) });
        const prows = await prof.json();
        if (!Array.isArray(prows) || !prows.length || prows[0].role !== 'admin') {
          return Response.json({ error: 'Admins only.' }, { status: 403 });
        }
        const { inspection_id, action } = await request.json();
        if (!inspection_id || !action) return Response.json({ error: 'Missing inspection_id or action' }, { status: 400 });
        const newStatus = action === 'confirm' ? 'confirmed' : (action === 'reject' ? 'cancelled' : null);
        if (!newStatus) return Response.json({ error: 'action must be confirm or reject' }, { status: 400 });
        const p = await fetch(env.SUPABASE_URL + '/rest/v1/inspections?id=eq.' + inspection_id, {
          method: 'PATCH', headers: adminHeaders(env),
          body: JSON.stringify({ status: newStatus, updated_at: new Date().toISOString() })
        });
        if (!p.ok) return Response.json({ error: 'Update failed: ' + (await p.text()).slice(0, 200) }, { status: 500 });
        return Response.json({ done: true, status: newStatus });
      }

      // ---------- INSPECTION: book + pay ----------
      if (url.pathname === '/api/inspection/initialize' && request.method === 'POST') {
        const missing = ['SUPABASE_URL','SUPABASE_ANON_KEY','SUPABASE_SERVICE_ROLE_KEY','PAYSTACK_SECRET_KEY'].filter(k => !env[k]);
        if (missing.length) return Response.json({ error: 'Missing env: ' + missing.join(', ') }, { status: 500 });
        const user = await authUser(env, request);
        if (!user) return Response.json({ error: 'Sign in first.' }, { status: 401 });
        const { property_id, preferred_date } = await request.json();
        if (!property_id || !preferred_date) return Response.json({ error: 'Missing property_id or preferred_date' }, { status: 400 });

        await ensureProfile(env, user);

        const pr = await fetch(env.SUPABASE_URL + '/rest/v1/properties?id=eq.' + property_id + '&select=id,property_type,status', { headers: adminHeaders(env) });
        const props = await pr.json();
        if (!Array.isArray(props) || !props.length) return Response.json({ error: 'Property not found' }, { status: 404 });
        const prop = props[0];
        if (prop.status !== 'approved') return Response.json({ error: 'Property not approved' }, { status: 400 });

        const fr = await fetch(env.SUPABASE_URL + '/rest/v1/inspection_fee_schedule?property_type=eq.' + prop.property_type + '&select=fee_naira', { headers: adminHeaders(env) });
        const frows = await fr.json();
        const fee = (Array.isArray(frows) && frows.length) ? Number(frows[0].fee_naira) : 1000;

        const ex = await fetch(env.SUPABASE_URL + '/rest/v1/inspections?tenant_id=eq.' + user.id + '&property_id=eq.' + property_id + '&select=id,status,fee_status,paystack_reference', { headers: adminHeaders(env) });
        const rows = await ex.json();
        if (Array.isArray(rows) && rows.length > 0) {
          const r0 = rows[0];
          if (r0.fee_status === 'paid' && (r0.status === 'requested' || r0.status === 'confirmed')) {
            return Response.json({ already_booked: true });
          }
          if (r0.fee_status === 'pending') {
            const data = await initialize(env, user.email, fee * 100, r0.paystack_reference, url.origin + '/inspect.html');
            if (!data.status) return Response.json({ error: data.message || 'Initialize failed' }, { status: 400 });
            return Response.json({ authorization_url: data.data.authorization_url, reference: r0.paystack_reference });
          }
        }

        const reference = 'AKI_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
        const ins = await fetch(env.SUPABASE_URL + '/rest/v1/inspections', {
          method: 'POST', headers: adminHeaders(env),
          body: JSON.stringify({
            property_id: property_id,
            tenant_id: user.id,
            preferred_date: new Date(preferred_date).toISOString(),
            status: 'requested',
            fee_naira: fee,
            paystack_reference: reference,
            fee_status: 'pending'
          })
        });
        if (!ins.ok) return Response.json({ error: 'DB insert failed: ' + (await ins.text()).slice(0, 200) }, { status: 500 });

        const data = await initialize(env, user.email, fee * 100, reference, url.origin + '/inspect.html');
        if (!data.status) return Response.json({ error: data.message || 'Initialize failed' }, { status: 400 });
        return Response.json({ authorization_url: data.data.authorization_url, reference: reference });
      }

      // ---------- ACCESS FEE ----------
      if (url.pathname === '/api/fee/initialize' && request.method === 'POST') {
        const missing = ['SUPABASE_URL','SUPABASE_ANON_KEY','SUPABASE_SERVICE_ROLE_KEY','PAYSTACK_SECRET_KEY'].filter(k => !env[k]);
        if (missing.length) return Response.json({ error: 'Missing env: ' + missing.join(', ') }, { status: 500 });
        const user = await authUser(env, request);
        if (!user) return Response.json({ error: 'Sign in first.' }, { status: 401 });
        const { property_id } = await request.json();
        if (!property_id) return Response.json({ error: 'Missing property_id' }, { status: 400 });

        await ensureProfile(env, user);

        const ex = await fetch(env.SUPABASE_URL + '/rest/v1/property_access_fees?tenant_id=eq.' + user.id + '&property_id=eq.' + property_id + '&select=id,status,paystack_reference', { headers: adminHeaders(env) });
        const rows = await ex.json();
        if (Array.isArray(rows) && rows.length > 0) {
          if (rows[0].status === 'paid') return Response.json({ already_paid: true });
          const data = await initialize(env, user.email, 1000 * 100, rows[0].paystack_reference, url.origin + '/browse.html');
          if (!data.status) return Response.json({ error: data.message || 'Initialize failed' }, { status: 400 });
          return Response.json({ authorization_url: data.data.authorization_url, reference: rows[0].paystack_reference });
        }

        const reference = 'AKF_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
        const ins = await fetch(env.SUPABASE_URL + '/rest/v1/property_access_fees', {
          method: 'POST', headers: adminHeaders(env),
          body: JSON.stringify({ tenant_id: user.id, property_id: property_id, amount_naira: 1000, paystack_reference: reference })
        });
        if (!ins.ok) return Response.json({ error: 'DB insert failed: ' + (await ins.text()).slice(0, 200) }, { status: 500 });

        const data = await initialize(env, user.email, 1000 * 100, reference, url.origin + '/browse.html');
        if (!data.status) return Response.json({ error: data.message || 'Initialize failed' }, { status: 400 });
        return Response.json({ authorization_url: data.data.authorization_url, reference: reference });
      }

      // ---------- RENT ESCROW ----------
      if (url.pathname === '/api/rent/initialize' && request.method === 'POST') {
        const missing = ['SUPABASE_URL','SUPABASE_ANON_KEY','SUPABASE_SERVICE_ROLE_KEY','PAYSTACK_SECRET_KEY'].filter(k => !env[k]);
        if (missing.length) return Response.json({ error: 'Missing env: ' + missing.join(', ') }, { status: 500 });
        const user = await authUser(env, request);
        if (!user) return Response.json({ error: 'Sign in first.' }, { status: 401 });
        const { property_id } = await request.json();
        if (!property_id) return Response.json({ error: 'Missing property_id' }, { status: 400 });

        const pr = await fetch(env.SUPABASE_URL + '/rest/v1/properties?id=eq.' + property_id + '&select=id,landlord_id,listed_by_agent_id,annual_rent_naira,status', { headers: adminHeaders(env) });
        const props = await pr.json();
        if (!Array.isArray(props) || !props.length) return Response.json({ error: 'Property not found' }, { status: 404 });
        const prop = props[0];
        if (prop.status !== 'approved') return Response.json({ error: 'Property not approved' }, { status: 400 });

        await ensureProfile(env, user);

        const rr = await fetch(env.SUPABASE_URL + '/rest/v1/rentals?tenant_id=eq.' + user.id + '&property_id=eq.' + property_id + '&select=id', { headers: adminHeaders(env) });
        const rentals = await rr.json();
        let rentalId = (Array.isArray(rentals) && rentals.length) ? rentals[0].id : null;

        if (!rentalId) {
          const start = new Date().toISOString().slice(0, 10);
          const end = new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 10);
          const ins = await fetch(env.SUPABASE_URL + '/rest/v1/rentals', {
            method: 'POST',
            headers: Object.assign({}, adminHeaders(env), { Prefer: 'return=representation' }),
            body: JSON.stringify({ property_id: property_id, tenant_id: user.id, landlord_id: prop.landlord_id, agent_id: prop.listed_by_agent_id, annual_rent_naira: prop.annual_rent_naira, lease_start: start, lease_end: end })
          });
          if (!ins.ok) return Response.json({ error: 'Rental create failed: ' + (await ins.text()).slice(0, 200) }, { status: 500 });
          rentalId = (await ins.json())[0].id;
        }

        const er = await fetch(env.SUPABASE_URL + '/rest/v1/escrow_transactions?rental_id=eq.' + rentalId + '&select=id,status,paystack_reference', { headers: adminHeaders(env) });
        const escrows = await er.json();
        let reference;
        if (Array.isArray(escrows) && escrows.length) {
          if (escrows[0].status === 'paid' || escrows[0].status === 'released') return Response.json({ already_paid: true });
          reference = escrows[0].paystack_reference;
        } else {
          reference = 'AKR_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
          const eins = await fetch(env.SUPABASE_URL + '/rest/v1/escrow_transactions', {
            method: 'POST', headers: adminHeaders(env),
            body: JSON.stringify({ rental_id: rentalId, tenant_id: user.id, amount_naira: prop.annual_rent_naira, paystack_reference: reference })
          });
          if (!eins.ok) return Response.json({ error: 'Escrow create failed: ' + (await eins.text()).slice(0, 200) }, { status: 500 });
        }

        const data = await initialize(env, user.email, Number(prop.annual_rent_naira) * 100, reference, url.origin + '/rent.html');
        if (!data.status) return Response.json({ error: data.message || 'Initialize failed' }, { status: 400 });
        return Response.json({ authorization_url: data.data.authorization_url, reference: reference });
      }

      // ---------- VERIFY (smart amount + auto-flip) ----------
      if (url.pathname === '/api/pay/verify' && request.method === 'POST') {
        const missing = ['PAYSTACK_SECRET_KEY','SUPABASE_SERVICE_ROLE_KEY','SUPABASE_URL'].filter(k => !env[k]);
        if (missing.length) return Response.json({ error: 'Missing env: ' + missing.join(', ') }, { status: 500 });
        const user = await authUser(env, request);
        if (!user) return Response.json({ error: 'Sign in first.' }, { status: 401 });
        const { reference } = await request.json();
        if (!reference) return Response.json({ error: 'Missing reference' }, { status: 400 });

        let expectedKobo = 1000 * 100;
        if (reference.startsWith('AKR_')) {
          const er = await fetch(env.SUPABASE_URL + '/rest/v1/escrow_transactions?paystack_reference=eq.' + encodeURIComponent(reference) + '&select=amount_naira', { headers: adminHeaders(env) });
          const erows = await er.json();
          if (Array.isArray(erows) && erows.length) expectedKobo = Number(erows[0].amount_naira) * 100;
        }
        if (reference.startsWith('AKI_')) {
          const ir = await fetch(env.SUPABASE_URL + '/rest/v1/inspections?paystack_reference=eq.' + encodeURIComponent(reference) + '&select=fee_naira', { headers: adminHeaders(env) });
          const irows = await ir.json();
          if (Array.isArray(irows) && irows.length) expectedKobo = Number(irows[0].fee_naira) * 100;
        }

        const v = await fetch(PAYSTACK + '/transaction/verify/' + encodeURIComponent(reference), {
          headers: { Authorization: 'Bearer ' + env.PAYSTACK_SECRET_KEY }
        });
        const data = await v.json();
        if (!data.status) return Response.json({ error: data.message }, { status: 400 });
        const ok = data.data.status === 'success' && data.data.amount === expectedKobo;

        let dbUpdated = false;
        if (ok && reference.startsWith('AKF_')) {
          const p = await fetch(env.SUPABASE_URL + '/rest/v1/property_access_fees?paystack_reference=eq.' + encodeURIComponent(reference), {
            method: 'PATCH', headers: adminHeaders(env),
            body: JSON.stringify({ status: 'paid', paid_at: new Date().toISOString() })
          });
          dbUpdated = p.ok;
        }
        if (ok && reference.startsWith('AKR_')) {
          const p = await fetch(env.SUPABASE_URL + '/rest/v1/rpc/confirm_escrow_paid_by_reference', {
            method: 'POST', headers: adminHeaders(env),
            body: JSON.stringify({ p_reference: reference })
          });
          dbUpdated = p.ok;
        }
        if (ok && reference.startsWith('AKI_')) {
          const p = await fetch(env.SUPABASE_URL + '/rest/v1/inspections?paystack_reference=eq.' + encodeURIComponent(reference), {
            method: 'PATCH', headers: adminHeaders(env),
            body: JSON.stringify({ fee_status: 'paid', paid_at: new Date().toISOString() })
          });
          dbUpdated = p.ok;
        }

        return Response.json({ paid: ok, reference: reference, amount: data.data.amount, db_updated: dbUpdated });
      }

      return env.ASSETS.fetch(request);
    } catch (e) {
      return Response.json({ error: 'Worker crash: ' + (e && e.message ? e.message : String(e)) }, { status: 500 });
    }
  }
};
