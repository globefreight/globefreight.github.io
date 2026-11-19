import { createClient } from 'npm:@supabase/supabase-js@2.89.0';

const secret = Deno.env.get('GF_MAIL_JOB_SECRET');
const apiKey = Deno.env.get('RESEND_API_KEY');
const from = Deno.env.get('GF_MAIL_FROM');
const replyTo = Deno.env.get('GF_SUPPORT_EMAIL');
const siteAddress = Deno.env.get('GF_SITE_URL');
const supabaseUrl = Deno.env.get('SUPABASE_URL');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ||
  JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}').default;

async function validSecret(provided: string, expected: string) {
  const utf8 = new TextEncoder();
  const [actual, wanted] = await Promise.all([
    crypto.subtle.digest('SHA-256', utf8.encode(provided)),
    crypto.subtle.digest('SHA-256', utf8.encode(expected))
  ]);
  const a = new Uint8Array(actual);
  const b = new Uint8Array(wanted);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  if (!secret || !(await validSecret(request.headers.get('x-job-secret') || '', secret))) {
    return new Response(null, { status: 401 });
  }
  if (!apiKey || !from || !replyTo || !siteAddress || !supabaseUrl || !serviceKey) {
    return Response.json({ error: 'Email service configuration is incomplete.' }, { status: 503 });
  }

  try {
    const site = new URL(siteAddress);
    if (site.protocol !== 'https:' || site.username || site.password) {
      return Response.json({ error: 'Configure a public HTTPS site URL.' }, { status: 503 });
    }
    site.hash = '';
    site.search = '';
    const db = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data: jobs, error } = await db.rpc('gf_claim_email');
    if (error) return Response.json({ error: 'Could not claim email jobs.' }, { status: 503 });

    let failedToFinalize = 0;
    for (const job of jobs || []) {
      let sent = false;
      let retry = true;
      const text = [job.body];
      if (job.tracking_code) {
        const tracking = new URL(site);
        tracking.searchParams.set('tracking', job.tracking_code);
        text.push('Track your shipment: ' + tracking.href);
      }
      if (job.case_token) {
        const complaint = new URL(site);
        complaint.hash = 'case=' + job.case_token;
        text.push('Check your complaint status: ' + complaint.href);
      }
      if (job.proof_token) {
        const proof = new URL(site);
        proof.hash = 'delivery=' + job.proof_token;
        text.push('Download proof of delivery: ' + proof.href);
      }
      try {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          signal: AbortSignal.timeout(10000),
          headers: {
            Authorization: 'Bearer ' + apiKey,
            'Content-Type': 'application/json',
            'Idempotency-Key': 'globefreight/' + job.id
          },
          body: JSON.stringify({ from, to: [job.recipient], reply_to: replyTo, subject: job.subject, text: text.join('\n\n') })
        });
        sent = response.ok;
        retry = response.status >= 500 || [408, 425, 429, 409].includes(response.status);
        await response.body?.cancel();
      } catch {
        // A transport timeout can occur after acceptance. Retry with the same key.
      }
      const { error: finishError } = await db.rpc('gf_finish_email', {
        mail_id: job.id, lease: job.claim, sent, retry
      });
      if (finishError) failedToFinalize++;
    }
    return Response.json({ processed: jobs?.length || 0, failedToFinalize }, { status: failedToFinalize ? 503 : 200 });
  } catch {
    return Response.json({ error: 'Email processing is temporarily unavailable.' }, { status: 503 });
  }
});
