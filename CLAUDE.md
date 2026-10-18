# Tuition Manager

Node.js + Express + SQLite (better-sqlite3), EJS server-rendered pages. See README.md for features and layout.

- Dues are calculated in `lib/ledger.js`, never stored. Payments are voided, never deleted.
- The database location comes from `DB_PATH` (full path), else `DATA_DIR/tuition.db`, else `./data/tuition.db`.
- Try it with demo data: `DATA_DIR=./demo-data node scripts/seed-demo.js` (never on real data).

## Deployment

Shared course server. Other students' apps run here too.

| | |
|---|---|
| Server | 187.127.162.81 (Ubuntu 26.04) |
| SSH | `ssh adilpm@187.127.162.81` (key login) |
| App name | `tuition` |
| Port | 3500, on 127.0.0.1 |
| Address | https://adilpm.dhilber.in (HTTPS ends at the instructor's proxy) |
| Repo | https://github.com/adilpm/tution-app-sample.git |
| Code | `~/apps/tuition/` |
| Database | `~/data/tuition/tuition.db` |
| Backups | `~/data/tuition/backups/` (cron at 21:15 UTC, keeps 14 days) |
| Settings | `~/.config/tuition.env` (chmod 600, holds secrets; never commit or copy here) |
| Service | `~/.config/systemd/user/tuition.service` (`systemctl --user`) |

### Update

After pushing changes to GitHub:

```
ssh adilpm@187.127.162.81 "cd ~/apps/tuition && git pull && npm ci && systemctl --user restart tuition"
```

Then check `systemctl --user status tuition --no-pager` and open https://adilpm.dhilber.in.
Logs: `journalctl --user -u tuition -n 50 --no-pager`.

If better-sqlite3 fails to load after `npm ci` (npm "install-scripts" warning):
`npm install-scripts approve better-sqlite3 && npm rebuild better-sqlite3`.

### Server rules

1. No `sudo`, `apt` or `npm install -g`. If something needs root, ask the instructor.
2. Stay inside `/home/adilpm`; never touch anything you didn't create.
3. Listen on 127.0.0.1 only, ports 3500–3599 only (including test runs).
4. Don't touch the web server, firewall or DNS.
5. Secrets only in `~/.config/<app>.env` (chmod 600), never in git or this file.
6. Keep apps running with `systemctl --user` services (no pm2, nohup, screen or `&`).
