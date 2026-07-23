# Deploying P2P Manager to a dedicated server (Traefik)

Step-by-step runbook for IT. Assumes a fresh Ubuntu LTS server (cloud VPS or
on-prem with a public IP) and a domain you control.

## 1. DNS

Create an **A record** for the app hostname pointing at the server's public IP:

```
p2p.yourcompany.com  →  <server IP>
```

Let's Encrypt issuance (step 5) requires this to resolve before first start.

## 2. Server basics

```bash
# as root on the new server
adduser deploy && usermod -aG sudo,docker deploy   # after installing docker below
# SSH: key-only login, no root login — edit /etc/ssh/sshd_config:
#   PasswordAuthentication no
#   PermitRootLogin no
apt update && apt upgrade -y
apt install -y ufw fail2ban
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw enable
# unattended security updates
apt install -y unattended-upgrades && dpkg-reconfigure -plow unattended-upgrades
```

Install Docker Engine + Compose plugin: https://docs.docker.com/engine/install/ubuntu/

## 3. Install the app

```bash
sudo mkdir -p /opt/p2p-app && sudo chown deploy /opt/p2p-app
# copy the p2p-app folder (rsync/git/scp) EXCLUDING node_modules and data:
rsync -av --exclude node_modules --exclude data p2p-app/ deploy@SERVER:/opt/p2p-app/

# the data dir must be writable by the container's node user (uid 1000)
mkdir -p /opt/p2p-app/data
sudo chown -R 1000:1000 /opt/p2p-app/data
```

## 4. Configure

```bash
cd /opt/p2p-app/deploy
cp .env.example .env
openssl rand -hex 32        # → paste as JWT_SECRET in .env
openssl rand -hex 16        # → paste as POSTGRES_PASSWORD in .env
nano .env                   # set DOMAIN, ACME_EMAIL, JWT_SECRET, POSTGRES_PASSWORD
```

PostgreSQL runs as a bundled container (`postgres` service) with its data in the
`pgdata` Docker volume — nothing to install on the host.

**Email notifications:** set the `SMTP_*` variables in `.env` (see
`.env.example`) to point at your company mail server, and `APP_URL` to the
public URL so email links work. Without SMTP the app still runs — notifications
are recorded in the outbox visible under Settings.

**Strongly recommended:** set `STAFF_ALLOWED_IPS` to your office/VPN CIDRs and
uncomment the two `staff-allowlist` label lines in `docker-compose.yml`. Vendors
still reach `/vendor` from anywhere; the staff app becomes invisible to the
rest of the internet.

**Already running Traefik on this host?** Delete the `traefik` service from
`docker-compose.yml`, change the `p2p` network to your existing Traefik network
(`external: true`), and adjust the `certresolver` name to match your setup. The
app labels stay the same.

## 5. Start

```bash
cd /opt/p2p-app/deploy
docker compose up -d --build
docker compose logs -f app     # wait for "P2P app running"
```

Visit `https://p2p.yourcompany.com` — certificate is issued automatically on
first request (allow ~30 s).

## 6. First run

Because the container runs with `NODE_ENV=production`, the first start creates a
**clean database — no demo data**: tax masters (TDS sections, RCM categories)
plus a single `admin` account with a **random password printed once in the app
log**. Retrieve it with:

```bash
docker compose logs app | grep "Initial admin login"
```

Then, signed in as admin:

1. **Change the password** (sidebar → Change password).
2. **Enable two-factor auth** (sidebar → Two-factor auth): scan the QR with
   Google/Microsoft Authenticator or Authy. Require this for every admin and
   finance account. Lost phone → an admin resets 2FA from Users → Edit.
3. **Tax Settings**: add your real company GST registrations (needed before any
   PO can be raised) and upload the company logo.
4. **Users page**: create real staff accounts with roles.
5. Vendors self-register at `https://p2p.yourcompany.com/vendor` and appear in
   the Vendors verification queue.

Need demo data on a staging server? Set `SEED_DEMO=1` in the app environment
before first start. To wipe and reinitialise:
`docker compose stop app && docker compose run --rm app node src/seed.js --production && docker compose start app`

## 7. Backups

```bash
chmod +x /opt/p2p-app/deploy/backup.sh
crontab -e     # add:
# 0 2 * * * /opt/p2p-app/deploy/backup.sh >> /var/log/p2p-backup.log 2>&1
```

- Takes a consistent `pg_dump` of the database while the app runs, archives it
  together with uploads / KYC documents / branding, keeps 30 days locally.
- **Configure the offsite copy** (rclone or S3 lines at the bottom of
  `backup.sh`). A backup that lives only on the server is not a backup.
- **Test a restore once:** `gunzip -c p2p-<stamp>.sql.gz | docker compose exec -T
  postgres psql -U p2p p2p`, untar the file directories into `data/`, restart.

## 8. What's stored where

| Data | Location on server |
|---|---|
| Database (users, vendors, PO/GRN/invoices/payments, journals, audit log) | Docker volume `pgdata` (PostgreSQL) |
| Vendor invoice attachments | `/opt/p2p-app/data/uploads/` |
| Vendor KYC documents | `/opt/p2p-app/data/vendor-docs/` |
| DB dumps (from backup script) | `/opt/p2p-app/data/backups/` (pg_dump, gzipped) |
| Backup archives for offsite shipping | `/opt/p2p-app/backups/` |
| TLS certificates | Docker volume `traefik-letsencrypt` |

Passwords are bcrypt-hashed; sessions are 8-hour JWTs signed with `JWT_SECRET`.
Bank/GSTIN data is in the database in plain form — protect the server and the
backups (encrypted bucket, restricted access) accordingly.

## 9. Updates & operations

```bash
cd /opt/p2p-app/deploy
docker compose logs -f app            # application logs
docker compose up -d --build          # redeploy after code changes
docker compose restart app            # restart
```

The app applies its own database migrations on startup, so redeploys are safe.

## Troubleshooting

**404 / app keeps restarting, log shows `EACCES: permission denied, mkdir '/app/data/uploads'`**
Docker created the bind-mounted `data/` folder as **root**, but the container
runs as the unprivileged `node` user (uid 1000), so it cannot write there.
Fix it on the host and restart:
```bash
sudo chown -R 1000:1000 <path-to-app>/data
docker compose up -d
```
(The app now detects this at startup and prints these exact instructions
instead of a raw stack trace.)

**Login page loads unstyled (plain text) and goes blank after sign-in — served over plain HTTP without TLS**
In production the app tells the browser to upgrade every asset request to
`https://` (safe behind Traefik's TLS). If you run it over plain HTTP —
Traefik removed and the port published directly, or a proxy that doesn't
terminate TLS — `/css` and `/js` get upgraded to a URL the server can't
answer, so the page loads with no styling and a dead SPA. Set
`INSECURE_HTTP=1` in `.env` (or the app service's environment) and restart:
```bash
docker compose up -d
```
Better still, put a TLS reverse proxy in front (Traefik/Caddy/nginx) and
leave `INSECURE_HTTP` unset.

**502 / 504 from an existing shared Traefik**
When the app container is attached to more than one Docker network, Traefik
may try to reach it on the wrong one. Pin it by adding this label to the
`app` service and re-running `docker compose up -d`:
```yaml
      - traefik.docker.network=<your-shared-traefik-network>
```

## Security checklist

- [ ] DNS + HTTPS working, HTTP redirects to HTTPS
- [ ] `JWT_SECRET` set (app refuses to start in production without it)
- [ ] Staff app behind `STAFF_ALLOWED_IPS` allowlist or VPN
- [ ] Initial admin password changed (production first boot has no demo accounts)
- [ ] 2FA enabled for all admin and finance accounts
- [ ] Company GST registrations entered in Tax Settings
- [ ] Firewall: only 22/80/443 open; SSH key-only
- [ ] Nightly backup cron installed **and offsite copy configured**
- [ ] Restore tested once
- [ ] fail2ban + unattended-upgrades enabled

Built-in app protections: TOTP two-factor authentication for staff (optional per
user, admin-resettable), login rate limiting (10/15 min per IP), registration
rate limiting (5/hour per IP), password policy (8+ chars, letters + numbers),
security headers (helmet + CSP), upload validation (extension + file signature,
5 MB cap), role-based authorization, and vendor/staff token separation.
