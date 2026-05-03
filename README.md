# Potorix

<p align="center">
  <strong>Modern, Open-source Virtualization Management Control Plane</strong><br/>
  High-performance KVM/libvirt administration with a real-time dashboard, asynchronous job engine, and integrated browser console.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-active-22c55e?style=for-the-badge" alt="Status: Active" />
  <img src="https://img.shields.io/badge/license-MIT-2563eb?style=for-the-badge" alt="MIT License" />
  <img src="https://img.shields.io/badge/platform-KVM%2Flibvirt-7c3aed?style=for-the-badge" alt="KVM/libvirt" />
  <img src="https://img.shields.io/badge/ruby-3.3-cc342d?style=for-the-badge&logo=ruby" alt="Ruby 3.3" />
</p>

<p align="center">
  <img src="https://skillicons.dev/icons?i=ruby,postgres,redis,docker,linux,react,vite" alt="Tech Stack" />
</p>

---

## Overview

Potorix is a lightweight yet powerful self-hosted virtualization panel designed to provide Proxmox-like VM lifecycle management directly on KVM hosts. It bridges the gap between raw `virsh` commands and complex enterprise suites by providing a structured API, an automated job queue, and a premium React-based user interface.

With a focus on **UI/UX excellence** and **real-time observability**, Potorix enables seamless management of virtual instances, storage, and networking through a single unified pane.

---

## Core Features

### 🚀 Advanced VM Lifecycle
- **Full Lifecycle Control:** Create, start, stop, reboot, and purge VMs with a single click.
- **Optimistic UI:** Instant feedback on operations with background job tracking.
- **Advanced Creation:** Slide-over drawer with support for Disk Bus (SCSI/VirtIO), Network Modes, Cloud-Init, and VLAN tagging.
- **Resource Management:** Offline reconfiguration of vCPU, RAM, and Disk capacity.

### 📊 High-Precision Monitoring
- **Real-time Metrics:** High-precision monitoring of CPU, RAM, Disk IOPS, and Network throughput.
- **Visual Analytics:** Interactive charts for both individual VMs and global Host performance.
- **Live Statistics:** Instant "at-a-glance" status cards for critical system parameters.

### 🖥️ Native Browser Console
- **Embedded VNC:** Integrated noVNC console with automatic scaling (`resize=scale`).
- **Secure Access:** Short-lived token-based authentication for console sessions.
- **Fullscreen Experience:** Native HTML5 Fullscreen API support for an immersive interactive experience.

### 💾 Backup & Snapshots
- **Flexible Snapshots:** Create, list, and revert disk-only snapshots.
- **Automated Backups:** Policy-driven backups with cron scheduling, SHA-256 checksums, and automated retention pruning.
- **Recovery:** Fast restore from any historical backup point.

---

## Architecture

Potorix follows a decoupled architecture designed for stability and performance:

- **Frontend:** Modern React SPA built with Vite and TypeScript, featuring a modular component-based UI.
- **Backend API:** Sinatra-based REST API with a thread-safe design and Puma web server.
- **Worker Engine:** Sidekiq-powered asynchronous job queue for long-running hypervisor operations.
- **Data Layer:** PostgreSQL 16 for persistent state and Redis 7 for caching and real-time event distribution.
- **Hypervisor:** Direct integration with `libvirt` via a specialized Ruby adapter.

---

## Quick Start (Docker)

Deployment is simplified via Docker Compose, which packages the API, Worker, Database, and VNC Proxy.

```bash
# 1. Prepare environment
cp .env.example .env

# 2. Configure AUTH_TOKENS in .env
# Format: AUTH_TOKENS=admin:<key>,operator:<key>,viewer:<key>

# 3. Launch services
docker compose up -d --build
```

Access the dashboard at **http://localhost:9292**.

---

## Security

- **Multi-Tenant Design:** Resource isolation via `X-Tenant-ID` scoping.
- **Role-Based Access Control (RBAC):** Granular permissions (Admin, Operator, Viewer).
- **Hashed Tokens:** API tokens are stored using SHA-256 hashing in the database.
- **Idempotency:** Safety guards on critical operations via `Idempotency-Key` support.

---

## License

Potorix is open-source software licensed under the [MIT License](./LICENSE).
