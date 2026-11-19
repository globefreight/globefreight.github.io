# PrimeFreight Express

A shipment-tracking website with a public timeline, separate staff and administrator sign-in modes, and a Supabase-backed team portal. The website uses your Supabase project URL and publishable key. It has no build step.

## Set up Supabase

1. Open your project's SQL Editor and run the entire migration in [supabase/migrations](supabase/migrations/20261119000000_primefreight.sql) once. It creates the shipment and event tables, permission policies, and tracking functions in one transaction.
2. In **Authentication → Users**, add and confirm the administrator's email/password account. Copy its User UID, replace the example in the following statement, and run it in SQL Editor.

   ```sql
   insert into primefreight_private.admins (user_id)
   values ('00000000-0000-0000-0000-000000000000')
   on conflict do nothing;
   ```

3. Use **Authentication → Users** to add and confirm staff email/password accounts. In the website, open **Team portal → Admin login**, create a shipment, and assign staff by email. Each assignment allows viewing that shipment. Check the options for editing its details or posting tracking events as needed. To change or remove a grant, open the shipment's **Staff access** section.
4. To disable a staff account across all shipments, use Supabase Auth account controls and remove its shipment grants. For a permanent offboarding, deleting the Auth user removes all corresponding grants automatically. The migration keeps shipment events if their author account is removed.
5. Use city or facility names in public location fields and keep customer names, addresses, and contact details out of public fields. A tracking link shares the route, ETA, and published timeline with anyone holding the link. Internal references appear only in the authorized workspace. Keep the private schema out of the Data API exposed schema list. Restrict public Auth signups if your project is dedicated to this team.

## Deploy to GitHub Pages

1. Put the contents of this folder, including the hidden `.github` subfolder, at the root of your GitHub repository and push to `main`.
2. In the repository, go to **Settings → Pages** and select **GitHub Actions** as the source.
3. Run **Deploy PrimeFreight Express** from the **Actions** tab if the initial push did not deploy. The workflow publishes only the `site/` directory and displays the resulting URL. The migration is applied separately in Supabase.

To preview locally, run `python -m http.server 8000 --directory site` from this folder and visit `http://localhost:8000`. Use **Try a sample shipment** for a demonstration without a database. The sample is labeled and separate from customer records.

## Verify the live setup

- Create a shipment as administrator and open its public link in a private window. Confirm that the initial **Label created** event appears.
- Sign in with a staff account before assigning a shipment, then grant view-only access and refresh its list. Confirm the selected shipment appears without editing or posting controls.
- Enable each permission independently. Edit details and post an update using the staff account. Public tracking checks for updates every 30 seconds while the page is visible. Each tracking event is kept in the timeline.
- Revoke the assignment, then refresh the staff workspace and verify the shipment is gone. Supabase checks current permissions on subsequent reads and writes, including requests made from a previously opened tab.

The team portal keeps its session in browser memory. Reloading the page or reaching the session expiry requires signing in again.

Hero photograph by [Bent Van Aeken on Unsplash](https://unsplash.com/photos/an-aerial-view-of-a-cargo-ship-in-the-ocean-0A7YwYhZhWw).
