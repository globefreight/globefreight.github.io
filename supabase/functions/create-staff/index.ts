import { createClient } from 'npm:@supabase/supabase-js@2.89.0';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store'
};

function reply(status: number, message: string) {
  return Response.json({ message }, { status, headers: cors });
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return reply(405, 'Use POST to create a staff account.');

  const token = request.headers.get('Authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (!token) return reply(401, 'Sign in as an administrator.');

  const url = Deno.env.get('SUPABASE_URL');
  const publicKey = Deno.env.get('SUPABASE_ANON_KEY') ||
    JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}').default;
  const adminKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ||
    JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}').default;
  if (!url || !publicKey || !adminKey) return reply(503, 'Staff account creation is not configured.');

  const auth = { autoRefreshToken: false, persistSession: false };
  try {
    const caller = createClient(url, publicKey, {
      auth,
      global: { headers: { Authorization: 'Bearer ' + token } }
    });
    const { data: identity, error: identityError } = await caller.auth.getUser(token);
    if (identityError || !identity.user) return reply(401, 'Sign in again as an administrator.');

    const { data: rights, error: rightsError } = await caller.rpc('pf_rights', {});
    if (rightsError) return reply(503, 'Could not check administrator permissions.');
    if (rights?.admin !== true) return reply(403, 'Administrator access is required.');

    const body = await request.json().catch(() => null);
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = body?.password;
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return reply(400, 'Enter a valid staff email address.');
    }
    if (typeof password !== 'string' || password.length < 12 || new TextEncoder().encode(password).length > 72) {
      return reply(400, 'Enter a password with at least 12 characters and at most 72 UTF-8 bytes.');
    }

    const admin = createClient(url, adminKey, { auth });
    const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error?.code === 'email_exists' || error?.code === 'user_already_exists') {
      return reply(409, 'An account with this email already exists. You can assign it to a shipment from Staff access.');
    }
    if (error?.code === 'weak_password') return reply(400, 'Choose a stronger password.');
    if (error) return reply(502, 'Supabase could not create the staff account.');
    return reply(201, 'Staff account created.');
  } catch {
    return reply(502, 'Staff account creation is temporarily unavailable.');
  }
});
