import { createClient } from 'npm:@supabase/supabase-js@2.89.0';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store'
};

function respond(status: number, data: unknown) {
  return Response.json(data, { status, headers: cors });
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return respond(405, { message: 'Use POST to look up addresses.' });
  const token = request.headers.get('Authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (!token) return respond(401, { message: 'Sign in to look up addresses.' });

  try {
    const url = Deno.env.get('SUPABASE_URL');
    const key = Deno.env.get('SUPABASE_ANON_KEY') ||
      JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}').default;
    const providerKey = Deno.env.get('GEOAPIFY_API_KEY');
    if (!url || !key || !providerKey) return respond(503, { message: 'Address suggestions have not been configured.' });
    const input = await request.json().catch(() => null);
    const country = typeof input?.country === 'string' ? input.country.toLowerCase() : '';
    const query = typeof input?.query === 'string' ? input.query.trim() : '';
    const region = typeof input?.region === 'string' ? input.region.trim().slice(0, 100) : '';
    const shipment = input?.shipment ?? null;
    if (!/^[a-z]{2}$/.test(country) || query.length < 4 || query.length > 200 ||
      (shipment !== null && (typeof shipment !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(shipment)))) {
      return respond(400, { message: 'Choose a country and enter at least four address characters.' });
    }

    const caller = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: 'Bearer ' + token } }
    });
    const { data: identity, error: identityError } = await caller.auth.getUser(token);
    if (identityError || !identity.user) return respond(401, { message: 'Sign in again to look up addresses.' });
    const { data: rights, error: policyError } = await caller.rpc('pf_rights', { shipment });
    if (policyError) return respond(503, { message: 'Could not check shipment permissions.' });
    if (rights?.suspended === true || !(rights?.admin === true || (shipment && rights?.edit === true))) {
      return respond(403, { message: 'You do not have permission to edit this shipment.' });
    }

    const addressUrl = new URL('https://api.geoapify.com/v1/geocode/autocomplete');
    addressUrl.search = new URLSearchParams({
      text: region ? query + ', ' + region : query,
      filter: 'countrycode:' + country,
      format: 'json',
      limit: '6',
      apiKey: providerKey
    }).toString();
    const result = await fetch(addressUrl, { signal: AbortSignal.timeout(7000) });
    if (!result.ok) return respond(503, { message: 'Address suggestions are temporarily unavailable.' });
    const data = await result.json();
    const suggestions = (Array.isArray(data.results) ? data.results : [])
      .filter((entry: Record<string, unknown>) => entry.country_code === country && entry.street && entry.formatted)
      .map((entry: Record<string, unknown>) => ({
        label: String(entry.formatted).slice(0, 300),
        street: String(entry.address_line1 || [entry.housenumber, entry.street].filter(Boolean).join(' ')).slice(0, 200),
        city: String(entry.city || entry.town || entry.village || entry.municipality || '').slice(0, 100),
        region: String(entry.state || entry.county || '').slice(0, 100),
        regionCode: String(entry.state_code || '').slice(0, 20),
        postalCode: String(entry.postcode || '').slice(0, 24)
      }));
    return respond(200, { suggestions });
  } catch {
    return respond(503, { message: 'Address suggestions are temporarily unavailable.' });
  }
});
