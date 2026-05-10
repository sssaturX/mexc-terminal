# VPS Deployment

This setup runs the Node web UI on `127.0.0.1:8787` and exposes it through nginx at `mexc.moontap.space`.

## DNS

Create an `A` record for:

```text
mexc.moontap.space -> your VPS public IPv4
```

Add an `AAAA` record too if the VPS has IPv6.

## Server Setup

These commands assume Ubuntu/Debian and an app directory at `/opt/mexc-terminal`.

Install nginx and Node.js 20 or newer. The Node.js package from older Ubuntu
repositories can be too old for this project.

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version

sudo useradd --system --create-home --shell /usr/sbin/nologin mexc
sudo mkdir -p /opt/mexc-terminal
sudo chown -R mexc:mexc /opt/mexc-terminal
```

Copy the project contents to `/opt/mexc-terminal`, including `package.json` and
`package-lock.json`. From your local checkout, run:

```bash
rsync -az --delete \
  --exclude node_modules \
  --exclude dist \
  --exclude .git \
  ./ root@your-vps-ip:/opt/mexc-terminal/
```

If you are already on the server, copy or extract the project into
`/opt/mexc-terminal` and then verify the package files exist:

```bash
sudo ls -la /opt/mexc-terminal/package.json /opt/mexc-terminal/package-lock.json
sudo chown -R mexc:mexc /opt/mexc-terminal
```

Then install and build:

```bash
cd /opt/mexc-terminal
sudo -u mexc npm ci
sudo -u mexc npm run build
sudo -u mexc mkdir -p config logs
```

If you want default credentials from the environment, create `/opt/mexc-terminal/.env`:

```bash
sudo -u mexc cp .env.example .env
sudo -u mexc nano .env
```

## systemd

```bash
sudo cp deploy/systemd/mexc-terminal-web.service /etc/systemd/system/mexc-terminal-web.service
sudo systemctl daemon-reload
sudo systemctl enable --now mexc-terminal-web
sudo systemctl status mexc-terminal-web
```

## nginx

```bash
sudo cp deploy/nginx/mexc.moontap.space.conf /etc/nginx/sites-available/mexc.moontap.space
sudo ln -s /etc/nginx/sites-available/mexc.moontap.space /etc/nginx/sites-enabled/mexc.moontap.space
sudo nginx -t
sudo systemctl reload nginx
```

The UI should now respond on:

```text
http://mexc.moontap.space
```

## HTTPS

After DNS points to the VPS and HTTP works:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d mexc.moontap.space
```

## Useful Commands

```bash
sudo journalctl -u mexc-terminal-web -f
sudo systemctl restart mexc-terminal-web
sudo nginx -t
```
