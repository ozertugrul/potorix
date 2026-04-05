import type { MetricsSample, SnapshotItem, VmEntity } from '../types/vm';

const wait = (ms = 450) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

const createMetrics = (): MetricsSample[] => Array.from({ length: 20 }).map((_, i) => ({
  time: `${i * 3}m`,
  cpu: Math.round(25 + Math.random() * 65),
  ram: Math.round(30 + Math.random() * 55),
  diskIo: Math.round(10 + Math.random() * 70),
  net: Math.round(15 + Math.random() * 75)
}));

const createVmTemplate = (id: string, name: string, node: string): VmEntity => ({
  id,
  name,
  node,
  status: 'stopped',
  uptime: '0m',
  tags: ['new'],
  cpuCores: 2,
  ramMb: 4096,
  disks: [{ id: `d-${id}-0`, name: 'scsi0', sizeGb: 40 }],
  nics: [{ id: `n-${id}-0`, bridge: 'vmbr0', model: 'virtio' }],
  cdrom: 'none',
  gpu: 'none',
  options: { bootOrder: 'scsi0,net0', startAtBoot: false, bios: 'UEFI', protection: false },
  cloudInit: { user: 'cloud-user', sshKeys: '', network: 'dhcp', yaml: 'packages:\n  - qemu-guest-agent' },
  firewallEnabled: false,
  firewallRules: [],
  permissions: [{ id: `p-${id}-1`, user: 'admin', role: 'VM.Admin' }],
  snapshots: [],
  backups: [],
  tasks: [{ id: `t-${Date.now()}`, action: 'create', status: 'success', timestamp: now() }]
});

const db: { vms: VmEntity[]; metrics: Record<string, MetricsSample[]> } = {
  vms: [
    {
      id: '100',
      name: 'prod-web-01',
      node: 'node-a',
      status: 'running',
      uptime: '6d 12h',
      tags: ['prod', 'web'],
      cpuCores: 8,
      ramMb: 16384,
      disks: [{ id: 'd0', name: 'scsi0', sizeGb: 120 }],
      nics: [{ id: 'n0', bridge: 'vmbr0', model: 'virtio' }],
      cdrom: 'none',
      gpu: 'none',
      options: { bootOrder: 'scsi0,net0', startAtBoot: true, bios: 'UEFI', protection: true },
      cloudInit: { user: 'ubuntu', sshKeys: 'ssh-rsa AAAA...', network: 'dhcp', yaml: `packages:\n  - qemu-guest-agent` },
      firewallEnabled: true,
      firewallRules: [{ id: 'f1', direction: 'IN', action: 'ACCEPT', source: '0.0.0.0/0', destination: '10.0.0.10', port: '22,443' }],
      permissions: [{ id: 'p1', user: 'alice', role: 'VM.Admin' }, { id: 'p2', user: 'bob', role: 'VM.Audit' }],
      snapshots: [{ id: 's1', name: 'before-upgrade', createdAt: now() }],
      backups: [{ id: 'b1', name: 'daily-2026-04-03', createdAt: now(), size: '14GB' }],
      tasks: [{ id: 't1', action: 'start', status: 'success', timestamp: now() }]
    },
    {
      id: '101',
      name: 'stage-api-01',
      node: 'node-b',
      status: 'stopped',
      uptime: '0m',
      tags: ['stage', 'api'],
      cpuCores: 4,
      ramMb: 8192,
      disks: [{ id: 'd0', name: 'scsi0', sizeGb: 80 }],
      nics: [{ id: 'n0', bridge: 'vmbr1', model: 'virtio' }],
      cdrom: '/iso/debian.iso',
      options: { bootOrder: 'cdrom,scsi0', startAtBoot: false, bios: 'BIOS', protection: false },
      cloudInit: { user: 'debian', sshKeys: '', network: 'static', yaml: `network:\n  version: 2` },
      firewallEnabled: false,
      firewallRules: [],
      permissions: [{ id: 'p3', user: 'carol', role: 'VM.Operator' }],
      snapshots: [],
      backups: [],
      tasks: [{ id: 't2', action: 'stop', status: 'success', timestamp: now() }]
    }
  ],
  metrics: { '100': createMetrics(), '101': createMetrics() }
};

const pushTask = (vm: VmEntity, action: string, status: 'success' | 'failed' | 'running' = 'success') => {
  vm.tasks.unshift({ id: `t-${Date.now()}`, action, status, timestamp: now() });
  vm.tasks = vm.tasks.slice(0, 40);
};

const findVm = (vmId: string) => {
  const vm = db.vms.find((x) => x.id === vmId);
  if (!vm) throw new Error('VM not found');
  return vm;
};

export const mockVmApi = {
  async getVms() {
    await wait();
    return db.vms.map((x) => ({ ...x }));
  },
  async getVm(vmId: string) {
    await wait();
    return { ...findVm(vmId) };
  },
  async getMetrics(vmId: string) {
    await wait(220);
    db.metrics[vmId] = createMetrics();
    return db.metrics[vmId];
  },
  async createVm(input: { id: string; name: string; node: string }) {
    await wait(600);
    if (db.vms.some((x) => x.id === input.id)) throw new Error('VM ID already exists');
    const vm = createVmTemplate(input.id, input.name, input.node);
    db.vms.unshift(vm);
    db.metrics[vm.id] = createMetrics();
    return { ...vm };
  },
  async action(vmId: string, action: string) {
    await wait(700);
    const vm = findVm(vmId);
    if (action === 'start') vm.status = 'running';
    if (action === 'stop' || action === 'shutdown') vm.status = 'stopped';
    if (action === 'reboot') vm.status = 'running';
    if (action === 'delete') {
      db.vms = db.vms.filter((x) => x.id !== vmId);
      delete db.metrics[vmId];
      return { ok: true };
    }
    if (action === 'clone') {
      const cloneId = String(Math.floor(200 + Math.random() * 700));
      const clone: VmEntity = {
        ...vm,
        id: cloneId,
        name: `${vm.name}-clone`,
        status: 'stopped',
        tasks: [{ id: `t-${Date.now()}`, action: 'create', status: 'success', timestamp: now() }],
        snapshots: [],
        backups: []
      };
      db.vms.unshift(clone);
      db.metrics[cloneId] = createMetrics();
    }
    pushTask(vm, action, 'success');
    return { ok: true };
  },
  async quickSnapshot(vmId: string, name: string) {
    await wait();
    const vm = findVm(vmId);
    const snap: SnapshotItem = { id: `s-${Date.now()}`, name, createdAt: now() };
    vm.snapshots.unshift(snap);
    pushTask(vm, 'snapshot');
    return snap;
  },
  async deleteSnapshot(vmId: string, snapshotId: string) {
    await wait();
    const vm = findVm(vmId);
    vm.snapshots = vm.snapshots.filter((s) => s.id !== snapshotId);
    pushTask(vm, 'snapshot-delete');
    return { ok: true };
  },
  async rollbackSnapshot(vmId: string, snapshotId: string) {
    await wait();
    const vm = findVm(vmId);
    if (!vm.snapshots.some((s) => s.id === snapshotId)) throw new Error('Snapshot not found');
    pushTask(vm, 'snapshot-rollback');
    return { ok: true };
  },
  async addBackup(vmId: string) {
    await wait();
    const vm = findVm(vmId);
    vm.backups.unshift({ id: `b-${Date.now()}`, name: `manual-${new Date().toISOString().slice(0, 10)}`, createdAt: now(), size: `${Math.floor(4 + Math.random() * 20)}GB` });
    pushTask(vm, 'backup');
    return { ok: true };
  },
  async restoreBackup(vmId: string, backupId: string) {
    await wait();
    const vm = findVm(vmId);
    if (!vm.backups.some((b) => b.id === backupId)) throw new Error('Backup not found');
    pushTask(vm, 'backup-restore');
    return { ok: true };
  },
  async updateVm(vmId: string, patch: Partial<VmEntity>) {
    await wait();
    const vm = findVm(vmId);
    Object.assign(vm, patch);
    pushTask(vm, 'edit');
    return { ...vm };
  }
};
