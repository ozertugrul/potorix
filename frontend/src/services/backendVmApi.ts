import type { MetricsSample, SnapshotItem, VmEntity, VmStatus, VmTask } from '../types/vm';

const DEV_AUTH_DEFAULTS = Object.freeze({ tenant: 'tenant-a', token: 'dev-admin-key' });
const AUTH_STORAGE_KEYS = Object.freeze({ tenant: 'potorix.auth.tenant', token: 'potorix.auth.token' });
const OVERRIDE_KEY = 'potorix.vm-overrides.v1';

type VmOverride = Partial<Pick<VmEntity, 'tags' | 'options' | 'cloudInit' | 'firewallEnabled' | 'firewallRules' | 'permissions' | 'cpuCores' | 'ramMb' | 'cdrom' | 'disks'>>;

interface BackendVmDetail {
  id: string;
  state?: string;
  vcpus?: number;
  memory_mb?: number;
  boot_order?: string[];
  boot_primary?: string;
  iso_path?: string | null;
  network_mode?: string | null;
  network_source?: string | null;
  wizard?: Record<string, unknown>;
  disks?: Array<{ target?: string; source?: string; device?: string }>;
  interfaces?: Array<{ source?: string; model?: string; type?: string }>;
}

interface BackendJob {
  id: string;
  action: string;
  target: string;
  status: string;
  created_at?: string;
  started_at?: string;
  finished_at?: string;
}

interface BackendBackupRun {
  id: number;
  vm_id: string;
  status: string;
  created_at?: string;
  finished_at?: string;
}

interface SystemUsage {
  host: {
    cpu_total: number;
    memory_total_mb: number;
    disk_total_gb: number;
    disk_free_gb: number;
  };
  tenant: {
    vm_total: number;
    vm_running: number;
    alloc_vcpus: number;
    alloc_memory_mb: number;
    alloc_disk_gb: number;
  };
}

interface VmUsageSample {
  cpu_pct: number;
  ram_pct: number;
  disk_io_pct: number;
  net_pct: number;
  running: boolean;
  sampled_at: string;
}

export interface IsoLibraryItem {
  name: string;
  path: string;
  size_bytes: number;
  mtime: string;
}

export interface VmOperationItem {
  id: number;
  vm_id: string;
  action: string;
  status: 'queued' | 'running' | 'success' | 'failed' | string;
  error_message?: string | null;
  payload: Record<string, unknown>;
  sidekiq_jid?: string | null;
  created_at?: string;
  started_at?: string;
  finished_at?: string;
}

const metricHistory: Record<string, MetricsSample[]> = {};

function getAuth() {
  try {
    const tenant = localStorage.getItem(AUTH_STORAGE_KEYS.tenant)?.trim() || DEV_AUTH_DEFAULTS.tenant;
    const token = localStorage.getItem(AUTH_STORAGE_KEYS.token)?.trim() || DEV_AUTH_DEFAULTS.token;
    return { tenant, token };
  } catch {
    return DEV_AUTH_DEFAULTS;
  }
}

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { tenant, token } = getAuth();
  const url = new URL(path, window.location.origin);
  url.searchParams.set('tenant', tenant);
  url.searchParams.set('token', token);

  const response = await fetch(url.toString(), {
    ...init,
    headers: {
      'X-Tenant-ID': tenant,
      'X-API-Key': token,
      ...(init.headers || {})
    }
  });

  const raw = await response.text();
  const parsed = raw ? JSON.parse(raw) : {};
  if (!response.ok) {
    throw new Error(parsed.error || `Request failed (${response.status})`);
  }

  return parsed.data as T;
}

function toStatus(raw: string | undefined): VmStatus {
  const value = String(raw || '').toLowerCase();
  if (value.includes('running')) return 'running';
  if (value.includes('paused')) return 'paused';
  return 'stopped';
}

function toTaskStatus(raw: string): 'success' | 'failed' | 'running' {
  const value = raw.toLowerCase();
  if (value === 'success' || value === 'completed') return 'success';
  if (value === 'failed' || value === 'error') return 'failed';
  return 'running';
}

function loadOverrides(): Record<string, VmOverride> {
  try {
    const raw = localStorage.getItem(OVERRIDE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, VmOverride>;
  } catch {
    return {};
  }
}

function saveOverrides(next: Record<string, VmOverride>) {
  try {
    localStorage.setItem(OVERRIDE_KEY, JSON.stringify(next));
  } catch {
    // ignore storage failures
  }
}

function applyOverride(vm: VmEntity): VmEntity {
  const overrides = loadOverrides();
  const override = overrides[vm.id];
  return override ? { ...vm, ...override } : vm;
}

function toVmEntity(detail: BackendVmDetail, jobs: BackendJob[], backups: BackendBackupRun[], snapshots: SnapshotItem[] = []): VmEntity {
  const vmJobs = jobs.filter((job) => job.target === detail.id).slice(0, 40);
  const vmBackups = backups.filter((run) => run.vm_id === detail.id).slice(0, 20);

  const tasks: VmTask[] = vmJobs.map((job) => ({
    id: String(job.id),
    action: job.action,
    status: toTaskStatus(job.status),
    timestamp: job.created_at || job.started_at || job.finished_at || new Date().toISOString()
  }));

  const bootOrder = Array.isArray(detail.boot_order) ? detail.boot_order.join(',') : (detail.boot_primary || 'hd');
  const disks = Array.isArray(detail.disks)
    ? detail.disks.filter((d) => d.device === 'disk' || d.device === undefined).map((d, index) => ({ id: `${detail.id}-d-${index}`, name: d.target || `disk${index}`, sizeGb: 0 }))
    : [];
  const nics = Array.isArray(detail.interfaces)
    ? detail.interfaces.map((n, index) => ({ id: `${detail.id}-n-${index}`, bridge: n.source || 'default', model: n.model || 'virtio' }))
    : [];

  const base: VmEntity = {
    id: detail.id,
    name: detail.id,
    node: detail.network_source || 'default-node',
    status: toStatus(detail.state),
    uptime: detail.state || '-',
    tags: [],
    cpuCores: detail.vcpus || 1,
    ramMb: detail.memory_mb || 512,
    disks,
    nics,
    cdrom: detail.iso_path || 'none',
    gpu: 'none',
    options: { bootOrder, startAtBoot: false, bios: 'UEFI', protection: false },
    cloudInit: { user: 'cloud-user', sshKeys: '', network: 'dhcp', yaml: '' },
    firewallEnabled: false,
    firewallRules: [],
    permissions: [],
    snapshots,
    backups: vmBackups.map((run) => ({ id: `backup-${run.id}`, name: `backup-${run.id}`, createdAt: run.created_at || new Date().toISOString(), size: '-' })),
    tasks
  };

  const wizard = detail.wizard || {};
  if (wizard && typeof wizard === 'object') {
    base.options.startAtBoot = Boolean(wizard.start_at_boot ?? base.options.startAtBoot);
    base.firewallEnabled = Boolean(wizard.firewall_enabled ?? base.firewallEnabled);
    base.cloudInit.user = String(wizard.cloud_init_user || base.cloudInit.user);
    base.cloudInit.network = (wizard.cloud_init_network === 'static' ? 'static' : 'dhcp');
    base.cloudInit.yaml = [
      wizard.timezone ? `timezone: ${String(wizard.timezone)}` : null,
      wizard.static_ip ? `ip: ${String(wizard.static_ip)}` : null,
      wizard.gateway ? `gateway: ${String(wizard.gateway)}` : null,
      wizard.dns ? `dns: ${String(wizard.dns)}` : null,
      wizard.vlan_id ? `vlan: ${String(wizard.vlan_id)}` : null
    ].filter(Boolean).join('\n');
  }

  return applyOverride(base);
}

function stableHash(input: string) {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) hash = (hash * 31 + input.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

export const backendVmApi = {
  async getSystemUsage() {
    return apiRequest<SystemUsage>('/api/v1/system/usage');
  },

  async getVms() {
    const [ids, details, jobs, backups] = await Promise.all([
      apiRequest<string[]>('/api/v1/vms'),
      apiRequest<BackendVmDetail[]>('/api/v1/vms/details'),
      apiRequest<BackendJob[]>('/api/v1/jobs?limit=80'),
      apiRequest<BackendBackupRun[]>('/api/v1/backups/runs?limit=50')
    ]);

    return ids.map((id) => {
      const detail = details.find((item) => item.id === id) || { id, state: 'unknown' };
      return toVmEntity(detail, jobs, backups);
    });
  },

  async getVm(vmId: string) {
    const [details, jobs, snapshots, backups] = await Promise.all([
      apiRequest<BackendVmDetail[]>('/api/v1/vms/details'),
      apiRequest<BackendJob[]>('/api/v1/jobs?limit=120'),
      apiRequest<string[]>(`/api/v1/vms/${encodeURIComponent(vmId)}/snapshots`),
      apiRequest<BackendBackupRun[]>('/api/v1/backups/runs?limit=80')
    ]);

    const detail = details.find((item) => item.id === vmId);
    if (!detail) throw new Error('VM not found');

    const vmSnapshots = snapshots.map((name) => ({ id: name, name, createdAt: new Date().toISOString() }));
    return toVmEntity(detail, jobs, backups, vmSnapshots);
  },

  async getMetrics(vmId: string): Promise<MetricsSample[]> {
    const [vm, usage] = await Promise.all([this.getVm(vmId), this.getVmUsage(vmId)]);
    const point: MetricsSample = {
      time: new Date(usage.sampled_at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      cpu: vm.status === 'running' ? Math.max(0, Math.min(100, Math.round(usage.cpu_pct))) : 0,
      ram: vm.status === 'running' ? Math.max(0, Math.min(100, Math.round(usage.ram_pct))) : 0,
      diskIo: vm.status === 'running' ? Math.max(0, Math.min(100, Math.round(usage.disk_io_pct))) : 0,
      net: vm.status === 'running' ? Math.max(0, Math.min(100, Math.round(usage.net_pct))) : 0
    };

    const history = metricHistory[vmId] || [];
    const next = [...history, point].slice(-20);
    metricHistory[vmId] = next;
    return next;
  },

  async getVmUsage(vmId: string) {
    return apiRequest<VmUsageSample>(`/api/v1/vms/${encodeURIComponent(vmId)}/usage`);
  },

  async getIsoLibrary() {
    return apiRequest<IsoLibraryItem[]>('/api/v1/iso-library');
  },

  async getVmOperations(vmId: string) {
    return apiRequest<VmOperationItem[]>(`/api/v1/vms/${encodeURIComponent(vmId)}/operations?limit=50`);
  },

  async importIso(sourcePath: string) {
    return apiRequest<IsoLibraryItem>('/api/v1/iso-library/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_path: sourcePath })
    });
  },

  async uploadIso(file: File) {
    const { tenant, token } = getAuth();
    const url = new URL('/api/v1/iso-library/upload', window.location.origin);
    url.searchParams.set('tenant', tenant);
    url.searchParams.set('token', token);
    const formData = new FormData();
    formData.append('file', file);
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'X-Tenant-ID': tenant,
        'X-API-Key': token
      },
      body: formData
    });
    const raw = await response.text();
    const parsed = raw ? JSON.parse(raw) : {};
    if (!response.ok) {
      throw new Error(parsed.error || `Upload failed (${response.status})`);
    }
    return parsed.data as IsoLibraryItem;
  },

  async createVm(input: {
    id: string;
    name: string;
    node: string;
    cpuSockets: number;
    cpuCores: number;
    memoryMb: number;
    diskGb: number;
    diskBus: 'scsi' | 'sata' | 'virtio';
    networkMode: 'bridge' | 'nat' | 'private';
    networkSource: string;
    nicModel: 'virtio' | 'e1000' | 'vmxnet3';
    isoPath?: string;
    osFamily: 'linux' | 'windows' | 'other';
    osVersion: string;
    cloudInitUser: string;
    cloudInitNetwork: 'dhcp' | 'static';
    staticIp?: string;
    gateway?: string;
    dns?: string;
    vlanId?: string;
    timezone: string;
    startAtBoot: boolean;
    firewallEnabled: boolean;
    snapshotOnCreate: boolean;
  }) {
    await apiRequest('/api/v1/vms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `ui-vm-${input.id}-${Date.now()}` },
      body: JSON.stringify({
        id: input.id,
        name: input.name,
        node: input.node,
        vcpus: Math.max(1, input.cpuSockets * input.cpuCores),
        cpu_sockets: Math.max(1, input.cpuSockets),
        cpu_cores: Math.max(1, input.cpuCores),
        memory_mb: Math.max(512, input.memoryMb),
        disk_gb: Math.max(8, input.diskGb),
        disk_bus: input.diskBus,
        nic_model: input.nicModel,
        network_mode: input.networkMode === 'bridge' ? 'bridge' : 'network',
        [input.networkMode === 'bridge' ? 'bridge' : 'network']: input.networkSource || 'default',
        iso_path: input.isoPath?.trim() || undefined,
        os_family: input.osFamily,
        os_version: input.osVersion,
        cloud_init_user: input.cloudInitUser,
        cloud_init_network: input.cloudInitNetwork,
        static_ip: input.staticIp?.trim() || '',
        gateway: input.gateway?.trim() || '',
        dns: input.dns?.trim() || '',
        vlan_id: input.vlanId?.trim() || '',
        timezone: input.timezone,
        start_at_boot: input.startAtBoot,
        firewall_enabled: input.firewallEnabled,
        snapshot_on_create: input.snapshotOnCreate,
        snapshot_on_create_name: 'initial-state'
      })
    });

    const overrides = loadOverrides();
    overrides[input.id] = {
      cpuCores: Math.max(1, input.cpuSockets * input.cpuCores),
      ramMb: Math.max(512, input.memoryMb),
      cdrom: input.isoPath?.trim() || 'none',
      disks: [{ id: `${input.id}-d0`, name: `${input.diskBus}0`, sizeGb: Math.max(8, input.diskGb) }],
      nics: [{ id: `${input.id}-n0`, bridge: input.networkSource || 'default', model: input.nicModel }],
      options: {
        bootOrder: input.isoPath?.trim() ? `${input.diskBus}0,cdrom,net0` : `${input.diskBus}0,net0`,
        startAtBoot: input.startAtBoot,
        bios: 'UEFI',
        protection: false
      },
      cloudInit: {
        user: input.cloudInitUser,
        sshKeys: '',
        network: input.cloudInitNetwork,
        yaml: [
          `timezone: ${input.timezone}`,
          input.cloudInitNetwork === 'static' && input.staticIp ? `ip: ${input.staticIp}` : null,
          input.gateway ? `gateway: ${input.gateway}` : null,
          input.dns ? `dns: ${input.dns}` : null,
          input.vlanId ? `vlan: ${input.vlanId}` : null,
          `os_family: ${input.osFamily}`,
          `os_version: ${input.osVersion}`
        ].filter(Boolean).join('\n')
      },
      firewallEnabled: input.firewallEnabled,
      tags: [input.osFamily, input.snapshotOnCreate ? 'snap-init' : 'no-snap']
    };
    saveOverrides(overrides);

    return { id: input.id, name: input.name || input.id };
  },

  async action(vmId: string, action: string) {
    if (action === 'start') await apiRequest(`/api/v1/vms/${encodeURIComponent(vmId)}/start`, { method: 'POST' });
    else if (action === 'stop' || action === 'shutdown') await apiRequest(`/api/v1/vms/${encodeURIComponent(vmId)}/stop`, { method: 'POST' });
    else if (action === 'reboot') {
      await apiRequest(`/api/v1/vms/${encodeURIComponent(vmId)}/stop`, { method: 'POST' });
      await apiRequest(`/api/v1/vms/${encodeURIComponent(vmId)}/start`, { method: 'POST' });
    } else if (action === 'delete') await apiRequest(`/api/v1/vms/${encodeURIComponent(vmId)}`, { method: 'DELETE' });
    else if (action === 'purge') await apiRequest(`/api/v1/vms/${encodeURIComponent(vmId)}/purge`, { method: 'POST' });
    else if (action === 'snapshot') {
      const snapshotName = `quick-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      await apiRequest(`/api/v1/vms/${encodeURIComponent(vmId)}/snapshots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshot_name: snapshotName })
      });
    } else {
      throw new Error(`${action} is not available on backend yet`);
    }

    return { ok: true };
  },

  async quickSnapshot(vmId: string, name: string) {
    await apiRequest(`/api/v1/vms/${encodeURIComponent(vmId)}/snapshots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot_name: name })
    });
    return { id: name, name, createdAt: new Date().toISOString() };
  },

  async deleteSnapshot() {
    throw new Error('Snapshot delete endpoint is not available');
  },

  async rollbackSnapshot(vmId: string, snapshotId: string) {
    await apiRequest(`/api/v1/vms/${encodeURIComponent(vmId)}/snapshots/${encodeURIComponent(snapshotId)}/revert`, { method: 'POST' });
    return { ok: true };
  },

  async attachIso(vmId: string, isoPath: string) {
    await apiRequest(`/api/v1/vms/${encodeURIComponent(vmId)}/attach-iso`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ iso_path: isoPath })
    });
    return { ok: true };
  },

  async detachIso(vmId: string) {
    await apiRequest(`/api/v1/vms/${encodeURIComponent(vmId)}/detach-iso`, { method: 'POST' });
    return { ok: true };
  },

  async addBackup(vmId: string) {
    await apiRequest('/api/v1/backups/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `ui-backup-${vmId}-${Date.now()}` },
      body: JSON.stringify({ vm_id: vmId })
    });
    return { ok: true };
  },

  async restoreBackup() {
    throw new Error('Restore endpoint is not available');
  },

  async updateVm(vmId: string, patch: Partial<VmEntity>) {
    const overrides = loadOverrides();
    overrides[vmId] = { ...(overrides[vmId] || {}), ...patch };
    saveOverrides(overrides);

    if (patch.options?.bootOrder) {
      const primary = patch.options.bootOrder.toLowerCase().startsWith('cdrom') ? 'cdrom' : 'hd';
      await apiRequest(`/api/v1/vms/${encodeURIComponent(vmId)}/boot-order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ primary })
      });
    }

    return this.getVm(vmId);
  }
};
