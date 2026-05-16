# Production deploy

The app is not a static-only Vite build. `server/index.js` must run in production
because battles are created through Socket.IO and `/api/health`.

## Server process

```bash
cd /var/www/tank.rodion.pro
npm ci
npm run build
sudo cp deploy/tank-arena.service /etc/systemd/system/tank-arena.service
sudo systemctl daemon-reload
sudo systemctl enable --now tank-arena
sudo systemctl status tank-arena
```

If the app directory is not `/var/www/tank.rodion.pro`, update
`WorkingDirectory` and `ExecStart` in the service file. The `www-data` user must
be able to read the project directory. The service binds Node to
`127.0.0.1:3000`; nginx is the public entry point.

## Nginx

```bash
sudo cp deploy/nginx-tank.rodion.pro.conf /etc/nginx/sites-available/tank.rodion.pro
sudo ln -s /etc/nginx/sites-available/tank.rodion.pro /etc/nginx/sites-enabled/tank.rodion.pro
sudo nginx -t
sudo systemctl reload nginx
```

This config serves the Vite build from `/var/www/tank.rodion.pro/dist`, proxies
`/api/` to Node, and proxies `/socket.io/` with explicit WebSocket upgrade
headers. If `/api/health` or `/socket.io/?EIO=4&transport=polling` returns
`index.html`, nginx is still using a static-only SPA fallback instead of this
config.

## Smoke check

```bash
curl -i https://tank.rodion.pro/api/health
curl -i "https://tank.rodion.pro/socket.io/?EIO=4&transport=polling"
SMOKE_URL=https://tank.rodion.pro npm run smoke
```

`/api/health` must return JSON, not `index.html`.
