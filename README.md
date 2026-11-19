# GlobeFreight Express

A shipment-tracking website with a public timeline, separate staff and administrator sign-in modes, and a Supabase-backed team portal. The website uses your Supabase project URL and publishable key. It has no build step.

## Set up Supabase

1. Open your project's SQL Editor and run the entire migration in [supabase/migrations](supabase/migrations/20261119000000_primefreight.sql) once. It creates the shipment and event tables, permission policies, and tracking functions in one transaction.
2. In **Authentication → Users**, add and confirm the administrator's email/password account. Copy its User UID, replace the example in the following statement, and run it in SQL Editor.

   ```sql
   insert into primefreight_private.admins (user_id)
   values ('00000000-0000-0000-0000-000000000000')
   on conflict do nothing;
   ```

3. Deploy the staff account function below. In the website, open **Team portal → Admin login → Create staff login** to add an email/password account. Provide the initial password to the intended staff member privately. Create a shipment and assign staff by email. Each assignment allows viewing that shipment. Check the options for editing its details or posting tracking events as needed. To change or remove a grant, open the shipment's **Staff access** section.
4. To disable a staff account across all shipments, use Supabase Auth account controls and remove its shipment grants. For a permanent offboarding, deleting the Auth user removes all corresponding grants automatically. The migration keeps shipment events if their author account is removed.
5. Use city or facility names in public location fields and keep customer names, addresses, and contact details out of public fields. A tracking link shares the route, ETA, and published timeline with anyone holding the link. Internal references appear only in the authorized workspace. Keep the private schema out of the Data API exposed schema list. Restrict public Auth signups if your project is dedicated to this team.

## Enable the customer complaints inbox

1. In Supabase SQL Editor, run [the complaints migration](supabase/migrations/20261119000100_globefreight_complaints.sql) after the original shipment migration. If shipments are already configured, apply only the new complaints migration.
2. From the homepage, open **Contact** and submit a test complaint. The page displays a reference and the case appears in **Team portal → Complaints inbox**.
3. As administrator, open the case to set its status or add an internal note. Assign it to a confirmed staff email, or leave the staff email blank to bring it back to the admin queue. Staff see only their assigned cases.
4. Replace the three placeholder U.S. locations in `site/index.html` with your verified business addresses and hours before inviting customers to visit.

Customer complaints are stored in Supabase for the signed-in team. Submission creates an inbox entry and a reference on screen.

## Enable quotes, shipment emails, delivery documents, and the activity log

1. Run [the operations migration](supabase/migrations/20261119000200_globefreight_operations.sql) in SQL Editor after the shipment and complaint migrations. Run each new migration once.
2. Edit [business-details.js](site/assets/business-details.js) with the verified business email, phone, support hours, and actual addresses, hours, and service lists. Blank contact fields are hidden. Placeholder city cards remain labeled until addresses are provided.
3. Submit a test quote from the homepage. Review it in **Team portal → Quote requests** and update its status. The **Admin activity log** records new activity after the migration.
4. In a shipment's **Shipment email notifications** panel, save the confirmed recipient email to queue the tracking link and future milestone emails. After recording **Delivered**, administrators and staff with tracking-update permission can attach a PDF, PNG, or JPEG up to 2 MB. The recipient's email link expires seven days after upload. Anyone with that link can download the document until it expires, is replaced, or the recipient changes. The public tracking timeline contains no document link.
5. Open a case in **Complaints inbox** to email its customer. Replies appear as **Queued**, **Accepted by email provider**, or **Failed**. The configured support mailbox receives customer replies to these emails.

### Configure outbound email

Verify your sending domain in Resend and create a sending key. In Supabase **Edge Functions → Secrets**, set these server-side values:

| Secret | Value |
|---|---|
| `RESEND_API_KEY` | Your Resend sending key |
| `GF_MAIL_FROM` | Sender on your verified domain, e.g. `GlobeFreight Express <updates@your-domain.example>` |
| `GF_SUPPORT_EMAIL` | The monitored mailbox that receives customer replies |
| `GF_SITE_URL` | Your published HTTPS website URL, including any GitHub Pages project path |
| `GF_MAIL_JOB_SECRET` | A randomly generated secret of at least 32 characters used only by your scheduled job |

In **Edge Functions**, deploy [send-globefreight-email](supabase/functions/send-globefreight-email/index.ts) via the dashboard editor. Turn off **Verify JWT with legacy secret** for this function. It authenticates the scheduled job using the `x-job-secret` header and uses a server-side Supabase credential. Keep all email credentials out of GitHub and browser code.

Use Supabase Vault to save the same job secret under the name `gf_mail_job_secret`. In Supabase Cron, enable the Cron and `pg_net` extensions and schedule the following SQL as a job that runs every minute. Use the actual Edge Function URL if deploying to another project.

```sql
select net.http_post(
  url := 'https://wqxbwpilkmwgagqbdxud.supabase.co/functions/v1/send-globefreight-email',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-job-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'gf_mail_job_secret')
  ),
  body := '{}'::jsonb,
  timeout_milliseconds := 70000
);
```

Test with addresses you control before opening the form to customers. The queue records provider acceptance for complaint replies. Monitor delivery and bounce information in Resend. Customer email acknowledgements do not repeat complaint descriptions.

## Enable exception follow-up, complaint status links, CSV import, and labels

1. Run [the team tools migration](supabase/migrations/20261119000300_globefreight_team_tools.sql) after the operations migration. Redeploy the updated [email function](supabase/functions/send-globefreight-email/index.ts) so it includes complaint status links.
2. In **Delivery exception queue**, review reported exceptions, shipments past ETA, and shipments with no new update for 48 hours. The ETA day is evaluated in UTC. Assign follow-up to a staff member with access to that shipment, or leave it in the admin queue. A later shipment event opens a fresh follow-up if the shipment still meets the queue criteria.
3. New complaint receipts include a private 60-day status link once email is configured. For an existing case, open **Email customer and view recent replies → Email a new status link**. Issuing a new link disables the previous one. The link shows the reference, status, and receipt date.
4. Under **Import shipments from CSV**, download the template, replace the example row, and upload up to 100 shipments. Use one of the listed service names and use YYYY-MM-DD for optional ETAs. Review every row before selecting **Create shipments**. An invalid database row rolls back the batch.
5. Open a shipment on the hosted site and choose **Print shipping label**. The layout is sized for 4 × 6 in and the QR code opens the shipment's public tracking page. Use the browser print dialog to select a label printer or save a PDF.

## Deploy staff account creation in Supabase

In **Edge Functions**, choose **Deploy a new function → Via Editor**. Name it `create-staff` and replace the editor contents with [the included function](supabase/functions/create-staff/index.ts), then deploy it. In the function's **Details** tab, turn off **Verify JWT with legacy secret**. The handler verifies the Supabase Auth session itself and checks the live administrator role before creating an account. It uses Supabase's built-in server-side credentials. No Node.js or PowerShell is needed.

Sign in as administrator and open **Create staff login**. Enter the staff email and an initial password of at least 12 characters. The staff member can sign in immediately via **Staff login**. They receive shipment access only after an administrator assigns them to a shipment. The form does not email credentials.

## Deploy to GitHub Pages

1. Put the contents of this folder, including the hidden `.github` subfolder, at the root of your GitHub repository and push to `main`.
2. In the repository, go to **Settings → Pages** and select **GitHub Actions** as the source.
3. Run **Deploy GlobeFreight Express** from the **Actions** tab if the initial push did not deploy. The workflow publishes only the `site/` directory and displays the resulting URL. The migration is applied separately in Supabase.

To preview locally, run `python -m http.server 8000 --directory site` from this folder and visit `http://localhost:8000`. Public tracking requires an existing shipment in Supabase.

## Verify the live setup

- Create a shipment as administrator and open its public link in a private window. Confirm that the initial **Label created** event appears.
- Sign in with a staff account before assigning a shipment, then grant view-only access and refresh its list. Confirm the selected shipment appears without editing or posting controls.
- Enable each permission independently. Edit details and post an update using the staff account. Public tracking checks for updates every 30 seconds while the page is visible. Each tracking event is kept in the timeline.
- Revoke the assignment, then refresh the staff workspace and verify the shipment is gone. Supabase checks current permissions on subsequent reads and writes, including requests made from a previously opened tab.

The team portal keeps its session in browser memory. Reloading the page or reaching the session expiry requires signing in again.

Hero photograph by [Bent Van Aeken on Unsplash](https://unsplash.com/photos/an-aerial-view-of-a-cargo-ship-in-the-ocean-0A7YwYhZhWw).
