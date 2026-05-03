import { useEffect, useMemo, useState, useRef } from 'react';
import { Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Activity, ArrowUpDown, Copy, HardDrive, LayoutDashboard, Monitor, Play, Power, RotateCcw, Server, Shield, Trash2, Camera, Terminal, PowerOff, Rocket, PauseCircle, PlusCircle, Cpu, MemoryStick, Network } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useIsoLibraryQuery, useSystemMetricsQuery, useSystemUsageQuery, useVmMetricsQuery, useVmDetailQuery, useVmOperationsQuery, useVmsQuery } from '../hooks/useVmQueries';
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
import { VmCreateDrawer } from '../components/vm/VmCreateDrawer';

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



type SidebarView = 'dashboard' | 'resources' | 'images';

export function VmDetailPage() {
  const [tab, setTab] = useState('summary');
  const [sidebarView, setSidebarView] = useState<SidebarView>('dashboard');
  const [editOpen, setEditOpen] = useState(false);
  const [ruleOpen, setRuleOpen] = useState(false);
  const [createVmOpen, setCreateVmOpen] = useState(false);
  const [fullConsole, setFullConsole] = useState(false);
  const [captureKeyboard, setCaptureKeyboard] = useState(false);
  const consoleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setFullConsole(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await consoleRef.current?.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch (err) {
      console.warn('Fullscreen request failed', err);
    }
  };
  const [snapshotName, setSnapshotName] = useState('quick-snap');
  const [newTag, setNewTag] = useState('');
  const [newRule, setNewRule] = useState({ direction: 'IN', action: 'ACCEPT', source: '0.0.0.0/0', destination: '10.0.0.10', port: '443' });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [storagePools, setStoragePools] = useState<Array<{ name: string; state: string }>>([]);
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
  const systemMetricsQuery = useSystemMetricsQuery();
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
    return (systemMetricsQuery.data || []).map((m) => ({
      created_at: m.created_at,
      cpu: Number(m.cpu_usage_pct || 0),
      ram: Number(m.ram_usage_pct || 0),
      load: Number(m.load_avg_1m || 0),
      net_rx_mbps: (Number(m.net_rx_bytes_sec || 0) * 8) / 1_000_000,
      net_tx_mbps: (Number(m.net_tx_bytes_sec || 0) * 8) / 1_000_000
    }));
  }, [systemMetricsQuery.data]);

  const vmMetricSeries = useMemo(() => {
    return (metricsQuery.data || []).map((m) => ({
      created_at: m.created_at,
      cpu: Number(m.cpu_usage_pct || 0),
      ram: Number(m.ram_usage_pct || 0),
      disk_iops: Number(m.disk_iops || 0),
      net_rx_mbps: (Number(m.net_rx_bytes_sec || 0) * 8) / 1_000_000,
      net_tx_mbps: (Number(m.net_tx_bytes_sec || 0) * 8) / 1_000_000
    }));
  }, [metricsQuery.data]);

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

  // Reset delete confirmation when VM changes
  useEffect(() => { setConfirmDelete(false); }, [selectedVmId]);

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

  const isTaskRunning = useMemo(() => {
    if (!vm) return false;
    return vm.tasks.some(t => t.status === 'running' && ['start', 'stop', 'purge', 'reboot'].includes(t.action));
  }, [vm]);

  const canStart = vm?.status === 'stopped' && !isTaskRunning;
  const canStop = vm?.status === 'running' && !isTaskRunning;
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
    const params = new URLSearchParams({ tenant, token, vm_id: vm.id, resize: 'scale' });
    return `/novnc.html?${params.toString()}`;
  }, [vm]);

  const openCreateWizard = () => {
    setCreateVmOpen(true);
  };

  useEffect(() => {
    backendVmApi.getStoragePools()
      .then((rows) => {
        setStoragePools(rows.map((r) => ({ name: r.name, state: r.state })));
      })
      .catch(() => {
        setStoragePools([{ name: 'default', state: 'active' }]);
      });
  }, []);

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
            <Server size={14} /> VM
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
                    <XAxis dataKey="created_at" tickFormatter={(time) => new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} />
                    <YAxis tickFormatter={(val) => `${val}%`} />
                    <Tooltip formatter={(value: any) => `${Number(value).toFixed(1)}%`} labelFormatter={(label) => new Date(label).toLocaleString()} />
                    <Legend verticalAlign="top" height={36} />
                    <Area type="monotone" dataKey="cpu" name="CPU Load" stroke="#2563eb" fill="#93c5fd" fillOpacity={0.45} />
                    <Area type="monotone" dataKey="ram" name="RAM Usage" stroke="#22c55e" fill="#86efac" fillOpacity={0.3} />
                  </AreaChart>
                </ResponsiveContainer>
              </Card>

              <Card title="Host Network Activity">
                <ResponsiveContainer width="100%" height={230}>
                  <AreaChart data={dashboardSeries}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="created_at" tickFormatter={(time) => new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} />
                    <YAxis tickFormatter={(val) => `${Number(val).toFixed(1)} Mbps`} />
                    <Tooltip formatter={(value: any) => `${Number(value).toFixed(2)} Mbps`} labelFormatter={(label) => new Date(label).toLocaleString()} />
                    <Legend verticalAlign="top" height={36} />
                    <Area type="monotone" dataKey="net_rx_mbps" name="RX (Download)" stroke="#8b5cf6" fill="#c4b5fd" fillOpacity={0.4} />
                    <Area type="monotone" dataKey="net_tx_mbps" name="TX (Upload)" stroke="#f59e0b" fill="#fde68a" fillOpacity={0.35} />
                  </AreaChart>
                </ResponsiveContainer>
              </Card>
            </div>

            <div className="grid-2">
              <Card title="Live Statistics">
                <div className="stats-grid">
                  <div><span>CPU Load</span><strong>{(dashboardSeries.at(-1)?.cpu ?? 0).toFixed(1)}%</strong></div>
                  <div><span>RAM Usage</span><strong>{(dashboardSeries.at(-1)?.ram ?? 0).toFixed(1)}%</strong></div>
                  <div><span>Load Avg (1m)</span><strong>{(dashboardSeries.at(-1)?.load ?? 0).toFixed(3)}</strong></div>
                  <div><span>Network Traffic</span><strong>{((dashboardSeries.at(-1)?.net_rx_mbps ?? 0) + (dashboardSeries.at(-1)?.net_tx_mbps ?? 0)).toFixed(2)} Mbps</strong></div>
                </div>
              </Card>

              <Card title="Host Load Average (1m)">
                <ResponsiveContainer width="100%" height={230}>
                  <AreaChart data={dashboardSeries}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="created_at" tickFormatter={(time) => new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} />
                    <YAxis />
                    <Tooltip formatter={(value: any) => Number(value).toFixed(3)} labelFormatter={(label) => new Date(label).toLocaleString()} />
                    <Legend verticalAlign="top" height={36} />
                    <Area type="monotone" dataKey="load" name="Load Avg (1m)" stroke="#7c3aed" fill="#c4b5fd" fillOpacity={0.35} />
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
            {vm ? (
              <div className="vm-hero">
                <div className="vm-hero-info">
                  <h1><Server size={22} color="#1d4ed8" /> {vm.name}</h1>
                  <div className="vm-hero-meta">
                    <span><strong>ID:</strong> {vm.id}</span>
                    <span><strong>Node:</strong> {vm.node}</span>
                    <span><strong>Status:</strong> <strong className={`badge ${vm.status}`}>{vm.status.toUpperCase()}</strong></span>
                    <span><strong>Uptime:</strong> {vm.uptime}</span>
                    <span><strong>IP:</strong> {vm.guestAgent?.addresses?.find((a: any) => a.protocol === 'ipv4')?.address || 'N/A'}</span>
                  </div>
                </div>
                <div className="actions">
                  <Button icon={<Play size={14} />} loading={start.isPending || actionLoading.start} disabled={!canStart} onClick={() => start.mutate()}>Start</Button>
                  <Button icon={<Power size={14} />} loading={stop.isPending || actionLoading.stop} disabled={!canStop} onClick={() => stop.mutate()}>Stop</Button>
                  <Button icon={<RotateCcw size={14} />} loading={reboot.isPending || actionLoading.reboot} disabled={!canStop} onClick={() => reboot.mutate()}>Reboot</Button>
                  <Button icon={<PowerOff size={14} />} loading={shutdown.isPending || actionLoading.shutdown} disabled={!canStop} onClick={() => shutdown.mutate()}>Shutdown</Button>
                  <Button icon={<Terminal size={14} />} disabled={!vm} onClick={() => setTab('console')}>Console</Button>
                  <Button icon={<Camera size={14} />} loading={quickSnap.isPending || actionLoading.snapshot} disabled={!vm} onClick={() => quickSnap.mutate()}>Snapshot</Button>
                  {confirmDelete ? (
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <Button variant="danger" loading={remove.isPending || actionLoading.delete} onClick={() => remove.mutate(undefined, { onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['vms'] }); setPrimaryVm(null); } })}>Confirm</Button>
                      <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
                    </div>
                  ) : (
                    <Button icon={<Trash2 size={14} />} variant="danger" disabled={!vm} onClick={() => setConfirmDelete(true)}>Delete</Button>
                  )}
                  <Button icon={<PlusCircle size={14} />} onClick={openCreateWizard}>New VM</Button>
                </div>
              </div>
            ) : (
              <div className="sticky-actions" style={{ justifyContent: 'flex-end', paddingBottom: '16px' }}>
                <Button icon={<PlusCircle size={15} />} onClick={openCreateWizard}>New VM</Button>
              </div>
            )}
            {!vm && vmCount > 0 && <Card><Skeleton className="h-24" /></Card>}

            {!vm && vmCount === 0 && (
              <Card title="No virtual machines yet">
                <div className="empty-state" style={{ textAlign: 'center', padding: '40px' }}>
                  <Activity size={32} style={{ color: '#94a3b8', marginBottom: '16px' }} />
                  <p style={{ color: '#475569', marginBottom: '24px' }}>Create your first VM to unlock console, snapshots, backup, monitoring and full lifecycle actions.</p>
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
                  <div className="stack">
                    <div className="cards">
                      <div className="card"><h3 style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><Cpu size={16} /> CPU</h3><p>{vm.cpuCores} vCPU</p></div>
                      <div className="card"><h3 style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><MemoryStick size={16} /> Memory</h3><p>{vm.ramMb} MB</p></div>
                      <div className="card"><h3 style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><HardDrive size={16} /> Total Disk</h3><p>{vm.disks.reduce((a: any, b: any) => a + b.sizeGb, 0)} GB</p></div>
                      <div className="card"><h3 style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><Network size={16} /> Network</h3><p>{vm.nics.length} NICs</p></div>
                    </div>
                    <div className="grid-2">
                      <Card title="CPU / RAM Usage">
                        {metricsQuery.isLoading ? <Skeleton className="h-56" /> : (
                          <ResponsiveContainer width="100%" height={220}>
                            <AreaChart data={vmMetricSeries}>
                              <defs><linearGradient id="cpu" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#3b82f6" stopOpacity={0.8}/><stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/></linearGradient></defs>
                              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                              <XAxis dataKey="created_at" tickFormatter={(time) => new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} stroke="#6b7280" fontSize={11} />
                              <YAxis domain={[0, 100]} tickFormatter={(val) => `${val}%`} stroke="#6b7280" fontSize={11} width={45} />
                              <Tooltip formatter={(value: any) => `${Number(value).toFixed(1)}%`} labelFormatter={(label) => new Date(label).toLocaleString()} />
                              <Legend verticalAlign="top" height={36} iconType="circle" />
                              <Area type="monotone" dataKey="cpu" name="CPU" stroke="#3b82f6" strokeWidth={2} fillOpacity={1} fill="url(#cpu)" isAnimationActive={false} />
                              <Area type="monotone" dataKey="ram" name="RAM" stroke="#22c55e" strokeWidth={2} fillOpacity={0.3} fill="#86efac" isAnimationActive={false} />
                            </AreaChart>
                          </ResponsiveContainer>
                        )}
                      </Card>
                      <Card title="Network Activity">
                        {metricsQuery.isLoading ? <Skeleton className="h-56" /> : (
                          <ResponsiveContainer width="100%" height={220}>
                            <AreaChart data={vmMetricSeries}>
                              <defs><linearGradient id="net_rx" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.8}/><stop offset="95%" stopColor="#8b5cf6" stopOpacity={0}/></linearGradient></defs>
                              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                              <XAxis dataKey="created_at" tickFormatter={(time) => new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} stroke="#6b7280" fontSize={11} />
                              <YAxis tickFormatter={(val) => `${Number(val).toFixed(1)} Mbps`} stroke="#6b7280" fontSize={11} width={65} />
                              <Tooltip formatter={(value: any) => `${Number(value).toFixed(2)} Mbps`} labelFormatter={(label) => new Date(label).toLocaleString()} />
                              <Legend verticalAlign="top" height={36} iconType="circle" />
                              <Area type="monotone" dataKey="net_rx_mbps" name="RX (Download)" stroke="#8b5cf6" strokeWidth={2} fillOpacity={1} fill="url(#net_rx)" isAnimationActive={false} />
                              <Area type="monotone" dataKey="net_tx_mbps" name="TX (Upload)" stroke="#f59e0b" strokeWidth={2} fillOpacity={0.3} fill="#fde68a" isAnimationActive={false} />
                            </AreaChart>
                          </ResponsiveContainer>
                        )}
                      </Card>
                    </div>
                    <div className="grid-2">
                      <Card title="Disk IOPS">
                        {metricsQuery.isLoading ? <Skeleton className="h-56" /> : (
                          <ResponsiveContainer width="100%" height={220}>
                            <AreaChart data={vmMetricSeries}>
                              <defs><linearGradient id="disk" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#ec4899" stopOpacity={0.8}/><stop offset="95%" stopColor="#ec4899" stopOpacity={0}/></linearGradient></defs>
                              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                              <XAxis dataKey="created_at" tickFormatter={(time) => new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} stroke="#6b7280" fontSize={11} />
                              <YAxis tickFormatter={(val) => `${Number(val)}`} stroke="#6b7280" fontSize={11} width={45} />
                              <Tooltip formatter={(value: any) => `${Number(value).toFixed(0)} IOPS`} labelFormatter={(label) => new Date(label).toLocaleString()} />
                              <Legend verticalAlign="top" height={36} iconType="circle" />
                              <Area type="monotone" dataKey="disk_iops" name="Total IOPS" stroke="#ec4899" strokeWidth={2} fillOpacity={1} fill="url(#disk)" isAnimationActive={false} />
                            </AreaChart>
                          </ResponsiveContainer>
                        )}
                      </Card>
                      <Card title="Live Statistics">
                        <div className="stats-grid">
                          <div><span>CPU Load</span><strong>{(vmMetricSeries.at(-1)?.cpu ?? 0).toFixed(1)}%</strong></div>
                          <div><span>RAM Usage</span><strong>{(vmMetricSeries.at(-1)?.ram ?? 0).toFixed(1)}%</strong></div>
                          <div><span>Disk IOPS</span><strong>{(vmMetricSeries.at(-1)?.disk_iops ?? 0).toFixed(0)} IOPS</strong></div>
                          <div><span>Network Traffic</span><strong>{((vmMetricSeries.at(-1)?.net_rx_mbps ?? 0) + (vmMetricSeries.at(-1)?.net_tx_mbps ?? 0)).toFixed(2)} Mbps</strong></div>
                        </div>
                      </Card>
                    </div>
                  </div>
                )}

                {tab === 'console' && (
                  <Card title="Console">
                    <div ref={consoleRef} className={`console-placeholder ${fullConsole ? 'full' : ''}`} style={fullConsole ? { background: '#000', display: 'flex', flexDirection: 'column', height: '100vh' } : {}}>
                      <div className="console-top">
                        <Button icon={<Monitor size={14} />} onClick={toggleFullscreen}>{fullConsole ? 'Exit Fullscreen' : 'Fullscreen'}</Button>
                        <Button icon={<PauseCircle size={14} />} onClick={() => setCaptureKeyboard((s) => !s)}>{captureKeyboard ? 'Release Keyboard' : 'Capture Keyboard'}</Button>
                      </div>
                      <div className="console-body console-embed" style={fullConsole ? { flex: 1, minHeight: 'auto' } : {}}>
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

        <VmCreateDrawer open={createVmOpen} onClose={() => setCreateVmOpen(false)} isoLibrary={isoLibraryQuery.data || []} storagePools={storagePools} />
      </main>

      <ToastViewport />
    </div>
  );
}
