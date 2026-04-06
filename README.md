# Potorix

> Open source KVM/libvirt control plane built with Ruby, Sinatra, Sidekiq, PostgreSQL, and Redis.

<p align="center">
  <a href="https://github.com/ozertugrul/potorix">
    <img src="https://img.shields.io/badge/status-active-22c55e?style=for-the-badge" alt="Status: Active" />
  </a>
  <img src="https://img.shields.io/badge/license-MIT-2563eb?style=for-the-badge" alt="MIT License" />
  <img src="https://img.shields.io/badge/platform-KVM%2Flibvirt-7c3aed?style=for-the-badge" alt="KVM/libvirt" />
</p>

<p align="center">
  <img src="https://skillicons.dev/icons?i=ruby,postgres,redis,docker,linux" alt="Ruby, PostgreSQL, Redis, Docker, Linux" />
</p>

Potorix is a Proxmox-inspired virtualization panel for managing tenant-scoped VMs on libvirt/KVM hosts. It provides a real-time web UI, asynchronous VM lifecycle jobs, audit trails, and an embedded browser console (noVNC with ticketed `websockify` sidecar).

## Features

- Tenant-scoped VM management (`create`, `start`, `stop/poweroff`, `destroy`, `purge`)
- Snapshot operations (`create`, `revert`, `delete`)
- VM mobility operations (`clone`, `migrate`)
- ISO workflow (`library`, `attach`, `detach`, `boot order`)
- Backup workflow (`run`, `restore`) with qcow2 export/checksum metadata
- Offline VM tuning (vCPU, memory, disk resize + extra host disk attach)
- VLAN-aware network XML generation for VM interfaces
- Real-time event stream for jobs and audit logs (`/ws`)
- Embedded browser console for running VMs (`/api/v1/vms/:id/console-ticket` + `novnc.html`)
- Queue-driven orchestration with Sidekiq workers

## Architecture

- **API Layer:** Sinatra app (`app/api/application.rb`)
- **Workers:** Sidekiq jobs (`app/jobs/*`)
- **Hypervisor Adapter:** `virsh` integration (`app/services/hypervisor/virsh_adapter.rb`)
- **Persistence:** PostgreSQL via Sequel
- **Queue + Realtime Pub/Sub:** Redis
- **Frontend:** React SPA (source in `frontend/`, build output in `public/`)

## Security Notes

- API access requires `X-API-Key` and `X-Tenant-ID`.
- Supports both static env tokens (`AUTH_TOKENS`) and DB-managed API tokens (`/api/v1/auth/tokens`).
- Keep production keys in `.env` only (never commit `.env`).
- In development, the UI can pre-fill sample tenant/token values and stores current auth inputs in browser `localStorage`.
- For production, use strong keys and override development defaults.
- WebSocket endpoints enforce auth and tenant scope checks.

## Quick Start (Docker)

```bash
cp .env.example .env
# edit AUTH_TOKENS in .env with strong random keys
# optional local dev profile:
# AUTH_TOKENS=admin:<dev-admin-token>,operator:<dev-operator-token>,viewer:<dev-viewer-token>

docker compose build
docker compose up -d

curl http://localhost:9292/health
```

Open:

- `http://localhost:9292/`

## Frontend Development

Frontend source lives in `frontend/` and is bundled by Vite into `public/` (served by Sinatra).

```bash
cd frontend
npm install
npm run build
```

For local UI development:

```bash
cd frontend
npm run dev
```

Production Docker builds automatically run `npm install` and `npm run build` before starting Puma.

## Required Environment

From `.env.example`:

- `APP_ENV`
- `APP_PORT`
- `DATABASE_URL`
- `REDIS_URL`
- `HYPERVISOR_URI`
- `HYPERVISOR_MODE`
- `VM_DISK_DIR`
- `ISO_LIBRARY_DIR`
- `VNC_PROXY_TARGET_HOST`
- `AUTH_TOKENS`

Example `AUTH_TOKENS` format:

```env
AUTH_TOKENS=admin:<strong-admin-key>,operator:<strong-operator-key>,viewer:<strong-viewer-key>
```

Optional environment variables (with defaults):

- `DB_CONNECT_RETRIES` (default: `30`)
- `DB_CONNECT_DELAY` (default: `2`)
- `RAILS_MAX_THREADS` (default: `5`)

## Development UX Notes

- Auth inputs (`Tenant ID`, `API Key`) are persisted in browser `localStorage`.
- Pressing `Enter` in auth inputs triggers refresh and reconnects realtime WebSocket.
- Console fullscreen uses iframe + noVNC responsive scaling.

## API Overview

Core endpoints:

- `GET /api/v1/vms`
- `GET /api/v1/vms/details`
- `POST /api/v1/vms`
- `POST /api/v1/vms/:id/start`
- `POST /api/v1/vms/:id/stop`
- `DELETE /api/v1/vms/:id`
- `POST /api/v1/vms/:id/purge`
- `POST /api/v1/vms/:id/clone`
- `POST /api/v1/vms/:id/migrate`
- `DELETE /api/v1/vms/:id/snapshots/:snapshot_name`
- `POST /api/v1/vms/:id/attach-iso`
- `POST /api/v1/vms/:id/detach-iso`
- `POST /api/v1/vms/:id/boot-order`
- `POST /api/v1/vms/:id/reconfigure`
- `POST /api/v1/vms/:id/disks`
- `GET /api/v1/vms/:id/vnc`
- `POST /api/v1/vms/:id/console-ticket`
- `GET /api/v1/vms/:id/operations`
- `GET /api/v1/vms/:id/usage`
- `GET /api/v1/iso-library`
- `POST /api/v1/iso-library/import`
- `POST /api/v1/iso-library/upload`
- `GET /api/v1/jobs`
- `GET /api/v1/audit-logs`
- `POST /api/v1/backups/run`
- `POST /api/v1/backups/restore`
- `GET /api/v1/backups/runs`
- `POST /api/v1/auth/tokens`
- `GET /api/v1/auth/tokens`
- `DELETE /api/v1/auth/tokens/:id`

Realtime:

- `GET /ws?tenant=<tenant>&token=<api-key>` (WebSocket)
- `GET /ws/vnc?tenant=<tenant>&token=<api-key>&vm_id=<vm-id>` (legacy WebSocket tunnel)

Console fast path (recommended): frontend requests `/api/v1/vms/:id/console-ticket`, then noVNC connects to sidecar on `:6080` with short-lived token.

## Destructive Operations

- `DELETE /api/v1/vms/:id` queues standard VM destroy flow.
- `POST /api/v1/vms/:id/purge` queues irreversible cleanup (domain + disk artifacts + tenant-scoped records).
- Treat **Purge** as non-recoverable.

## Host Requirements (Real KVM Mode)

On the host machine:

- `libvirtd` active
- `/dev/kvm` available
- `/var/run/libvirt/libvirt-sock` accessible
- VM and ISO paths mounted into API/worker containers

The provided `docker-compose.yml` already mounts:

- `/var/run/libvirt`
- `/var/lib/libvirt/images`
- `/var/lib/libvirt/boot`
- `/dev/kvm`

## Development Tips

- API service: `bundle exec puma -b tcp://0.0.0.0:9292 config.ru`
- Worker: `bundle exec sidekiq -r ./config/sidekiq.rb -C sidekiq.yml`
- Health check: `GET /health`

## License

This project is licensed under the MIT License. See [`LICENSE`](./LICENSE).
