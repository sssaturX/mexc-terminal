# VPS Deployment

This setup runs the Node web UI on `127.0.0.1:8787` and exposes it through nginx on a hostname you control.

Replace `your-hostname.example` everywhere below with your own domain. Do not commit personal hostnames, IPs, or TLS certificates.

## DNS

Create an `A` record for:

```text
your-hostname.example -> your VPS public IPv4
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
  --exclude .env \
  --exclude config/settings.json \
  ./ root@YOUR_VPS_IP:/opt/mexc-terminal/
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

Set `WEB_PUBLIC_BASE_URL` to the public HTTPS URL of this host, for example
`https://your-hostname.example`. Notification links use that value.

## systemd

```bash
sudo cp deploy/systemd/mexc-terminal-web.service /etc/systemd/system/mexc-terminal-web.service
sudo systemctl daemon-reload
sudo systemctl enable --now mexc-terminal-web
sudo systemctl status mexc-terminal-web
```

## nginx

Edit `deploy/nginx/mexc-terminal.conf` and set `server_name` to your hostname.

```bash
sudo cp deploy/nginx/mexc-terminal.conf /etc/nginx/sites-available/mexc-terminal
sudo ln -s /etc/nginx/sites-available/mexc-terminal /etc/nginx/sites-enabled/mexc-terminal
sudo nginx -t
sudo systemctl reload nginx
```

The UI should now respond on:

```text
http://your-hostname.example
```

## HTTPS

After DNS points to the VPS and HTTP works:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-hostname.example
```

## Useful Commands

```bash
sudo journalctl -u mexc-terminal-web -f
sudo systemctl restart mexc-terminal-web
sudo nginx -t
```
