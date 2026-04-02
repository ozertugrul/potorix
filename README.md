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

Potorix is a Proxmox-inspired virtualization panel for managing tenant-scoped VMs on libvirt/KVM hosts. It provides a real-time web UI, asynchronous VM lifecycle jobs, audit trails, and an embedded browser console (noVNC over same-origin WebSocket proxy).

## Features

- Tenant-scoped VM management (`create`, `start`, `stop/poweroff`, `destroy`)
- Snapshot operations (`create`, `revert`)
- ISO workflow (`library`, `attach`, `detach`, `boot order`)
- Offline VM tuning (vCPU, memory, disk resize + extra host disk attach)
- Real-time event stream for jobs and audit logs (`/ws`)
- Embedded browser console for running VMs (`/ws/vnc` + `novnc.html`)
- Queue-driven orchestration with Sidekiq workers

## Architecture

- **API Layer:** Sinatra app (`app/api/application.rb`)
- **Workers:** Sidekiq jobs (`app/jobs/*`)
- **Hypervisor Adapter:** `virsh` integration (`app/services/hypervisor/virsh_adapter.rb`)
- **Persistence:** PostgreSQL via Sequel
- **Queue + Realtime Pub/Sub:** Redis
- **Frontend:** Static SPA (`public/index.html`, `public/app.js`, `public/styles.css`)

## Security Notes

- API access requires `X-API-Key` and `X-Tenant-ID`.
- Keep production keys in `.env` only (never commit `.env`).
- Default UI no longer pre-fills API keys.
- WebSocket endpoints enforce auth and tenant scope checks.

## Quick Start (Docker)

```bash
cp .env.example .env
# edit AUTH_TOKENS in .env with strong random keys

docker compose build
docker compose up -d

curl http://localhost:9292/health
```

Open:

- `http://localhost:9292/`

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

## API Overview

Core endpoints:

- `GET /api/v1/vms`
- `GET /api/v1/vms/details`
- `POST /api/v1/vms`
- `POST /api/v1/vms/:id/start`
- `POST /api/v1/vms/:id/stop`
- `DELETE /api/v1/vms/:id`
- `POST /api/v1/vms/:id/attach-iso`
- `POST /api/v1/vms/:id/detach-iso`
- `POST /api/v1/vms/:id/boot-order`
- `POST /api/v1/vms/:id/reconfigure`
- `POST /api/v1/vms/:id/disks`
- `GET /api/v1/vms/:id/vnc`
- `GET /api/v1/jobs`
- `GET /api/v1/audit-logs`

Realtime:

- `GET /ws?tenant=<tenant>&token=<api-key>` (WebSocket)
- `GET /ws/vnc?tenant=<tenant>&token=<api-key>&vm_id=<vm-id>` (WebSocket tunnel)

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
