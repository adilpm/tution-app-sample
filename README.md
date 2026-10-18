# Tuition Manager

Fee collection and attendance tracking for a tuition center (8th–10th, divisions A–D).
Node.js + Express + SQLite, server-rendered pages, mobile-first.

## Features

- **Collect fee**: from any screen, search a student, the amount is pre-filled with what they owe, pick Cash or UPI, then save. You get a PDF receipt right away.
- **Student profile**: pending amount, a paid/unpaid view of each month, every receipt (PDF download), attendance summary, and a WhatsApp reminder button.
- **Dashboard**: collected this month, % of this month's fees paid, total pending, overdue students (2+ months), collections by section, a 6-month trend, and today's attendance.
- **Attendance**: pick a section, everyone starts as present, tap the absentees, save. Monthly report per section.
- **Payments report**: quick filters (Today, Yesterday, Last 7 days, Last 30 days, This month, Last month, custom dates), Cash/UPI totals, and export to PDF, Excel (.xlsx) or CSV. Receipts are voided, never deleted.
- **Settings**: center details printed on receipts, monthly fee per class with history, months with no fee.
- **Users**: admin (everything) and teacher (attendance only).
- **Year-end promotion**: 8th → 9th → 10th, and 10th is marked passed out. History is kept.

## How fees work

- The fee is set **per class** (default ₹2500). A fee change applies from a chosen month, and earlier months keep the old fee.
- A student is billed for every month from their **first billed month**. Joining on or before the 15th bills that month; joining later starts billing the next month.
- Pending is **calculated** (fees owed minus payments), never stored, so it can't drift out of sync.
- A payment is applied to the **oldest unpaid month first**. Anything beyond the dues counts as advance for future months.
- Marking a student as **Left** stops billing after the "last billed month". Their old dues stay visible.

## Run locally

```bash
npm install
npm start               # http://127.0.0.1:3000
```

On the first start, an `admin` user is created and its password is printed in the console. To set a password yourself:

```bash
node scripts/user.js admin "your-new-password" admin
```

To try it with demo data, use a separate data folder so you never mix it with real data:

```bash
DATA_DIR=./demo-data node scripts/seed-demo.js
DATA_DIR=./demo-data npm start
```

To open it from your phone on the same Wi-Fi, run it with `HOST=0.0.0.0`.

## Deploy on Ubuntu VPS

```bash
# 1. Node 20+ and tools
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs nginx sqlite3 build-essential python3

# 2. App user and code
sudo useradd --system --create-home --home-dir /opt/tuition tuition
sudo -u tuition git clone <your-repo-url> /opt/tuition   # or scp/rsync the folder
cd /opt/tuition && sudo -u tuition npm ci --omit=dev
sudo -u tuition mkdir -p data backups

# 3. Service
sudo cp deploy/tuition.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now tuition
sudo journalctl -u tuition | grep -A4 "First run"      # admin password

# 4. Nginx + HTTPS (point your domain's A record to the VPS first)
sudo cp deploy/nginx.conf /etc/nginx/sites-available/tuition   # edit server_name
sudo ln -s /etc/nginx/sites-available/tuition /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx && sudo certbot --nginx -d fees.example.com

# 5. Nightly backups
sudo chmod +x deploy/backup.sh
sudo crontab -u tuition -e     # add: 30 2 * * * /opt/tuition/deploy/backup.sh

# 6. Firewall
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable
```

The service file sets `COOKIE_SECURE=1`, so **logins only work over HTTPS**. If you're testing on the plain IP without a domain, remove that line until HTTPS is set up.

**Updating:** `cd /opt/tuition && sudo -u tuition git pull && sudo -u tuition npm ci --omit=dev && sudo systemctl restart tuition`

**Backups:** your fee records are your money trail. Copy `/opt/tuition/backups` off the server (e.g. rclone to Google Drive), or use **More → Download backup** regularly. To restore, stop the service and replace `data/tuition.db` with an unzipped backup.

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | HTTP port |
| `HOST` | 127.0.0.1 | Bind address (`0.0.0.0` for LAN testing) |
| `DATA_DIR` | `./data` | Where `tuition.db` lives |
| `TZ` | Asia/Kolkata | Timezone used for "today" |
| `TRUST_PROXY` | – | Set to `1` behind Nginx |
| `COOKIE_SECURE` | – | Set to `1` when served over HTTPS |
| `ADMIN_PASSWORD` | random | Password for the admin created on first run |
| `SESSION_SECRET` | auto | Auto-generated and stored in the DB if not set |

## Project layout

```
server.js            app setup, middleware, routes
db.js                schema + seed (classes 8–10, divisions A–D, ₹2500 fee)
lib/ledger.js        dues calculation and payment allocation
lib/receipt.js       PDF receipt (PDFKit)
routes/              dashboard, students, payments, attendance, admin, auth
views/               EJS templates
public/              CSS + small JS
deploy/              systemd unit, nginx config, backup script
scripts/             user.js (create/reset login), seed-demo.js
```
