# Deploying Taberno

A simple, Docker-free deployment: the code lives in git on the server, runs
under **systemd**, and you update it with one command when *you* choose. Nothing
updates automatically.

The golden rule: **code comes from git, data stays on the server.** Everything
that makes a store unique — the database, uploads, uploaded themes, `.env` — is
gitignored, so pulling new code never touches it.

---

## Requirements

- A Linux VPS (Ubuntu/Debian assumed below).
- **Node.js 22 LTS**, installed system-wide (so systemd can find it). The
  [NodeSource](https://github.com/nodesource/distributions) apt packages put it
  at `/usr/bin/node`:
  ```bash
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs git
  ```
- A dedicated user is recommended (`sudo adduser --system --group taberno`).

> ⚠️ Don't copy `node_modules` from your laptop. Taberno uses native modules
> (`better-sqlite3`, `sharp`, `argon2`) that compile per-OS/CPU — a macOS build
> won't run on Linux. Always `npm ci` on the server (the scripts do this).

---

## First deployment

```bash
# as the taberno user, in its home directory
git clone https://github.com/taberno/taberno.git
cd taberno
./scripts/setup.sh
```

`setup.sh` installs dependencies, creates `.env` (with a generated
`SESSION_SECRET`, `NODE_ENV=production`, `HOST=127.0.0.1`), makes the data
directories, and builds. Then install the service:

```bash
sudo cp deploy/taberno.service /etc/systemd/system/taberno.service
sudo nano /etc/systemd/system/taberno.service   # set User, WorkingDirectory, node path
sudo systemctl daemon-reload
sudo systemctl enable --now taberno
systemctl status taberno
curl -s localhost:3000/health         # → {"status":"ok"}
```

Finally, open your domain and visit **`/admin`** to create the first admin
account, then fill in the rest under **Settings** (below).

### What goes where

| Setting | Where |
|---|---|
| `SESSION_SECRET`, `PORT`, `HOST`, `DATABASE_PATH` | `.env` (infrastructure) |
| Stripe / PayPal keys | `.env` **or** Settings → Payments (admin values win) |
| Store URL, store email, SMTP, tax, shipping | Settings (admin UI) — stored in the DB |

`store_url` matters: it builds canonical URLs, the sitemap, and download links
in emails. Set it under Settings → Store.

---

## TLS / reverse proxy

Bind the app to loopback (`HOST=127.0.0.1`, already set) and put a proxy in
front for HTTPS. [Caddy](https://caddyserver.com) is the least fuss —
automatic certificates:

```
# /etc/caddy/Caddyfile
shop.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Then `sudo systemctl reload caddy`. Open only 22/80/443 on the firewall
(`sudo ufw allow 22,80,443/tcp`) so the app port is never exposed directly.

---

## Updating

```bash
cd ~/taberno
./scripts/update.sh
```

Pulls the latest commit, reinstalls deps, rebuilds, and restarts the service.
Database migrations run automatically on startup — no separate step.

Tag your releases so you always know what's live and can go back:

```bash
git tag v1.2.0 && git push --tags     # on your dev machine
git describe --tags                    # on the server: what's deployed
```

## Rolling back

```bash
./scripts/update.sh v1.1.0     # redeploy any tag or commit
```

---

## Backups

Back up two directories — that's the entire store:

- `data/` — the SQLite database (+ WAL files) and digital-product files
- `uploads/` — product and store images

```bash
npm run db:backup                      # WAL-safe database snapshot into backups/
tar czf ~/taberno-backup-$(date +%F).tgz data uploads
```

Copy those off-server on a schedule (cron + `rsync`/`scp`).

---

## Troubleshooting

- **Logs:** `journalctl -u taberno -f`
- **Won't start:** check `.env` has a real `SESSION_SECRET` — the app refuses to
  boot in production with the placeholder value.
- **`node: command not found` in the service:** `ExecStart` points at the wrong
  path. Run `which node` and set the full path (nvm installs are not at
  `/usr/bin/node`).
- **Health check:** `curl -s localhost:3000/health` should return
  `{"status":"ok"}` — it also confirms the database is reachable.
