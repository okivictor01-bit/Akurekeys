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

        const v = await fetch(PAYSTACK + '/transaction/verify/' + encodeURIComponent(reference), {
          headers: { Authorization: 'Bearer ' + env.PAYSTACK_SECRET_KEY }
        });
        const data = await v.json();
        if (!data.status) return Response.json({ error: data.message }, { status: 400 });
        const ok = data.data.status === 'success' && data.data.amount === expectedKobo;

        let dbUpdated = false;
        if (ok && reference.startsWith('AKF_')) {
          const p = await fetch(env.SUPABASE_URL + '/rest/v1/property_access_fees?paystack_reference=eq.' + encodeURIComponent(reference), {
            method: 'PATCH',
            headers: adminHeaders(env),
            body: JSON.stringify({ status: 'paid', paid_at: new Date().toISOString() })
          });
          dbUpdated = p.ok;
        }
        if (ok && reference.startsWith('AKR_')) {
          const p = await fetch(env.SUPABASE_URL + '/rest/v1/rpc/confirm_escrow_paid_by_reference', {
            method: 'POST',
            headers: adminHeaders(env),
            body: JSON.stringify({ p_reference: reference })
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
