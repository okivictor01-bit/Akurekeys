// akurekeys worker v11 - payout simulation switch for test mode
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

async function safeJson(r) {
  const t = await r.text();
  try { return JSON.parse(t); } catch (e) { return { status: false, message: 'Non-JSON response: ' + t.slice(0, 150) }; }
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
  const rows = await safeJson(prof);
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
  return await safeJson(init);
}

async function requireAdmin(env, user) {
  const prof = await fetch(env.SUPABASE_URL + '/rest/v1/profiles?id=eq.' + user.id + '&select=role', { headers: adminHeaders(env) });
  const prows = await safeJson(prof);
  return Array.isArray(prows) && prows.length && prows[0].role === 'admin';
}

async function platformUserId(env) {
  const r = await fetch(env.SUPABASE_URL + '/rest/v1/profiles?role=eq.admin&select=id&limit=1', { headers: adminHeaders(env) });
  const rows = await safeJson(r);
  return Array.isArray(rows) && rows.length ? rows[0].id : null;
}

async function executePayout(env, payoutId, platformId) {
  const pr = await fetch(env.SUPABASE_URL + '/rest/v1/payouts?id=eq.' + payoutId + '&select=id,recipient_type,recipient_id,amount_naira,status', { headers: adminHeaders(env) });
  const pays = await safeJson(pr);
  if (!Array.isArray(pays) || !pays.length) return { ok: false, error: 'Payout not found' };
  const payout = pays[0];
  if (payout.status !== 'pending') return { ok: false, error: 'Payout already processed (' + payout.status + ')' };

  // TEST-MODE SIMULATION: complete payout without real transfer
  if (env.SIMULATE_TRANSFERS === 'true') {
    const code = 'SIMULATED_' + payoutId.slice(0, 8);
    const up = await fetch(env.SUPABASE_URL + '/rest/v1/payouts?id=eq.' + payoutId, {
      method: 'PATCH', headers: adminHeaders(env),
      body: JSON.stringify({ status: 'paid', paid_at: new Date().toISOString(), paystack_transfer_code: code })
    });
    if (!up.ok) return { ok: false, error: 'Payout update failed' };
    return { ok: true, transfer_code: code };
  }

  const payeeId = payout.recipient_type === 'platform' ? platformId : payout.recipient_id;
  if (!payeeId) return { ok: false, error: 'Payout has no recipient' };

  const ar = await fetch(env.SUPABASE_URL + '/rest/v1/payout_accounts?user_id=eq.' + payeeId + '&select=account_number,account_name,paystack_recipient_code', { headers: adminHeaders(env) });
  const accts = await safeJson(ar);
  if (!Array.isArray(accts) || !accts.length) return { ok: false, error: 'Recipient has no bank account on file' };
  const acct = accts[0];

  let recipientCode = acct.paystack_recipient_code;
  if (!recipientCode) {
    const rc = await fetch(PAYSTACK + '/transfer/recipient', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.PAYSTACK_SECRET_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'nuban', name: acct.account_name, description: 'AkureKeys payout account', bank_code: '058', account_number: acct.account_number })
    });
    const rct = await rc.text();
    let rcd; try { rcd = JSON.parse(rct); } catch (e) { return { ok: false, error: 'Recipient creation HTTP ' + rc.status + ' body: [' + rct.slice(0, 200) + ']' }; }
    if (!rcd.status) return { ok: false, error: 'Recipient creation failed: ' + (rcd.message || 'unknown') };
    recipientCode = rcd.data.recipient_code;
    await fetch(env.SUPABASE_URL + '/rest/v1/payout_accounts?user_id=eq.' + payeeId, {
      method: 'PATCH', headers: adminHeaders(env),
      body: JSON.stringify({ paystack_recipient_code: recipientCode })
    });
  }

  const tr = await fetch(PAYSTACK + '/transfer', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.PAYSTACK_SECRET_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'balance', recipient: recipientCode, amount: Number(payout.amount_naira) * 100, reason: 'AkureKeys payout — ' + payout.recipient_type })
  });
  const trt = await tr.text();
  let td; try { td = JSON.parse(trt); } catch (e) { return { ok: false, error: 'Transfer HTTP ' + tr.status + ' body: [' + trt.slice(0, 200) + ']' }; }
  if (!td.status) return { ok: false, error: 'Transfer failed: ' + (td.message || 'unknown') };

  const up = await fetch(env.SUPABASE_URL + '/rest/v1/payouts?id=eq.' + payoutId, {
    method: 'PATCH', headers: adminHeaders(env),
    body: JSON.stringify({ status: 'paid', paid_at: new Date().toISOString(), paystack_transfer_code: td.data.transfer_code || td.data.reference })
  });
  if (!up.ok) return { ok: false, error: 'Payout update failed' };
  return { ok: true, transfer_code: td.data.transfer_code || td.data.reference };
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (url.pathname === '/health') {
        return Response.json({ ok: true });
      }

      // ---------- TENANT: release escrow → AUTOMATIC payouts ----------
      if (url.pathname === '/api/rent/release' && request.method === 'POST') {
        const user = await authUser(env, request);
        if (!user) return Response.json({ error: 'Sign in first.' }, { status: 401 });
        const { escrow_id } = await request.json();
        if (!escrow_id) return Response.json({ error: 'Missing escrow_id' }, { status: 400 });

        const er = await fetch(env.SUPABASE_URL + '/rest/v1/escrow_transactions?id=eq.' + escrow_id + '&select=id,tenant_id,status', { headers: adminHeaders(env) });
        const escrows = await safeJson(er);
        if (!Array.isArray(escrows) || !escrows.length) return Response.json({ error: 'Escrow not found' }, { status: 404 });
        const escrow = escrows[0];
        if (escrow.tenant_id !== user.id) return Response.json({ error: 'Only the tenant can release.' }, { status: 403 });
        if (escrow.status !== 'paid') return Response.json({ error: 'Escrow is not paid yet (' + escrow.status + ')' }, { status: 400 });

        const rel = await fetch(env.SUPABASE_URL + '/rest/v1/escrow_transactions?id=eq.' + escrow_id, {
          method: 'PATCH', headers: adminHeaders(env),
          body: JSON.stringify({ status: 'released', released_by: user.id, released_at: new Date().toISOString() })
        });
        if (!rel.ok) return Response.json({ error: 'Release failed: ' + (await rel.text()).slice(0, 200) }, { status: 500 });

        const platformId = await platformUserId(env);
        const lr = await fetch(env.SUPABASE_URL + '/rest/v1/payouts?escrow_transaction_id=eq.' + escrow_id + '&select=id,status', { headers: adminHeaders(env) });
        const payouts = await safeJson(lr);
        const results = [];
        for (const p of (Array.isArray(payouts) ? payouts : [])) {
          const r = await executePayout(env, p.id, platformId);
          results.push({ payout: p.id, ok: r.ok, error: r.error || null, transfer_code: r.transfer_code || null });
        }
        return Response.json({ released: true, payouts: results });
      }

      // ---------- ADMIN: manual pay / retry payout ----------
      if (url.pathname === '/api/admin/pay-payout' && request.method === 'POST') {
        const user = await authUser(env, request);
        if (!user) return Response.json({ error: 'Sign in first.' }, { status: 401 });
        if (!(await requireAdmin(env, user))) return Response.json({ error: 'Admins only.' }, { status: 403 });
        const { payout_id } = await request.json();
        if (!payout_id) return Response.json({ error: 'Missing payout_id' }, { status: 400 });
        const platformId = await platformUserId(env);
        const r = await executePayout(env, payout_id, platformId);
        if (!r.ok) return Response.json({ error: r.error }, { status: 400 });
        return Response.json({ done: true, transfer_code: r.transfer_code });
      }

      // ---------- ADMIN: confirm / reject inspection ----------
      if (url.pathname === '/api/admin/confirm-inspection' && request.method === 'POST') {
        const user = await authUser(env, request);
        if (!user) return Response.json({ error: 'Sign in first.' }, { status: 401 });
        if (!(await requireAdmin(env, user))) return Response.json({ error: 'Admins only.' }, { status: 403 });
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
        const props = await safeJson(pr);
        if (!Array.isArray(props) || !props.length) return Response.json({ error: 'Property not found' }, { status: 404 });
        const prop = props[0];
        if (prop.status !== 'approved') return Response.json({ error: 'Property not approved' }, { status: 400 });

        const fr = await fetch(env.SUPABASE_URL + '/rest/v1/inspection_fee_schedule?property_type=eq.' + prop.property_type + '&select=fee_naira', { headers: adminHeaders(env) });
        const frows = await safeJson(fr);
        const fee = (Array.isArray(frows) && frows.length) ? Number(frows[0].fee_naira) : 1000;

        const ex = await fetch(env.SUPABASE_URL + '/rest/v1/inspections?tenant_id=eq.' + user.id + '&property_id=eq.' + property_id + '&select=id,status,fee_status,paystack_reference', { headers: adminHeaders(env) });
        const rows = await safeJson(ex);
        if (Array.isArray(rows) && rows.length > 0) {
          const r0 = rows[0];
          if (r0.fee_status === 'paid' && (r0.status === 'requested' || r0.status === 'confirmed')) return Response.json({ already_booked: true });
          if (r0.fee_status === 'pending') {
            const data = await initialize(env, user.email, fee * 100, r0.paystack_reference, url.origin + '/inspect.html');
            if (!data.status) return Response.json({ error: data.message || 'Initialize failed' }, { status: 400 });
            return Response.json({ authorization_url: data.data.authorization_url, reference: r0.paystack_reference });
          }
        }

        const reference = 'AKI_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
        const ins = await fetch(env.SUPABASE_URL + '/rest/v1/inspections', {
          method: 'POST', headers: adminHeaders(env),
          body: JSON.stringify({ property_id: property_id, tenant_id: user.id, preferred_date: new Date(preferred_date).toISOString(), status: 'requested', fee_naira: fee, paystack_reference: reference, fee_status: 'pending' })
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
        const rows = await safeJson(ex);
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
        const props = await safeJson(pr);
        if (!Array.isArray(props) || !props.length) return Response.json({ error: 'Property not found' }, { status: 404 });
        const prop = props[0];
        if (prop.status !== 'approved') return Response.json({ error: 'Property not approved' }, { status: 400 });

        await ensureProfile(env, user);

        const rr = await fetch(env.SUPABASE_URL + '/rest/v1/rentals?tenant_id=eq.' + user.id + '&property_id=eq.' + property_id + '&select=id', { headers: adminHeaders(env) });
        const rentals = await safeJson(rr);
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
          rentalId = (await safeJson(ins))[0].id;
        }

        const er = await fetch(env.SUPABASE_URL + '/rest/v1/escrow_transactions?rental_id=eq.' + rentalId + '&select=id,status,paystack_reference', { headers: adminHeaders(env) });
        const escrows = await safeJson(er);
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

      // ---------- VERIFY ----------
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
          const erows = await safeJson(er);
          if (Array.isArray(erows) && erows.length) expectedKobo = Number(erows[0].amount_naira) * 100;
        }
        if (reference.startsWith('AKI_')) {
          const ir = await fetch(env.SUPABASE_URL + '/rest/v1/inspections?paystack_reference=eq.' + encodeURIComponent(reference) + '&select=fee_naira', { headers: adminHeaders(env) });
          const irows = await safeJson(ir);
          if (Array.isArray(irows) && irows.length) expectedKobo = Number(irows[0].fee_naira) * 100;
        }

        const v = await fetch(PAYSTACK + '/transaction/verify/' + encodeURIComponent(reference), {
          headers: { Authorization: 'Bearer ' + env.PAYSTACK_SECRET_KEY }
        });
        const data = await safeJson(v);
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
