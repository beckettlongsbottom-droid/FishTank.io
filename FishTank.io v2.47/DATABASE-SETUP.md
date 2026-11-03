# Saving player accounts and stats in a real database (Render + free Postgres)

Right now accounts, stats, cosmetics and login sessions live in `data/accounts.json` and `data/sessions.json`.
Render's normal disk is wiped on every deploy/restart, so a real database keeps them forever.
The game already supports it: **if the `DATABASE_URL` environment variable is set, it saves to Postgres; if not, it keeps using the JSON files.** No other code changes.

## 1. Make a free Postgres database (Neon, no card, doesn't expire)
1. Go to https://neon.tech and sign up (GitHub or Google works).
2. Create a project (name it `fishtank`, any region near your Render region).
3. On the project dashboard click **Connect**, pick **Connection string**, and copy it. It looks like
   `postgresql://user:password@ep-something.neon.tech/neondb?sslmode=require`
   (Supabase works the same way: Project Settings -> Database -> Connection string -> URI.)

## 2. Give the string to Render
1. Render dashboard -> your `fishtank-io` web service -> **Environment**.
2. **Add Environment Variable**: key `DATABASE_URL`, value = the string you copied. Save (Render redeploys).
3. Push the v2.44+ code to GitHub as usual (package.json now lists the `pg` library; Render installs it).

## 3. Check it worked
Render -> **Logs**. You should see:
`[fishtank] database connected: N accounts, M logins` then `Fishtank.io running on port ... (database on)`.
If you see `DATABASE ERROR (continuing with local files)` the string is wrong; the game still runs on the JSON files.

First start with an empty database copies your existing `accounts.json` accounts into it automatically (if that file is still on the server). After that Postgres is the source of truth.

## 4. See and query your data
In Neon: **SQL Editor** (or `psql "<your string>"`). Tables are created automatically:
- `accounts (username, data jsonb, updated)` - one row per player; `data` holds xp, equipped items, stats (`st`), achievements, sand dollars, owned items.
- `sessions (token, username, t)` - the "stay logged in" tokens (60 day expiry).

Handy queries:
```sql
select username, (data->>'xp')::int as xp from accounts order by xp desc limit 10;       -- top players
select username, data->'st' as stats from accounts where username = 'buddyboy32';          -- one player's stats
select count(*) from accounts;                                                              -- total players
```

## 5. Backups and safety
- Neon keeps point-in-time history on the free plan (short window); for more, run `pg_dump "<your string>" > backup.sql` now and then.
- Never commit the connection string to GitHub; keep it only in Render's Environment settings.
- The game saves changed accounts every 5 seconds, so a crash can lose at most the last few seconds.
