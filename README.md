# GlobeFreight Express

A shipment-tracking website with a public timeline, separate staff and administrator sign-in modes, and a Supabase-backed team portal. The website uses your Supabase project URL and publishable key. GitHub Actions generates standalone pages from the shared HTML layout. No local build is required to publish.

## Set up Supabase

1. Open your project's SQL Editor and run the entire migration in [supabase/migrations](supabase/migrations/20261119000000_primefreight.sql) once. It creates the shipment and event tables, permission policies, and tracking functions in one transaction.
2. In **Authentication → Users**, add and confirm the administrator's email/password account. Copy its User UID, replace the example in the following statement, and run it in SQL Editor.

   ```sql
   insert into primefreight_private.admins (user_id)
   values ('00000000-0000-0000-0000-000000000000')
   on conflict do nothing;
   ```

3. Deploy the staff account function below. In the website, open **Team Portal → GlobeFreight Team Sign-In → Staff & access → Create staff login** to add an email/password account. Provide the initial password to the intended staff member privately. Create a shipment and assign staff by email. Each assignment allows viewing that shipment. Check the options for editing its details or posting tracking events as needed. To change or remove a grant, open the shipment's **Staff access** section.
4. Apply the staff access migration below to manage account suspension and assignments from the dashboard. A permanent deletion of the Auth user is a separate action in Supabase and is not required to suspend access.
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

## Enable quote booking, pickup scheduling, delivery instructions, and the daily summary

1. Apply [the booking migration](supabase/migrations/20261119000400_globefreight_booking.sql) after the team tools migration. Redeploy the updated [email function](supabase/functions/send-globefreight-email/index.ts). Keep its existing Supabase Cron schedule and secrets.
2. In **Quote requests**, open a quote and select **Send quote and book shipment**. Enter a price, currency, and expiry. The email links to a private approval page. Open or refresh the quote after acceptance and select **Book accepted quote** to create a shipment using the quote's route and service. The booking queues the recipient's tracking and shipment management links.
3. For other shipments, saving a recipient email also queues a private shipment link. For an existing recipient, open **Pickup and delivery instructions → Email a new private shipment link**. New links replace prior links and expire after 30 days.
4. Customers use their link to propose a pickup window and share delivery directions or an alternate contact. Open **Pickup requests** to review incoming requests. Administrators and staff with edit or tracking-update permission can confirm, cancel, or request a new window. Confirmed pickup times appear on tracking. Delivery instructions remain available to the intended recipient through their private link and to staff with access to the shipment.
5. In **Edge Functions → Secrets**, set `GF_DIGEST_EMAIL` to the confirmed Supabase Auth email of an administrator. The existing scheduled email job queues one summary per day after **8:00 a.m. Africa/Lagos**. Override this using `GF_DIGEST_TIMEZONE` (IANA time zone) and `GF_DIGEST_HOUR` (0–23). The summary contains counts of overdue shipments, unresolved complaints, quotes awaiting team action, and pickup requests.

## Enable the Staff & Access dashboard

1. Apply [the staff access migration](supabase/migrations/20261119000500_globefreight_staff_access.sql) after the first five migrations. If the Delivery Exceptions migration was skipped on an existing project, install the missing team-tools schema before applying this migration.
2. Sign in with the Supabase account registered in the administrators table. It should open the **Operations dashboard**. Open **Staff & access** to create an account or select an existing confirmed staff account. Assign shipments by tracking number and complaints by case reference. You can change shipment permissions or remove individual assignments here.
3. **Suspend staff access** blocks that account from the GlobeFreight dashboard, removes shipment permissions, and returns its complaints and delivery exceptions to the admin queue. **Reinstate staff access** allows the user to sign in and receive fresh assignments.
4. **Customer service** gives administrators a shipment lookup and links to complaints and quotes. Use the shipment record to manage recipient email, private shipment links, pickup, and delivery documents. Use **Find a complaint** in the inbox to open an older case by its GF reference.

## Enable country, region, and address entry

1. Run [the shipment addresses migration](supabase/migrations/20261119000600_globefreight_addresses.sql) in Supabase SQL Editor after the earlier migrations. Country and region choices and manual address entry work after installing this migration and publishing the site.
2. To enable address suggestions, set `GEOAPIFY_API_KEY` in **Supabase → Edge Functions → Secrets**. Deploy an Edge Function named `address-autocomplete` using [its index.ts file](supabase/functions/address-autocomplete/index.ts). Turn off **Verify JWT with legacy secret** for this function. The code verifies the signed-in user's current shipment rights before calling Geoapify.
3. In the Team Portal choose **New shipment**. Enter pickup and delivery countries, regions, cities, and street addresses. Suggestions appear after four characters. If no suggestion matches, finish typing the address manually. Apartment and unit details are entered separately.
4. Street addresses and postal codes are visible inside the authorized team portal. Public tracking shows the location summaries only. The Geoapify lookup receives the typed street query and selected country and region when suggestions are requested. Keep the API key server-side.

Country and region data from [country-region-data 4.1.0](https://github.com/country-regions/country-region-data), available under the MIT license.

## Switch shipment tracking numbers to GF

Apply [the GF tracking migration](supabase/migrations/20261119000700_globefreight_tracking_prefix.sql) after the earlier migrations. New shipments receive GF tracking numbers, and existing PF numbers are converted to GF. Previously shared PF tracking links and printed QR codes continue to work through a private alias. The public tracking result displays the current GF number.

## Deploy staff account creation in Supabase

In **Edge Functions**, choose **Deploy a new function → Via Editor**. Name it `create-staff` and replace the editor contents with [the included function](supabase/functions/create-staff/index.ts), then deploy it. In the function's **Details** tab, turn off **Verify JWT with legacy secret**. The handler verifies the Supabase Auth session itself and checks the live administrator role before creating an account. It uses Supabase's built-in server-side credentials. No Node.js or PowerShell is needed.

Sign in as administrator and open **Create staff login**. Enter the staff email and an initial password of at least 12 characters. The staff member can sign in immediately through **GlobeFreight Team Sign-In**. They receive shipment access only after an administrator assigns them to a shipment. The form does not email credentials.

## Deploy to GitHub Pages

1. Put the contents of this folder, including the hidden `.github` subfolder, at the root of your GitHub repository and push to `main`.
2. In the repository, go to **Settings → Pages** and select **GitHub Actions** as the source.
3. Run **Deploy GlobeFreight Express** from the **Actions** tab if the initial push did not deploy. The workflow generates and publishes dedicated page URLs from `site/` and displays the resulting URL. The migration is applied separately in Supabase.

To preview locally, run `python -m http.server 8000 --directory site` from this folder and visit `http://localhost:8000`. Public tracking requires an existing shipment in Supabase. The local source preview uses fragment navigation. The published site serves dedicated URLs for Tracking, Milestones, Tracking Help, About, Design & Print, Quote, Contact, and Team Portal.

## Verify the live setup

- Create a shipment as administrator and open its public link in a private window. Confirm that the initial **Label created** event appears.
- Sign in with a staff account before assigning a shipment, then grant view-only access and refresh its list. Confirm the selected shipment appears without editing or posting controls.
- Enable each permission independently. Edit details and post an update using the staff account. Public tracking checks for updates every 30 seconds while the page is visible. Each tracking event is kept in the timeline.
- Revoke the assignment, then refresh the staff workspace and verify the shipment is gone. Supabase checks current permissions on subsequent reads and writes, including requests made from a previously opened tab.

The team portal keeps its session in browser memory. Reloading the page or reaching the session expiry requires signing in again.

Photography by [Bernd Dittrich](https://unsplash.com/photos/a-forklift-driving-through-a-warehouse-filled-with-pallets-F2C_mSrb6iM), [Bank Phrom](https://unsplash.com/photos/printing-machine-Tzm3Oyu_6sk), and [Bent Van Aeken on Unsplash](https://unsplash.com/photos/an-aerial-view-of-a-cargo-ship-in-the-ocean-0A7YwYhZhWw).
