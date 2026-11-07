# Moving from SQLite (1.x) to 2.0

[← Back to Index](../CLAUDE.md)

---

## Overview

tududi 2.0 runs on PostgreSQL only. A 1.x install that kept its data in the SQLite file (`/app/db/production.sqlite3` in Docker) does not upgrade in place. You move the data with the JSON backup: export the instance on 1.x, then import it into a fresh 2.0 install on PostgreSQL.

2.0 will not start on top of the old file by accident. If the SQLite file is still on the volume and holds data, startup stops with a message that points here. Nothing is read from it and nothing is deleted.

If your 1.x install already ran on PostgreSQL (`DATABASE_URL` set), none of this applies. Upgrade to the final 1.x release, start it once, then move to 2.0. See [16-postgresql.md](16-postgresql.md).

---

## Before You Start

- Upgrade the 1.x install to the **final 1.x release** first. Its export covers the most data (comments, task relations, daily plans and the rest listed below).
- Sign in as an **admin**. An admin's export holds every account on the instance; a regular user's export holds only their own data.
- Keep the old volume (`tududi_db`) until you have checked the new install. The move does not touch it.
- If people added work to projects or areas that someone else shared with them, read [Links Between Accounts](#links-between-accounts) first. Those links do not come across.

---

## Steps

**1. Export on 1.x.** Open the Backup & Restore page (`/backup`), choose **Create Backup Now**, then **Download** the new backup. The file is a `.json.gz`. It contains every account with its password hash, so keep it as safe as the database.

**2. Keep the uploads folder.** Attachments, avatars and project images are embedded in the backup, but copy `./uploads` anyway as a fallback.

**3. Stop 1.x.**

```bash
docker compose down
```

**4. Set up 2.0 with PostgreSQL.** Take the new `docker-compose.yml` from the 2.0 release. It runs a `postgres:16-alpine` service next to tududi. Add a database password and keep your existing `TUDUDI_*` settings in `.env`:

```bash
DB_PASSWORD=a-long-random-password
TUDUDI_USER_EMAIL=admin@example.com      # use the same admin email as on 1.x
TUDUDI_USER_PASSWORD=your-secure-password
```

Using the same admin email matters: the import maps the exporting admin's own data and contact card onto the account that imports it.

Keep the same `TUDUDI_SESSION_SECRET` (and `TUDUDI_OIDC_SECRET_ENCRYPTION_KEY` if you set one). Calendar feed addresses and webhook secrets stay encrypted in the backup, and only an instance with the same key can read them. With a different key those two are skipped and you add them again.

**5. Deal with the old SQLite volume.** Either remove the `./tududi_db:/app/db` line from the compose file, or leave it mounted and set:

```bash
TUDUDI_ALLOW_DIALECT_SWITCH=true
```

Without one of the two, 2.0 stops at startup because it finds the SQLite file.

**6. Start 2.0.**

```bash
docker compose up -d
docker compose logs -f tududi
```

The database starts empty and tududi creates the schema. Wait for `Server running on port 3002`.

**7. Import.** Sign in as the admin, open Backup & Restore (`/backup`), choose **Import from File**, and select the file from step 1. The import merges the backup into the new instance: accounts, their data and the sharing between them come back.

**8. Check.** Sign in as another user, open a shared project, look at a few tasks with attachments and a recurring task. Have each person who added work to someone else's shared project look for it too: it will be missing from that project (see [Links Between Accounts](#links-between-accounts)). Then take a first database backup (see [backups.md](backups.md)).

When everything looks right, and those items are back where they belong, you can delete the old `tududi_db` folder and drop `TUDUDI_ALLOW_DIALECT_SWITCH` from `.env`.

---

## What Comes Across

- Accounts, with their password hashes, so everyone signs in with the same password
- Roles, user groups and their members, direct shares and group shares
- Areas, goals and projects, including cover images
- Tasks with subtasks, recurrence, completions and task history
- Tags, notes, inbox items, views and people
- Attachments on tasks, notes, projects and inbox items, and avatars
- Comments and reactions
- Task relations
- Daily plans and their items
- Calendar feeds
- Webhooks (their configuration, not past deliveries)
- Custom ordering of tasks, projects, areas and goals

Every row gets a new numeric id; references between rows of the same account are kept through uids.

Rows keep their original created and updated dates, finished projects keep their completion date, and tasks keep their due time. A subtask whose parent was deleted before the backup comes across as a top-level task.

### Links Between Accounts

A link from one account's item to an item another account owns does not come across, even in an admin's export. The item itself does, under the same owner, and the import reports success without a warning:

- A task or note someone added to a project another account owns is no longer in that project. The other people on the project stop seeing it.
- A subtask someone added under another account's task becomes a top-level task, outside the project.
- A project someone created in another account's area is no longer in that area.
- A link to another account's goal, or a task's link to another account's area, is dropped the same way.

Nothing is deleted, but the old install is the last place that shows these links. Before you delete `tududi_db`, have each person find these items among their own and put them back by hand.

## What You Set Up Again

- **API tokens.** Create new ones and update your scripts, MCP clients and integrations.
- **Two-factor sign-in.** Each user enrols their authenticator app again.
- **SSO links.** Users who signed in with an SSO provider link it again on first sign-in.
- **CalDAV sync.** Reconnect clients and remote calendars.
- **Push notifications.** Each device allows notifications again.
- **Sessions.** Everyone signs in again.
- **Calendar feeds and webhooks**, if the new install uses a different `TUDUDI_SESSION_SECRET`.
- **Logs and history**, such as the sign-in audit log, the email log and webhook deliveries, start empty.

---

## Troubleshooting

**Startup stops: a tududi 1.x SQLite database was found.** The SQLite file is still mounted and holds data. Do step 5.

**Startup stops: no database configured.** `DATABASE_URL` is not set. Use the 2.0 `docker-compose.yml`, or set `DATABASE_URL` to your own PostgreSQL server.

**The import says the file is not a valid backup.** The file was not made by tududi, or it is from a newer release than the one you import into.

**Shares or other accounts are missing after import.** The export was taken by a user who is not an admin, so it held only their own data. Take the export again as an admin.

**Someone's tasks or notes are missing from a shared project.** They are still in that person's own account, outside the project. See [Links Between Accounts](#links-between-accounts).

---

## Related Documentation

- [Database (PostgreSQL)](16-postgresql.md)
- [Backups & Restoration](backups.md)
