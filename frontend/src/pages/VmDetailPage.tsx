import { useEffect, useMemo, useState } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Activity, ArrowUpDown, Copy, HardDrive, LayoutDashboard, Monitor, Play, Power, RotateCcw, Server, Shield, Trash2, Camera, Terminal, PowerOff, Rocket, PauseCircle, PlusCircle } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useIsoLibraryQuery, useSystemUsageQuery, useVmMetricsQuery, useVmDetailQuery, useVmOperationsQuery, useVmsQuery } from '../hooks/useVmQueries';
import { useVmAction } from '../hooks/useVmActions';
import { useVmStore } from '../store/vmStore';
import { useToastStore } from '../store/toastStore';
import { backendVmApi } from '../services/backendVmApi';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Modal } from '../components/ui/Modal';
import { Table } from '../components/ui/Table';
import { Tabs } from '../components/ui/Tabs';
import { Skeleton } from '../components/ui/Skeleton';
import { ToastViewport } from '../components/ui/ToastViewport';

const tabItems = [
  { key: 'summary', label: 'Summary' },
  { key: 'console', label: 'Console' },
  { key: 'hardware', label: 'Hardware' },
  { key: 'options', label: 'Options' },
  { key: 'cloudinit', label: 'Cloud-Init' },
  { key: 'snapshots', label: 'Snapshots' },
  { key: 'backup', label: 'Backup' },
  { key: 'firewall', label: 'Firewall' },
  { key: 'permissions', label: 'Permissions' },
  { key: 'monitoring', label: 'Monitoring' },
  { key: 'tasks', label: 'Tasks' }
];

type CreateVmForm = {
  id: string;
  name: string;
  node: string;
  osFamily: 'linux' | 'windows' | 'other';
  osVersion: string;
  cpuSockets: number;
  cpuCores: number;
  memoryMb: number;
  diskGb: number;
  diskBus: 'scsi' | 'sata' | 'virtio';
  networkMode: 'bridge' | 'nat' | 'private';
  networkSource: string;
  nicModel: 'virtio' | 'e1000' | 'vmxnet3';
  isoPath: string;
  cloudInitUser: string;
  cloudInitNetwork: 'dhcp' | 'static';
  staticIp: string;
  gateway: string;
  dns: string;
  vlanId: string;
  timezone: string;
  startAtBoot: boolean;
  firewallEnabled: boolean;
  snapshotOnCreate: boolean;
};

const defaultCreateVmForm: CreateVmForm = {
  id: '200',
  name: 'new-vm',
  node: 'node-a',
  osFamily: 'linux',
  osVersion: 'Ubuntu 24.04 LTS',
  cpuSockets: 1,
  cpuCores: 2,
  memoryMb: 4096,
  diskGb: 40,
  diskBus: 'scsi',
  networkMode: 'nat',
  networkSource: 'default',
  nicModel: 'virtio',
  isoPath: '',
  cloudInitUser: 'admin',
  cloudInitNetwork: 'dhcp',
  staticIp: '',
  gateway: '',
  dns: '1.1.1.1',
  vlanId: '',
  timezone: 'UTC',
  startAtBoot: true,
  firewallEnabled: true,
  snapshotOnCreate: false
};

type SidebarView = 'dashboard' | 'resources' | 'images';

export function VmDetailPage() {
  const [tab, setTab] = useState('summary');
  const [sidebarView, setSidebarView] = useState<SidebarView>('dashboard');
  const [editOpen, setEditOpen] = useState(false);
  const [ruleOpen, setRuleOpen] = useState(false);
  const [createVmOpen, setCreateVmOpen] = useState(false);
  const [fullConsole, setFullConsole] = useState(false);
  const [captureKeyboard, setCaptureKeyboard] = useState(false);
  const [snapshotName, setSnapshotName] = useState('quick-snap');
  const [newTag, setNewTag] = useState('');
  const [newRule, setNewRule] = useState({ direction: 'IN', action: 'ACCEPT', source: '0.0.0.0/0', destination: '10.0.0.10', port: '443' });
  const [createVmForm, setCreateVmForm] = useState<CreateVmForm>(defaultCreateVmForm);
  const [createStep, setCreateStep] = useState(0);
  const [showAdvancedCreate, setShowAdvancedCreate] = useState(false);
  const [isoImportSourcePath, setIsoImportSourcePath] = useState('');
  const [isoUploadFile, setIsoUploadFile] = useState<File | null>(null);

  const selectedVmId = useVmStore((s) => s.selectedVmId);
  const setPrimaryVm = useVmStore((s) => s.setPrimaryVm);
  const actionLoading = useVmStore((s) => s.actionLoading);

  const queryClient = useQueryClient();
  const pushToast = useToastStore((s) => s.push);

  const vmsQuery = useVmsQuery();
  const vmQuery = useVmDetailQuery(selectedVmId);
  const metricsQuery = useVmMetricsQuery(selectedVmId);
  const systemUsageQuery = useSystemUsageQuery();
  const isoLibraryQuery = useIsoLibraryQuery();
  const vmOperationsQuery = useVmOperationsQuery(selectedVmId);

  const vm = vmQuery.data;
  const allVms = vmsQuery.data || [];
  const vmCount = allVms.length;
  const existingVmNames = useMemo(() => new Set(allVms.map((item) => item.name.trim().toLowerCase())), [allVms]);
  const existingVmIds = useMemo(() => new Set(allVms.map((item) => item.id.trim())), [allVms]);
  const suggestedNextVmId = useMemo(() => {
    if (allVms.length === 0) return '100';
    const maxId = allVms.reduce((max, item) => {
      const n = Number(item.id);
      return Number.isFinite(n) ? Math.max(max, n) : max;
    }, 99);
    return String(maxId + 1);
  }, [allVms]);

  const dashboardSeries = useMemo(() => {
    const cpuBase = Math.round((((systemUsageQuery.data?.tenant.alloc_vcpus || 0) / Math.max(systemUsageQuery.data?.host.cpu_total || 1, 1)) * 100));
    const ramBase = Math.round((((systemUsageQuery.data?.tenant.alloc_memory_mb || 0) / Math.max(systemUsageQuery.data?.host.memory_total_mb || 1, 1)) * 100));
    return Array.from({ length: 16 }).map((_, idx) => ({
      time: `${idx * 5}m`,
      cpu: Math.min(100, Math.max(0, cpuBase + (idx % 5))),
      ram: Math.min(100, Math.max(0, ramBase + (idx % 4))),
      net: 8 + ((idx * 3) % 25)
    }));
  }, [systemUsageQuery.data]);

  const hostSummary = useMemo(() => {
    const running = allVms.filter((item) => item.status === 'running').length;
    const totalCores = allVms.reduce((sum, item) => sum + item.cpuCores, 0);
    const totalRamMb = allVms.reduce((sum, item) => sum + item.ramMb, 0);
    const totalDiskGb = allVms.reduce((sum, item) => sum + item.disks.reduce((acc, disk) => acc + disk.sizeGb, 0), 0);
    return { running, totalCores, totalRamMb, totalDiskGb };
  }, [allVms]);

  useEffect(() => {
    if (allVms.length > 0 && !selectedVmId) {
      setPrimaryVm(allVms[0].id);
    }
    if (selectedVmId && !allVms.some((v) => v.id === selectedVmId)) {
      setPrimaryVm(allVms[0]?.id ?? null);
    }
  }, [allVms, selectedVmId, setPrimaryVm]);

  const start = useVmAction(selectedVmId, 'start');
  const stop = useVmAction(selectedVmId, 'stop');
  const reboot = useVmAction(selectedVmId, 'reboot');
  const shutdown = useVmAction(selectedVmId, 'shutdown');
  const quickSnap = useVmAction(selectedVmId, 'snapshot');
  const remove = useVmAction(selectedVmId, 'delete');
  const purge = useVmAction(selectedVmId, 'purge');

  const backupMutation = useMutation({
    mutationFn: async () => {
      if (!selectedVmId) throw new Error('No VM selected');
      return backendVmApi.addBackup(selectedVmId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vm', selectedVmId] });
      pushToast({ kind: 'success', title: 'Backup started', message: 'Manual backup queued.' });
    }
  });

  const createVmMutation = useMutation({
    mutationFn: () => backendVmApi.createVm(createVmForm),
    onSuccess: (createdVm) => {
      queryClient.invalidateQueries({ queryKey: ['vms'] });
      setPrimaryVm(createdVm.id);
      setSidebarView('resources');
      setCreateVmOpen(false);
      setCreateStep(0);
      setShowAdvancedCreate(false);
      setCreateVmForm((prev) => ({
        ...defaultCreateVmForm,
        id: String(Math.max(100, Number(prev.id || 100) + 1))
      }));
      pushToast({ kind: 'success', title: 'VM created', message: `${createdVm.name} is ready for first boot.` });
    },
    onError: (error: Error) => {
      pushToast({ kind: 'error', title: 'Create failed', message: error.message });
    }
  });

  const importIsoMutation = useMutation({
    mutationFn: async () => backendVmApi.importIso(isoImportSourcePath),
    onSuccess: (iso) => {
      queryClient.invalidateQueries({ queryKey: ['iso-library'] });
      setIsoImportSourcePath('');
      pushToast({ kind: 'success', title: 'ISO imported', message: `${iso.name} added to image library.` });
    },
    onError: (error: Error) => {
      pushToast({ kind: 'error', title: 'ISO import failed', message: error.message });
    }
  });

  const uploadIsoMutation = useMutation({
    mutationFn: async () => {
      if (!isoUploadFile) throw new Error('Select an ISO file first');
      return backendVmApi.uploadIso(isoUploadFile);
    },
    onSuccess: (iso) => {
      queryClient.invalidateQueries({ queryKey: ['iso-library'] });
      setIsoUploadFile(null);
      pushToast({ kind: 'success', title: 'ISO uploaded', message: `${iso.name} uploaded to image library.` });
    },
    onError: (error: Error) => {
      pushToast({ kind: 'error', title: 'ISO upload failed', message: error.message });
    }
  });

  const createSnapshotMutation = useMutation({
    mutationFn: async () => {
      if (!selectedVmId) throw new Error('No VM selected');
      return backendVmApi.quickSnapshot(selectedVmId, snapshotName);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vm', selectedVmId] });
      pushToast({ kind: 'success', title: 'Snapshot created', message: 'Snapshot is available for rollback.' });
    }
  });

  const timeline = useMemo(() => {
    if (!vm) return [];
    const taskEvents = vm.tasks.map((t) => ({ id: t.id, label: `Task: ${t.action}`, at: t.timestamp, type: 'task' }));
    const snapEvents = vm.snapshots.map((s) => ({ id: s.id, label: `Snapshot: ${s.name}`, at: s.createdAt, type: 'snapshot' }));
    return [...taskEvents, ...snapEvents].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 15);
  }, [vm]);

  const canStart = vm?.status === 'stopped';
  const canStop = vm?.status === 'running';
  const consoleUrl = useMemo(() => {
    if (!vm) return '';
    let tenant = 'tenant-a';
    let token = 'dev-admin-key';
    try {
      tenant = localStorage.getItem('potorix.auth.tenant')?.trim() || tenant;
      token = localStorage.getItem('potorix.auth.token')?.trim() || token;
    } catch {
      // ignore storage access failures
    }
    const params = new URLSearchParams({ tenant, token, vm_id: vm.id });
    return `/novnc.html?${params.toString()}`;
  }, [vm]);

  const createSteps = ['Identity', 'Compute', 'Storage & Network', 'Review'];
  const createValidationErrors = useMemo(() => {
    const errors: string[] = [];
    if (!createVmForm.id.trim()) errors.push('VM ID is required');
    if (!createVmForm.name.trim()) errors.push('VM name is required');
    if (existingVmIds.has(createVmForm.id.trim())) errors.push(`VM ID ${createVmForm.id.trim()} already exists`);
    const normalizedName = createVmForm.name.trim().toLowerCase();
    if (normalizedName && existingVmNames.has(normalizedName)) errors.push(`VM name '${createVmForm.name.trim()}' already exists`);
    if (!createVmForm.node.trim()) errors.push('Node is required');
    if (createVmForm.cpuSockets < 1 || createVmForm.cpuCores < 1) errors.push('CPU sockets/cores must be at least 1');
    if (createVmForm.memoryMb < 512) errors.push('Memory must be at least 512 MB');
    if (createVmForm.diskGb < 8) errors.push('Disk must be at least 8 GB');
    if (!createVmForm.networkSource.trim()) errors.push('Network source is required');
    if (createVmForm.cloudInitNetwork === 'static' && !createVmForm.staticIp.trim()) errors.push('Static IP is required when static network is selected');
    return errors;
  }, [createVmForm, existingVmIds, existingVmNames]);

  const createStepHasError = (index: number) => {
    if (index === 0) return !createVmForm.id.trim() || !createVmForm.name.trim() || !createVmForm.node.trim();
    if (index === 1) return createVmForm.cpuSockets < 1 || createVmForm.cpuCores < 1 || createVmForm.memoryMb < 512;
    if (index === 2) {
      if (createVmForm.diskGb < 8 || !createVmForm.networkSource.trim()) return true;
      if (createVmForm.cloudInitNetwork === 'static' && !createVmForm.staticIp.trim()) return true;
    }
    return false;
  };

  const openCreateWizard = () => {
    const preferredIso = isoLibraryQuery.data?.[0]?.path || '';
    setCreateVmOpen(true);
    setCreateStep(0);
    setShowAdvancedCreate(false);
    setCreateVmForm((s) => ({ ...s, id: suggestedNextVmId, isoPath: s.isoPath || preferredIso }));
  };

  const saveVmPatch = async (patch: Record<string, unknown>, successTitle: string) => {
    if (!vm) return;
    await backendVmApi.updateVm(vm.id, patch);
    queryClient.invalidateQueries({ queryKey: ['vm', vm.id] });
    queryClient.invalidateQueries({ queryKey: ['vms'] });
    pushToast({ kind: 'success', title: successTitle, message: 'Changes saved successfully.' });
  };

  return (
    <div className="shell">
      <aside className="resource-tree">
        <div className="tree-nav-wrap">
          <button className={`tree-nav-btn ${sidebarView === 'dashboard' ? 'active' : ''}`} onClick={() => setSidebarView('dashboard')}>
            <LayoutDashboard size={14} /> Dashboard
          </button>
          <button className={`tree-nav-btn ${sidebarView === 'resources' ? 'active' : ''}`} onClick={() => setSidebarView('resources')}>
            <Server size={14} /> Resources
          </button>
          <button className={`tree-nav-btn ${sidebarView === 'images' ? 'active' : ''}`} onClick={() => setSidebarView('images')}>
            <HardDrive size={14} /> Images
          </button>
        </div>

        {sidebarView === 'resources' && (
          <>
            <div className="tree-list">
              {vmCount === 0 && (
                <div className="tree-empty">
                  <p>No VM found.</p>
                  <Button icon={<PlusCircle size={14} />} onClick={openCreateWizard}>Create First VM</Button>
                </div>
              )}
              {allVms.map((item) => (
                <div key={item.id} className={`tree-item tree-item-single ${selectedVmId === item.id ? 'active' : ''}`}>
                  <button onClick={() => setPrimaryVm(item.id)}>
                    <strong>{item.name}</strong>
                    <span>{item.status.toUpperCase()} • VM {item.id}</span>
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </aside>

      <main className="work-area">
        {sidebarView === 'dashboard' && (
          <>
            <div className="sticky-actions">
              <div>
                <h1>Main Host Dashboard</h1>
                <p>Host overview, usage trends and VM fleet health in one place.</p>
              </div>
            </div>

            <div className="grid-2">
              <Card title="Host Overview">
                <div className="stats-grid">
                  <div><span>Hostname</span><strong>{window.location.hostname || 'localhost'}</strong></div>
                  <div><span>OS</span><strong>Linux / Docker</strong></div>
                  <div><span>Kernel</span><strong>{navigator.platform}</strong></div>
                  <div><span>Total Host CPU</span><strong>{systemUsageQuery.data?.host.cpu_total ?? '-'}</strong></div>
                  <div><span>Total Host RAM</span><strong>{Math.round((systemUsageQuery.data?.host.memory_total_mb ?? 0) / 1024)} GB</strong></div>
                  <div><span>Free Disk</span><strong>{systemUsageQuery.data?.host.disk_free_gb ?? '-'} GB</strong></div>
                </div>
              </Card>

              <Card title="Capacity Summary">
                <div className="stats-grid">
                  <div><span>Total VMs</span><strong>{systemUsageQuery.data?.tenant.vm_total ?? vmCount}</strong></div>
                  <div><span>Running VMs</span><strong>{systemUsageQuery.data?.tenant.vm_running ?? hostSummary.running}</strong></div>
                  <div><span>Allocated vCPU</span><strong>{systemUsageQuery.data?.tenant.alloc_vcpus ?? hostSummary.totalCores}</strong></div>
                  <div><span>Allocated RAM</span><strong>{Math.round((systemUsageQuery.data?.tenant.alloc_memory_mb ?? hostSummary.totalRamMb) / 1024)} GB</strong></div>
                  <div><span>Allocated Disk</span><strong>{systemUsageQuery.data?.tenant.alloc_disk_gb ?? hostSummary.totalDiskGb} GB</strong></div>
                  <div><span>Health</span><strong className="badge running">healthy</strong></div>
                </div>
              </Card>
            </div>

            <div className="grid-2">
              <Card title="Host CPU / RAM Trend">
                <ResponsiveContainer width="100%" height={230}>
                  <AreaChart data={dashboardSeries}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="time" />
                    <YAxis />
                    <Tooltip />
                    <Area type="monotone" dataKey="cpu" stroke="#2563eb" fill="#93c5fd" fillOpacity={0.45} />
                    <Area type="monotone" dataKey="ram" stroke="#22c55e" fill="#86efac" fillOpacity={0.3} />
                  </AreaChart>
                </ResponsiveContainer>
              </Card>

              <Card title="Network Activity">
                <ResponsiveContainer width="100%" height={230}>
                  <AreaChart data={dashboardSeries}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="time" />
                    <YAxis />
                    <Tooltip />
                    <Area type="monotone" dataKey="net" stroke="#f59e0b" fill="#fde68a" fillOpacity={0.35} />
                  </AreaChart>
                </ResponsiveContainer>
              </Card>
            </div>

            <Card title="Top Resource VMs">
              <Table rows={allVms} columns={[
                { key: 'name', label: 'VM' },
                { key: 'node', label: 'Node' },
                { key: 'status', label: 'Status', render: (row) => <span className={`badge ${row.status}`}>{row.status}</span> },
                { key: 'cpuCores', label: 'vCPU' },
                { key: 'ramMb', label: 'RAM (MB)' },
                { key: 'open', label: 'Action', render: (row) => <Button onClick={() => { setPrimaryVm(row.id); setSidebarView('resources'); }}>Open VM</Button> }
              ]} />
            </Card>
          </>
        )}

        {sidebarView === 'images' && (
          <>
            <div className="sticky-actions">
              <div>
                <h1>Image Library</h1>
                <p>Manage bootable ISO library for VM first boot and reinstall operations.</p>
              </div>
            </div>

            <Card title="Import ISO">
              <div className="form-grid">
                <label className="span2">Source path (server path)
                  <input
                    placeholder="/tmp/ubuntu-24.04.iso"
                    value={isoImportSourcePath}
                    onChange={(e) => setIsoImportSourcePath(e.target.value)}
                  />
                </label>
                <label className="span2">Upload ISO file
                  <input
                    type="file"
                    accept=".iso"
                    onChange={(e) => setIsoUploadFile(e.target.files?.[0] || null)}
                  />
                </label>
              </div>
              <div className="row-gap">
                <Button
                  loading={importIsoMutation.isPending}
                  disabled={!isoImportSourcePath.trim()}
                  onClick={() => importIsoMutation.mutate()}
                >
                  Import ISO
                </Button>
                <Button
                  variant="ghost"
                  loading={uploadIsoMutation.isPending}
                  disabled={!isoUploadFile}
                  onClick={() => uploadIsoMutation.mutate()}
                >
                  Upload ISO
                </Button>
              </div>
            </Card>

            <Card title="Available ISOs">
              <Table
                rows={isoLibraryQuery.data || []}
                columns={[
                  { key: 'name', label: 'Name' },
                  { key: 'path', label: 'Path' },
                  { key: 'size_bytes', label: 'Size', render: (row) => `${Math.max(1, Math.round(Number(row.size_bytes || 0) / 1024 / 1024))} MB` },
                  { key: 'mtime', label: 'Updated', render: (row) => String(row.mtime || '-') }
                ]}
              />
            </Card>
          </>
        )}

        {sidebarView === 'resources' && (
          <>
            <div className="sticky-actions">
              <div>
                <h1>{vm ? `${vm.name} (VM ${vm.id})` : 'Create or Select VM'}</h1>
                <p>{vm ? `${vm.node} • ${vm.status.toUpperCase()} • ${vm.uptime}` : 'Start by creating your first machine from New VM.'}</p>
              </div>
              <div className="action-grid">
                <Button icon={<Play size={15} />} loading={start.isPending || actionLoading.start} disabled={!canStart} onClick={() => start.mutate()}>Start</Button>
                <Button icon={<Power size={15} />} loading={stop.isPending || actionLoading.stop} disabled={!canStop} onClick={() => stop.mutate()}>Stop</Button>
                <Button icon={<RotateCcw size={15} />} loading={reboot.isPending || actionLoading.reboot} disabled={!canStop} onClick={() => reboot.mutate()}>Reboot</Button>
                <Button icon={<PowerOff size={15} />} loading={shutdown.isPending || actionLoading.shutdown} disabled={!canStop} onClick={() => shutdown.mutate()}>Shutdown</Button>
                <Button icon={<Terminal size={15} />} disabled={!vm} onClick={() => setTab('console')}>Console</Button>
                <Button icon={<Copy size={15} />} disabled={!vm} onClick={async () => {
                  if (!vm) return;
                  const defaultTarget = String(Number(vm.id) + 1);
                  const targetId = window.prompt('Clone target VM ID', defaultTarget)?.trim() || '';
                  if (!targetId) return;
                  await backendVmApi.cloneVm(vm.id, targetId);
                  queryClient.invalidateQueries({ queryKey: ['vms'] });
                  pushToast({ kind: 'success', title: 'Clone queued', message: `${vm.id} -> ${targetId}` });
                }}>Clone</Button>
                <Button icon={<ArrowUpDown size={15} />} disabled={!vm} onClick={async () => {
                  if (!vm) return;
                  const destination = window.prompt('Destination libvirt URI', 'qemu+ssh://root@target/system')?.trim() || '';
                  if (!destination) return;
                  await backendVmApi.migrateVm(vm.id, destination, true, false);
                  queryClient.invalidateQueries({ queryKey: ['vms'] });
                  pushToast({ kind: 'success', title: 'Migrate queued', message: `${vm.id} -> ${destination}` });
                }}>Migrate</Button>
                <Button icon={<Camera size={15} />} loading={quickSnap.isPending || actionLoading.snapshot} disabled={!vm} onClick={() => quickSnap.mutate()}>Snapshot</Button>
                <Button icon={<Trash2 size={15} />} variant="danger" loading={remove.isPending || actionLoading.delete} disabled={!vm} onClick={() => {
                  if (!vm || !window.confirm(`Delete ${vm.name} permanently?`)) return;
                  remove.mutate(undefined, {
                    onSuccess: () => {
                      queryClient.invalidateQueries({ queryKey: ['vms'] });
                      setPrimaryVm(null);
                    }
                  });
                }}>Delete</Button>
                <Button icon={<Trash2 size={15} />} variant="danger" loading={purge.isPending || actionLoading.purge} disabled={!vm} onClick={() => {
                  if (!vm || !window.confirm(`Purge ${vm.name} irreversibly? This removes VM, disks and records permanently.`)) return;
                  purge.mutate(undefined, {
                    onSuccess: () => {
                      queryClient.invalidateQueries({ queryKey: ['vms'] });
                      setPrimaryVm(null);
                      pushToast({ kind: 'success', title: 'Purge queued', message: `${vm.name} will be permanently removed.` });
                    }
                  });
                }}>Purge</Button>
                <Button icon={<PlusCircle size={15} />} onClick={openCreateWizard}>New VM</Button>
              </div>
            </div>

            {!vm && vmCount > 0 && <Card><Skeleton className="h-24" /></Card>}

            {!vm && vmCount === 0 && (
              <Card title="No virtual machines yet">
                <div className="empty-state">
                  <Activity size={20} />
                  <p>Create your first VM to unlock console, snapshots, backup, monitoring and full lifecycle actions.</p>
                  <Button icon={<PlusCircle size={15} />} onClick={openCreateWizard}>Create First VM</Button>
                </div>
              </Card>
            )}

            {vm && (
              <>
                <div className="tag-row">
                  {vm.tags.map((t) => <span key={t} className="tag">#{t}</span>)}
                  <input placeholder="add tag" value={newTag} onChange={(e) => setNewTag(e.target.value)} />
                  <Button icon={<Rocket size={14} />} onClick={async () => {
                    const normalized = newTag.trim();
                    if (!normalized) return;
                    if (vm.tags.includes(normalized)) {
                      pushToast({ kind: 'info', title: 'Tag exists', message: 'This tag is already assigned.' });
                      return;
                    }
                    await saveVmPatch({ tags: [...vm.tags, normalized] }, 'Tag added');
                    setNewTag('');
                  }}>Add Tag</Button>
                </div>

                <Tabs value={tab} onChange={setTab} items={tabItems} />

                {tab === 'summary' && (
                  <div className="grid-2">
                    <Card title="VM Health Overview">
                      {metricsQuery.isLoading ? <Skeleton className="h-56" /> : (
                        <ResponsiveContainer width="100%" height={220}>
                          <AreaChart data={metricsQuery.data || []}>
                            <defs><linearGradient id="cpu" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#3b82f6" stopOpacity={0.8}/><stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/></linearGradient></defs>
                            <CartesianGrid strokeDasharray="3 3" />
                            <XAxis dataKey="time" />
                            <YAxis />
                            <Tooltip />
                            <Area type="monotone" dataKey="cpu" stroke="#3b82f6" fillOpacity={1} fill="url(#cpu)" />
                          </AreaChart>
                        </ResponsiveContainer>
                      )}
                    </Card>
                    <Card title="Summary Cards">
                      <div className="stats-grid">
                        <div><span>CPU</span><strong>{(metricsQuery.data?.at(-1)?.cpu ?? 0)}%</strong></div>
                        <div><span>RAM</span><strong>{(metricsQuery.data?.at(-1)?.ram ?? 0)}%</strong></div>
                        <div><span>Disk IO</span><strong>{(metricsQuery.data?.at(-1)?.diskIo ?? 0)}%</strong></div>
                        <div><span>Network</span><strong>{(metricsQuery.data?.at(-1)?.net ?? 0)}%</strong></div>
                        <div><span>Status</span><strong className={`badge ${vm.status}`}>{vm.status}</strong></div>
                        <div><span>Uptime</span><strong>{vm.uptime}</strong></div>
                      </div>
                    </Card>
                  </div>
                )}

                {tab === 'console' && (
                  <Card title="Console">
                    <div className={`console-placeholder ${fullConsole ? 'full' : ''}`}>
                      <div className="console-top">
                        <Button icon={<Monitor size={14} />} onClick={() => setFullConsole((s) => !s)}>{fullConsole ? 'Exit Fullscreen' : 'Fullscreen'}</Button>
                        <Button icon={<PauseCircle size={14} />} onClick={() => setCaptureKeyboard((s) => !s)}>{captureKeyboard ? 'Release Keyboard' : 'Capture Keyboard'}</Button>
                      </div>
                      <div className="console-body console-embed">
                        {vm && vm.status === 'running' ? (
                          <iframe
                            title={`noVNC-${vm.id}`}
                            src={consoleUrl}
                            className="console-iframe"
                            allow="clipboard-read; clipboard-write"
                          />
                        ) : vm ? (
                          <div className="console-empty">
                            <strong>VM is not running</strong>
                            <p>Start the VM first to open the console connection.</p>
                            <Button icon={<Play size={14} />} loading={start.isPending || actionLoading.start} onClick={() => start.mutate()}>Start VM</Button>
                          </div>
                        ) : (
                          <span>Select a VM to open console.</span>
                        )}
                      </div>
                    </div>
                  </Card>
                )}

                {tab === 'hardware' && (
                  <>
                    <Card title="Hardware Components">
                      <Table rows={[
                        { id: 'cpu', key: 'CPU', value: `${vm.cpuCores} cores` },
                        { id: 'ram', key: 'RAM', value: `${vm.ramMb} MB` },
                        { id: 'disk', key: 'Disks', value: vm.disks.map((d) => `${d.name} (${d.sizeGb}GB)`).join(', ') || 'None' },
                        { id: 'nic', key: 'Network', value: vm.nics.map((n) => `${n.bridge}/${n.model}`).join(', ') || 'None' },
                        { id: 'gpu', key: 'GPU', value: vm.gpu ?? 'None' },
                        { id: 'cdrom', key: 'CD/DVD', value: vm.cdrom }
                      ]} columns={[{ key: 'key', label: 'Device' }, { key: 'value', label: 'Value' }, { key: 'act', label: 'Actions', render: () => <Button onClick={() => setEditOpen(true)}>Edit</Button> }]} />
                      <div className="row-gap">
                        <Button onClick={() => setEditOpen(true)}>Add / Edit Hardware</Button>
                        <Button onClick={async () => {
                          if (!vm.disks[0]) return;
                          const resizedDisks = vm.disks.map((d, idx) => idx === 0 ? { ...d, sizeGb: d.sizeGb + 10 } : d);
                          await saveVmPatch({ disks: resizedDisks }, 'Disk resized');
                        }}>Disk Resize (+10GB)</Button>
                        <Button variant="danger" onClick={async () => {
                          if (!window.confirm('Remove last attached disk?')) return;
                          const nextDisks = vm.disks.slice(0, -1);
                          await saveVmPatch({ disks: nextDisks }, 'Disk removed');
                        }} disabled={vm.disks.length === 0}>Remove Last Disk</Button>
                      </div>
                    </Card>
                    <Modal open={editOpen} title="Edit Hardware" onClose={() => setEditOpen(false)}>
                      <div className="form-grid">
                        <label>CPU Cores <input type="number" defaultValue={vm.cpuCores} id="hardware-cpu" /></label>
                        <label>RAM MB <input type="number" defaultValue={vm.ramMb} id="hardware-ram" /></label>
                        <label>CD/DVD <input defaultValue={vm.cdrom} id="hardware-cdrom" /></label>
                        <label>Add Disk GB <input type="number" defaultValue={20} id="hardware-add-disk" /></label>
                      </div>
                      <div className="row-gap">
                        <Button onClick={async () => {
                          const cpu = Number((document.getElementById('hardware-cpu') as HTMLInputElement | null)?.value || vm.cpuCores);
                          const ram = Number((document.getElementById('hardware-ram') as HTMLInputElement | null)?.value || vm.ramMb);
                          const cdrom = (document.getElementById('hardware-cdrom') as HTMLInputElement | null)?.value || vm.cdrom;
                          const addDiskGb = Number((document.getElementById('hardware-add-disk') as HTMLInputElement | null)?.value || 0);
                          const patch: Record<string, unknown> = { cpuCores: cpu, ramMb: ram, cdrom };
                          const hadIso = vm.cdrom && vm.cdrom !== 'none';
                          const hasIso = cdrom && cdrom !== 'none';
                          if (hadIso !== Boolean(hasIso)) {
                            if (hasIso) await backendVmApi.attachIso(vm.id, cdrom);
                            else await backendVmApi.detachIso(vm.id);
                          }
                          if (addDiskGb > 0) {
                            patch.disks = [...vm.disks, { id: `d-${Date.now()}`, name: `scsi${vm.disks.length}`, sizeGb: addDiskGb }];
                          }
                          await saveVmPatch(patch, 'Hardware updated');
                          setEditOpen(false);
                        }}>Save</Button>
                      </div>
                    </Modal>
                  </>
                )}

                {tab === 'options' && (
                  <Card title="VM Options">
                    <div className="form-grid">
                      <label>Boot order <input defaultValue={vm.options.bootOrder} id="opt-boot" /></label>
                      <label>Start at boot <input type="checkbox" defaultChecked={vm.options.startAtBoot} id="opt-start-at-boot" /></label>
                      <label>BIOS / UEFI <select defaultValue={vm.options.bios} id="opt-bios"><option>BIOS</option><option>UEFI</option></select></label>
                      <label>Protection <input type="checkbox" defaultChecked={vm.options.protection} id="opt-protection" /></label>
                    </div>
                    <div className="row-gap">
                      <Button onClick={async () => {
                        const nextOptions = {
                          bootOrder: (document.getElementById('opt-boot') as HTMLInputElement).value,
                          startAtBoot: (document.getElementById('opt-start-at-boot') as HTMLInputElement).checked,
                          bios: (document.getElementById('opt-bios') as HTMLSelectElement).value as 'BIOS' | 'UEFI',
                          protection: (document.getElementById('opt-protection') as HTMLInputElement).checked
                        };
                        await saveVmPatch({ options: nextOptions }, 'Options updated');
                      }}>Save Options</Button>
                    </div>
                  </Card>
                )}

                {tab === 'cloudinit' && (
                  <Card title="Cloud-Init">
                    <div className="form-grid">
                      <label>User <input defaultValue={vm.cloudInit.user} id="ci-user" /></label>
                      <label>Network <select defaultValue={vm.cloudInit.network} id="ci-network"><option value="dhcp">DHCP</option><option value="static">Static</option></select></label>
                      <label className="span2">SSH Keys <textarea defaultValue={vm.cloudInit.sshKeys} rows={4} id="ci-ssh" /></label>
                      <label className="span2">Advanced YAML <textarea defaultValue={vm.cloudInit.yaml} rows={8} id="ci-yaml" /></label>
                    </div>
                    <div className="row-gap">
                      <Button onClick={async () => {
                        const nextCloudInit = {
                          user: (document.getElementById('ci-user') as HTMLInputElement).value,
                          network: (document.getElementById('ci-network') as HTMLSelectElement).value as 'dhcp' | 'static',
                          sshKeys: (document.getElementById('ci-ssh') as HTMLTextAreaElement).value,
                          yaml: (document.getElementById('ci-yaml') as HTMLTextAreaElement).value
                        };
                        await saveVmPatch({ cloudInit: nextCloudInit }, 'Cloud-Init updated');
                      }}>Save Cloud-Init</Button>
                    </div>
                  </Card>
                )}

                {tab === 'snapshots' && (
                  <Card title="Snapshots">
                    <div className="row-gap">
                      <input value={snapshotName} onChange={(e) => setSnapshotName(e.target.value)} placeholder="snapshot name" />
                      <Button loading={createSnapshotMutation.isPending} onClick={() => createSnapshotMutation.mutate()}>Create Snapshot</Button>
                    </div>
                    <Table rows={vm.snapshots} columns={[
                      { key: 'name', label: 'Name' },
                      { key: 'createdAt', label: 'Created' },
                      {
                        key: 'actions',
                        label: 'Actions',
                        render: (row) => <div className="row-gap"><Button onClick={async () => { await backendVmApi.rollbackSnapshot(vm.id, row.id); queryClient.invalidateQueries({ queryKey: ['vm', vm.id] }); pushToast({ kind: 'success', title: 'Rollback complete', message: `${row.name} restored.` }); }}>Rollback</Button><Button variant="danger" onClick={async () => { await backendVmApi.removeSnapshot(vm.id, row.id); queryClient.invalidateQueries({ queryKey: ['vm', vm.id] }); pushToast({ kind: 'success', title: 'Snapshot delete queued', message: `${row.name} remove requested.` }); }}>Delete</Button></div>
                      }
                    ]} />
                  </Card>
                )}

                {tab === 'backup' && (
                  <Card title="Backup">
                    <div className="row-gap"><Button loading={backupMutation.isPending} onClick={() => backupMutation.mutate()}>Run Manual Backup</Button></div>
                    <Table rows={vm.backups} columns={[
                      { key: 'name', label: 'Backup' },
                      { key: 'createdAt', label: 'Created' },
                      { key: 'size', label: 'Size' },
                      {
                        key: 'restore',
                        label: 'Action',
                        render: (row) => <Button onClick={async () => {
                          await backendVmApi.restoreBackup(vm.id, row.id);
                          queryClient.invalidateQueries({ queryKey: ['vm', vm.id] });
                          pushToast({ kind: 'success', title: 'Restore queued', message: `${row.name} restore requested.` });
                        }}>Restore</Button>
                      }
                    ]} />
                  </Card>
                )}

                {tab === 'firewall' && (
                  <Card title="Firewall">
                    <div className="row-gap">
                      <label className="row-gap"><input type="checkbox" checked={vm.firewallEnabled} onChange={async (e) => {
                        await saveVmPatch({ firewallEnabled: e.target.checked }, `Firewall ${e.target.checked ? 'enabled' : 'disabled'}`);
                      }} /> Enable Firewall</label>
                      <Button icon={<Shield size={14} />} onClick={() => setRuleOpen(true)}>Add Rule</Button>
                    </div>
                    <Table rows={vm.firewallRules} columns={[
                      { key: 'direction', label: 'Dir' },
                      { key: 'action', label: 'Action' },
                      { key: 'source', label: 'Source' },
                      { key: 'destination', label: 'Destination' },
                      { key: 'port', label: 'Port' },
                      { key: 'drop', label: 'Remove', render: (row) => <Button variant="danger" onClick={async () => {
                        const rules = vm.firewallRules.filter((r) => r.id !== row.id);
                        await saveVmPatch({ firewallRules: rules }, 'Rule removed');
                      }}>Delete</Button> }
                    ]} />
                    <Modal open={ruleOpen} title="Add Firewall Rule" onClose={() => setRuleOpen(false)}>
                      <div className="form-grid">
                        <label>Direction <select value={newRule.direction} onChange={(e) => setNewRule((s) => ({ ...s, direction: e.target.value }))}><option>IN</option><option>OUT</option></select></label>
                        <label>Action <select value={newRule.action} onChange={(e) => setNewRule((s) => ({ ...s, action: e.target.value }))}><option>ACCEPT</option><option>DROP</option></select></label>
                        <label>Source <input value={newRule.source} onChange={(e) => setNewRule((s) => ({ ...s, source: e.target.value }))} /></label>
                        <label>Destination <input value={newRule.destination} onChange={(e) => setNewRule((s) => ({ ...s, destination: e.target.value }))} /></label>
                        <label>Port <input value={newRule.port} onChange={(e) => setNewRule((s) => ({ ...s, port: e.target.value }))} /></label>
                      </div>
                      <div className="row-gap"><Button onClick={async () => {
                        const rules = [...vm.firewallRules, { id: `f-${Date.now()}`, ...newRule, direction: newRule.direction as 'IN' | 'OUT', action: newRule.action as 'ACCEPT' | 'DROP' }];
                        await saveVmPatch({ firewallRules: rules }, 'Rule added');
                        setRuleOpen(false);
                      }}>Save</Button></div>
                    </Modal>
                  </Card>
                )}

                {tab === 'permissions' && (
                  <Card title="Permissions">
                    <Table rows={vm.permissions} columns={[
                      { key: 'user', label: 'User' },
                      {
                        key: 'role',
                        label: 'Role',
                        render: (row) => (
                          <select
                            value={row.role}
                            onChange={async (e) => {
                              const updated = vm.permissions.map((p) => p.id === row.id ? { ...p, role: e.target.value } : p);
                              await saveVmPatch({ permissions: updated }, 'Permission updated');
                            }}
                          >
                            <option>VM.Admin</option>
                            <option>VM.Operator</option>
                            <option>VM.Audit</option>
                          </select>
                        )
                      }
                    ]} />
                  </Card>
                )}

                {tab === 'monitoring' && (
                  <div className="grid-2">
                    {['cpu', 'ram', 'diskIo', 'net'].map((k) => (
                      <Card key={k} title={k.toUpperCase()}>
                        <ResponsiveContainer width="100%" height={180}>
                          <AreaChart data={metricsQuery.data || []}>
                            <CartesianGrid strokeDasharray="3 3" />
                            <XAxis dataKey="time" />
                            <YAxis />
                            <Tooltip />
                            <Area type="monotone" dataKey={k} stroke="#2563eb" fill="#93c5fd" fillOpacity={0.4} />
                          </AreaChart>
                        </ResponsiveContainer>
                      </Card>
                    ))}
                  </div>
                )}

                {tab === 'tasks' && (
                  <div className="grid-2">
                    <Card title="Recent Tasks">
                      <Table rows={vm.tasks} columns={[{ key: 'action', label: 'Action' }, { key: 'status', label: 'Status', render: (row) => <span className={`badge ${row.status}`}>{row.status}</span> }, { key: 'timestamp', label: 'Timestamp' }]} />
                    </Card>
                    <Card title="Timeline (Tasks + Snapshots)">
                      <ul className="timeline">
                        {timeline.map((item) => <li key={item.id}><span>{item.type.toUpperCase()}</span><strong>{item.label}</strong><small>{item.at}</small></li>)}
                      </ul>
                    </Card>
                  </div>
                )}

                <Card title="VM Operation Logs">
                  <Table
                    rows={vmOperationsQuery.data || []}
                    columns={[
                      { key: 'id', label: '#' },
                      { key: 'action', label: 'Action' },
                      {
                        key: 'status',
                        label: 'Status',
                        render: (row) => (
                          <span className={`badge ${row.status === 'success' ? 'success' : row.status === 'failed' ? 'failed' : row.status === 'running' ? 'running' : 'stopped'}`}>
                            {row.status}
                          </span>
                        )
                      },
                      {
                        key: 'message',
                        label: 'Message',
                        render: (row) => row.error_message ? `Error: ${row.error_message}` : `${row.action} ${row.status}`
                      },
                      {
                        key: 'time',
                        label: 'Time',
                        render: (row) => String(row.finished_at || row.started_at || row.created_at || '-')
                      }
                    ]}
                  />
                </Card>
              </>
            )}
          </>
        )}

        <Modal open={createVmOpen} title="Create New VM" onClose={() => setCreateVmOpen(false)}>
          <div className="wizard-steps">
            {createSteps.map((stepName, idx) => (
              <button
                key={stepName}
                className={`wizard-step ${createStep === idx ? 'active' : ''} ${createStepHasError(idx) ? 'error' : ''}`}
                onClick={() => setCreateStep(idx)}
                type="button"
              >
                <span>{idx + 1}</span>{stepName}
              </button>
            ))}
          </div>

          {createStep === 0 && (
            <div className="form-grid">
              <label>VM ID <input value={createVmForm.id} onChange={(e) => setCreateVmForm((s) => ({ ...s, id: e.target.value.replace(/[^\d]/g, '') }))} /></label>
              <label>Name <input value={createVmForm.name} onChange={(e) => setCreateVmForm((s) => ({ ...s, name: e.target.value }))} /></label>
              <label>Node <input value={createVmForm.node} onChange={(e) => setCreateVmForm((s) => ({ ...s, node: e.target.value }))} /></label>
              <label>OS Family
                <select value={createVmForm.osFamily} onChange={(e) => setCreateVmForm((s) => ({ ...s, osFamily: e.target.value as CreateVmForm['osFamily'] }))}>
                  <option value="linux">Linux</option>
                  <option value="windows">Windows</option>
                  <option value="other">Other</option>
                </select>
              </label>
              <label className="span2">OS Version
                <input value={createVmForm.osVersion} onChange={(e) => setCreateVmForm((s) => ({ ...s, osVersion: e.target.value }))} />
              </label>
            </div>
          )}

          {createStep === 1 && (
            <div className="form-grid">
              <label>Sockets
                <input type="number" min={1} value={createVmForm.cpuSockets} onChange={(e) => setCreateVmForm((s) => ({ ...s, cpuSockets: Number(e.target.value) || 1 }))} />
              </label>
              <label>Cores per Socket
                <input type="number" min={1} value={createVmForm.cpuCores} onChange={(e) => setCreateVmForm((s) => ({ ...s, cpuCores: Number(e.target.value) || 1 }))} />
              </label>
              <label>Memory (MB)
                <input type="number" min={512} step={256} value={createVmForm.memoryMb} onChange={(e) => setCreateVmForm((s) => ({ ...s, memoryMb: Number(e.target.value) || 512 }))} />
              </label>
              <label>Timezone
                <input value={createVmForm.timezone} onChange={(e) => setCreateVmForm((s) => ({ ...s, timezone: e.target.value }))} />
              </label>
            </div>
          )}

          {createStep === 2 && (
            <div className="form-grid">
              <label>Disk Size (GB)
                <input type="number" min={8} value={createVmForm.diskGb} onChange={(e) => setCreateVmForm((s) => ({ ...s, diskGb: Number(e.target.value) || 8 }))} />
              </label>
              <label>Disk Bus
                <select value={createVmForm.diskBus} onChange={(e) => setCreateVmForm((s) => ({ ...s, diskBus: e.target.value as CreateVmForm['diskBus'] }))}>
                  <option value="scsi">SCSI (recommended)</option>
                  <option value="virtio">VirtIO</option>
                  <option value="sata">SATA</option>
                </select>
              </label>
              <label>Network Mode
                <select value={createVmForm.networkMode} onChange={(e) => setCreateVmForm((s) => ({ ...s, networkMode: e.target.value as CreateVmForm['networkMode'] }))}>
                  <option value="bridge">Bridge</option>
                  <option value="nat">NAT</option>
                  <option value="private">Private</option>
                </select>
              </label>
              <label>Network Source
                <input value={createVmForm.networkSource} onChange={(e) => setCreateVmForm((s) => ({ ...s, networkSource: e.target.value }))} placeholder={createVmForm.networkMode === 'bridge' ? 'vmbr0' : 'default'} />
              </label>
              <label>NIC Model
                <select value={createVmForm.nicModel} onChange={(e) => setCreateVmForm((s) => ({ ...s, nicModel: e.target.value as CreateVmForm['nicModel'] }))}>
                  <option value="virtio">VirtIO (recommended)</option>
                  <option value="e1000">e1000</option>
                  <option value="vmxnet3">vmxnet3</option>
                </select>
              </label>
              <label>Boot ISO (optional)
                <select value={createVmForm.isoPath} onChange={(e) => setCreateVmForm((s) => ({ ...s, isoPath: e.target.value }))}>
                  <option value="">No ISO</option>
                  {(isoLibraryQuery.data || []).map((iso) => <option key={iso.path} value={iso.path}>{iso.name}</option>)}
                </select>
              </label>
              <label>Cloud-Init User
                <input value={createVmForm.cloudInitUser} onChange={(e) => setCreateVmForm((s) => ({ ...s, cloudInitUser: e.target.value }))} />
              </label>
              <label>IP Assignment
                <select value={createVmForm.cloudInitNetwork} onChange={(e) => setCreateVmForm((s) => ({ ...s, cloudInitNetwork: e.target.value as CreateVmForm['cloudInitNetwork'] }))}>
                  <option value="dhcp">DHCP</option>
                  <option value="static">Static</option>
                </select>
              </label>

              {createVmForm.cloudInitNetwork === 'static' && (
                <>
                  <label>Static IP/CIDR
                    <input value={createVmForm.staticIp} onChange={(e) => setCreateVmForm((s) => ({ ...s, staticIp: e.target.value }))} placeholder="10.0.0.50/24" />
                  </label>
                  <label>Gateway
                    <input value={createVmForm.gateway} onChange={(e) => setCreateVmForm((s) => ({ ...s, gateway: e.target.value }))} placeholder="10.0.0.1" />
                  </label>
                </>
              )}

              <label>DNS
                <input value={createVmForm.dns} onChange={(e) => setCreateVmForm((s) => ({ ...s, dns: e.target.value }))} />
              </label>

              <label>VLAN ID (optional)
                <input value={createVmForm.vlanId} onChange={(e) => setCreateVmForm((s) => ({ ...s, vlanId: e.target.value }))} />
              </label>

              <div className="span2 row-gap">
                <Button variant="ghost" onClick={() => setShowAdvancedCreate((v) => !v)}>
                  {showAdvancedCreate ? 'Hide Advanced' : 'Show Advanced'}
                </Button>
                <span className="muted">Only essential fields are shown by default.</span>
              </div>

              {showAdvancedCreate && (
                <div className="span2 create-check-grid">
                  <label className="check-line"><input type="checkbox" checked={createVmForm.startAtBoot} onChange={(e) => setCreateVmForm((s) => ({ ...s, startAtBoot: e.target.checked }))} /> Start at boot</label>
                  <label className="check-line"><input type="checkbox" checked={createVmForm.firewallEnabled} onChange={(e) => setCreateVmForm((s) => ({ ...s, firewallEnabled: e.target.checked }))} /> Enable default firewall</label>
                  <label className="check-line"><input type="checkbox" checked={createVmForm.snapshotOnCreate} onChange={(e) => setCreateVmForm((s) => ({ ...s, snapshotOnCreate: e.target.checked }))} /> Take initial snapshot after create</label>
                </div>
              )}
            </div>
          )}

          {createStep === 3 && (
            <div className="create-review">
              <div><span>VM</span><strong>{createVmForm.name} (ID {createVmForm.id || '-'})</strong></div>
              <div><span>Node</span><strong>{createVmForm.node}</strong></div>
              <div><span>OS</span><strong>{createVmForm.osFamily} / {createVmForm.osVersion}</strong></div>
              <div><span>Compute</span><strong>{createVmForm.cpuSockets} socket × {createVmForm.cpuCores} core, {createVmForm.memoryMb} MB RAM</strong></div>
              <div><span>Storage</span><strong>{createVmForm.diskGb} GB {createVmForm.diskBus.toUpperCase()}</strong></div>
              <div><span>Network</span><strong>{createVmForm.networkMode.toUpperCase()} on {createVmForm.networkSource || 'default'} ({createVmForm.nicModel})</strong></div>
              <div><span>Boot ISO</span><strong>{createVmForm.isoPath || 'none'}</strong></div>
              <div><span>Cloud-Init</span><strong>{createVmForm.cloudInitUser} / {createVmForm.cloudInitNetwork.toUpperCase()}</strong></div>
              <div><span>Policy</span><strong>{createVmForm.startAtBoot ? 'Start at boot' : 'Manual start'} • {createVmForm.firewallEnabled ? 'Firewall on' : 'Firewall off'}</strong></div>
              {createValidationErrors.length > 0 && (
                <div className="create-errors">
                  {createValidationErrors.map((msg) => <p key={msg}>{msg}</p>)}
                </div>
              )}
            </div>
          )}

          <div className="row-gap">
            <Button variant="ghost" disabled={createStep === 0} onClick={() => setCreateStep((s) => Math.max(0, s - 1))}>Back</Button>
            {createStep < createSteps.length - 1 ? (
              <Button onClick={() => setCreateStep((s) => Math.min(createSteps.length - 1, s + 1))}>Next</Button>
            ) : (
              <Button loading={createVmMutation.isPending} disabled={createValidationErrors.length > 0} onClick={() => createVmMutation.mutate()}>
                Create VM
              </Button>
            )}
          </div>
        </Modal>
      </main>

      <ToastViewport />
    </div>
  );
}
