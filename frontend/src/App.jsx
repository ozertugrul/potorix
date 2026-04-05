import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const DEV_AUTH_DEFAULTS = Object.freeze({ tenant: 'tenant-a', token: 'dev-admin-key' });
const AUTH_STORAGE_KEYS = Object.freeze({ tenant: 'potorix.auth.tenant', token: 'potorix.auth.token' });

const NAV_ITEMS = [
  ['dashboard', 'Dashboard'],
  ['vms', 'VMs'],
  ['snapshots', 'Snapshots'],
  ['jobs', 'Jobs'],
  ['audits', 'Audit Logs'],
  ['marketplace', 'Marketplace'],
  ['backups', 'Backups'],
  ['agents', 'Agents']
];

const VM_TABS = [
  ['summary', 'Summary'],
  ['console', 'Console'],
  ['hardware', 'Hardware'],
  ['storage', 'Storage / ISO'],
  ['tasks', 'Tasks'],
  ['create', 'Create VM']
];

function cls(...items) {
  return items.filter(Boolean).join(' ');
}

function toLocale(value) {
  if (!value) return '-';
  try {
    return new Date(value).toLocaleString('tr-TR');
  } catch (_e) {
    return String(value);
  }
}

function Chip({ value }) {
  const status = String(value || 'unknown').toLowerCase();
  return <span className={cls('chip', status)}>{value || '-'}</span>;
}

function DataTable({ columns, rows }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>{columns.map((col) => <th key={col.key}>{col.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={columns.length}>No data</td></tr>
          ) : rows.map((row, idx) => (
            <tr key={row.id || row.name || idx}>
              {columns.map((col) => (
                <td key={col.key}>{col.render ? col.render(row[col.key], row) : (row[col.key] ?? '-')}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function useAuth() {
  const [tenant, setTenant] = useState(DEV_AUTH_DEFAULTS.tenant);
  const [token, setToken] = useState(DEV_AUTH_DEFAULTS.token);

  useEffect(() => {
    try {
      const storedTenant = localStorage.getItem(AUTH_STORAGE_KEYS.tenant) || '';
      const storedToken = localStorage.getItem(AUTH_STORAGE_KEYS.token) || '';
      setTenant(storedTenant.trim() || DEV_AUTH_DEFAULTS.tenant);
      setToken(storedToken.trim() || DEV_AUTH_DEFAULTS.token);
    } catch (_err) {
      setTenant(DEV_AUTH_DEFAULTS.tenant);
      setToken(DEV_AUTH_DEFAULTS.token);
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(AUTH_STORAGE_KEYS.tenant, tenant.trim());
      localStorage.setItem(AUTH_STORAGE_KEYS.token, token.trim());
    } catch (_err) {
      // ignored
    }
  }, [tenant, token]);

  return { tenant, token, setTenant, setToken };
}

function useApi(authRef, onAuthFallback) {
  return useCallback(async (path, options = {}) => {
    const perform = async (tenant, token) => {
      const url = new URL(path, window.location.origin);
      url.searchParams.set('tenant', tenant);
      url.searchParams.set('token', token);
      const res = await fetch(url.toString(), {
        ...options,
        headers: {
          'X-Tenant-ID': tenant,
          'X-API-Key': token,
          ...(options.headers || {})
        }
      });
      const raw = await res.text();
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch (_err) {
        body = { error: raw || 'Invalid response body' };
      }
      return { res, body };
    };

    const firstTenant = authRef.current.tenant.trim() || DEV_AUTH_DEFAULTS.tenant;
    const firstToken = authRef.current.token.trim() || DEV_AUTH_DEFAULTS.token;
    let { res, body } = await perform(firstTenant, firstToken);

    const canFallback = firstTenant !== DEV_AUTH_DEFAULTS.tenant || firstToken !== DEV_AUTH_DEFAULTS.token;
    if ((res.status === 401 || res.status === 403) && canFallback) {
      onAuthFallback(DEV_AUTH_DEFAULTS.tenant, DEV_AUTH_DEFAULTS.token);
      ({ res, body } = await perform(DEV_AUTH_DEFAULTS.tenant, DEV_AUTH_DEFAULTS.token));
    }

    if (!res.ok) throw new Error(body.error || 'API error');
    return body.data;
  }, [authRef, onAuthFallback]);
}

export function App() {
  const [view, setView] = useState((window.location.hash || '#dashboard').slice(1));
  const [vmTab, setVmTab] = useState('summary');
  const [vmSearch, setVmSearch] = useState('');
  const [selectedVm, setSelectedVm] = useState('');
  const [busy, setBusy] = useState(false);
  const [consoleVmId, setConsoleVmId] = useState('');

  const [snapshotName, setSnapshotName] = useState('pre-change');
  const [snapshotVmId, setSnapshotVmId] = useState('');

  const [firstBootIso, setFirstBootIso] = useState('');
  const [isoImportPath, setIsoImportPath] = useState('');
  const [vncInfo, setVncInfo] = useState('VNC info not loaded yet.');

  const [newDiskGb, setNewDiskGb] = useState('20');
  const [reconfigure, setReconfigure] = useState({ vcpus: '', memory_mb: '', disk_gb: '' });
  const [createDraft, setCreateDraft] = useState({ id: '', vcpus: 2, memory_mb: 2048, disk_gb: 20, iso_path: '', network_mode: 'network', network_source: 'default' });

  const [timeline, setTimeline] = useState([]);
  const [toasts, setToasts] = useState([]);
  const [state, setState] = useState({
    vms: [],
    vmDetails: [],
    jobs: [],
    audits: [],
    apps: [],
    backupPolicies: [],
    backupRuns: [],
    agents: [],
    snapshots: [],
    vmSnapshots: [],
    isoLibrary: [],
    systemUsage: {}
  });

  const { tenant, token, setTenant, setToken } = useAuth();
  const authRef = useRef({ tenant: DEV_AUTH_DEFAULTS.tenant, token: DEV_AUTH_DEFAULTS.token });
  const socketRef = useRef(null);
  const refreshInFlightRef = useRef(false);

  useEffect(() => {
    authRef.current = { tenant, token };
  }, [tenant, token]);

  useEffect(() => {
    if (!NAV_ITEMS.some(([key]) => key === view)) setView('dashboard');
  }, [view]);

  useEffect(() => {
    window.history.replaceState({}, '', `#${view}`);
  }, [view]);

  const pushToast = useCallback((kind, title, message) => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    setToasts((prev) => [{ id, kind, title, message }, ...prev].slice(0, 5));
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((x) => x.id !== id));
    }, 4200);
  }, []);

  const api = useApi(authRef, (fallbackTenant, fallbackToken) => {
    setTenant(fallbackTenant);
    setToken(fallbackToken);
  });

  const selectedVmDetail = useMemo(() => state.vmDetails.find((x) => x.id === selectedVm) || null, [state.vmDetails, selectedVm]);
  const running = String(selectedVmDetail?.state || '').toLowerCase().includes('running');

  const filteredVms = useMemo(() => {
    const q = vmSearch.trim().toLowerCase();
    if (!q) return state.vms;
    return state.vms.filter((id) => id.toLowerCase().includes(q));
  }, [state.vms, vmSearch]);

  const vmJobs = useMemo(() => state.jobs.filter((j) => j.target === selectedVm).slice(0, 15), [state.jobs, selectedVm]);
  const vmAudits = useMemo(() => state.audits.filter((a) => a.resource_id === selectedVm).slice(0, 15), [state.audits, selectedVm]);

  const refresh = useCallback(async () => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    try {
      const [vms, vmDetails, jobs, audits, apps, backupPolicies, backupRuns, agents, isoLibrary, systemUsage] = await Promise.all([
        api('/api/v1/vms'),
        api('/api/v1/vms/details'),
        api('/api/v1/jobs?limit=50'),
        api('/api/v1/audit-logs?limit=50'),
        api('/api/v1/marketplace/apps'),
        api('/api/v1/backups/policies'),
        api('/api/v1/backups/runs?limit=50'),
        api('/api/v1/agents'),
        api('/api/v1/iso-library'),
        api('/api/v1/system/usage')
      ]);

      setState((prev) => ({
        ...prev,
        vms,
        vmDetails,
        jobs,
        audits,
        apps,
        backupPolicies,
        backupRuns,
        agents,
        isoLibrary,
        systemUsage
      }));

      if (!selectedVm || !vms.includes(selectedVm)) setSelectedVm(vms[0] || '');
      if (!snapshotVmId || !vms.includes(snapshotVmId)) setSnapshotVmId(vms[0] || '');
    } catch (err) {
      pushToast('error', 'Refresh Failed', err.message);
    } finally {
      refreshInFlightRef.current = false;
    }
  }, [api, pushToast, selectedVm, snapshotVmId]);

  const runAction = useCallback(async (title, callback) => {
    if (busy) return;
    setBusy(true);
    try {
      await callback();
      await refresh();
      pushToast('info', 'Done', `${title} queued.`);
    } catch (err) {
      pushToast('error', 'Action Failed', err.message);
    } finally {
      setBusy(false);
    }
  }, [busy, refresh, pushToast]);

  const connectRealtime = useCallback(() => {
    if (socketRef.current) socketRef.current.close();

    const t = encodeURIComponent((authRef.current.tenant || '').trim() || DEV_AUTH_DEFAULTS.tenant);
    const k = encodeURIComponent((authRef.current.token || '').trim() || DEV_AUTH_DEFAULTS.token);
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${window.location.host}/ws?tenant=${t}&token=${k}`);

    ws.onmessage = (raw) => {
      const event = JSON.parse(raw.data);
      const message = event.data?.message || `${event.resource?.type || 'resource'}:${event.resource?.id || '-'} ${event.data?.action || event.event_type}`;
      setTimeline((prev) => [{ at: event.occurred_at, type: event.event_type, severity: event.severity, message }, ...prev].slice(0, 100));

      const ev = String(event.event_type || '').toLowerCase();
      if (ev !== 'ws.connected' && !(ev === 'audit.logged' && String(event.data?.status || '').toLowerCase() === 'queued')) {
        pushToast(event.severity === 'error' ? 'error' : 'info', event.event_type, message);
      }
      if (ev.startsWith('job.') || ev.startsWith('audit.')) window.setTimeout(() => refresh(), 220);
    };

    ws.onclose = () => {
      window.setTimeout(() => connectRealtime(), 1500);
    };

    socketRef.current = ws;
  }, [pushToast, refresh]);

  useEffect(() => {
    refresh();
    connectRealtime();
    return () => {
      if (socketRef.current) socketRef.current.close();
    };
  }, [refresh, connectRealtime]);

  useEffect(() => {
    if (!selectedVmDetail) return;
    if (String(selectedVmDetail.state || '').toLowerCase().includes('running')) setConsoleVmId(selectedVm);
  }, [selectedVm, selectedVmDetail]);

  const startVm = () => runAction('Start VM', async () => {
    if (!selectedVm) throw new Error('Select a VM first');
    await api(`/api/v1/vms/${encodeURIComponent(selectedVm)}/start`, { method: 'POST' });
    setConsoleVmId(selectedVm);
    setVmTab('console');
  });

  const stopVm = () => runAction('Stop VM', async () => {
    if (!selectedVm) throw new Error('Select a VM first');
    await api(`/api/v1/vms/${encodeURIComponent(selectedVm)}/stop`, { method: 'POST' });
  });

  const deleteVm = () => runAction('Delete VM', async () => {
    if (!selectedVm) throw new Error('Select a VM first');
    if (!window.confirm(`Delete VM ${selectedVm}? This removes disks too.`)) return;
    await api(`/api/v1/vms/${encodeURIComponent(selectedVm)}`, { method: 'DELETE' });
    setSelectedVm('');
  });

  const createVm = () => runAction('Create VM', async () => {
    const id = createDraft.id.trim();
    if (!id) throw new Error('VM ID is required');

    const payload = {
      id,
      vcpus: Number(createDraft.vcpus),
      memory_mb: Number(createDraft.memory_mb),
      disk_gb: Number(createDraft.disk_gb),
      network_mode: createDraft.network_mode,
      [createDraft.network_mode === 'bridge' ? 'bridge' : 'network']: createDraft.network_source.trim() || 'default'
    };

    if (createDraft.iso_path.trim()) payload.iso_path = createDraft.iso_path.trim();

    await api('/api/v1/vms', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `ui-vm-${id}-${Date.now()}`
      },
      body: JSON.stringify(payload)
    });

    setSelectedVm(id);
  });

  const runBackup = () => runAction('Run Backup', async () => {
    if (!selectedVm) throw new Error('Select a VM first');
    await api('/api/v1/backups/run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `ui-backup-${selectedVm}`
      },
      body: JSON.stringify({ vm_id: selectedVm })
    });
  });

  const listVmSnapshots = () => runAction('List VM Snapshots', async () => {
    if (!selectedVm) throw new Error('Select a VM first');
    const vmSnapshots = await api(`/api/v1/vms/${encodeURIComponent(selectedVm)}/snapshots`);
    setState((prev) => ({ ...prev, vmSnapshots }));
  });

  const createVmSnapshot = () => runAction('Create Snapshot', async () => {
    if (!selectedVm) throw new Error('Select a VM first');
    const name = snapshotName.trim();
    if (!name) throw new Error('Snapshot name is required');
    await api(`/api/v1/vms/${encodeURIComponent(selectedVm)}/snapshots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot_name: name })
    });
  });

  const revertVmSnapshot = () => runAction('Revert Snapshot', async () => {
    if (!selectedVm) throw new Error('Select a VM first');
    const name = snapshotName.trim();
    if (!name) throw new Error('Snapshot name is required');
    await api(`/api/v1/vms/${encodeURIComponent(selectedVm)}/snapshots/${encodeURIComponent(name)}/revert`, { method: 'POST' });
  });

  const setBootPrimary = (primary) => runAction(`Boot ${primary}`, async () => {
    if (!selectedVm) throw new Error('Select a VM first');
    await api(`/api/v1/vms/${encodeURIComponent(selectedVm)}/boot-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ primary })
    });
  });

  const attachIsoOnly = () => runAction('Attach ISO', async () => {
    if (!selectedVm) throw new Error('Select a VM first');
    const isoPath = firstBootIso.trim();
    if (!isoPath) throw new Error('ISO path is required');
    await api(`/api/v1/vms/${encodeURIComponent(selectedVm)}/attach-iso`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ iso_path: isoPath })
    });
  });

  const detachIsoOnly = () => runAction('Detach ISO', async () => {
    if (!selectedVm) throw new Error('Select a VM first');
    await api(`/api/v1/vms/${encodeURIComponent(selectedVm)}/detach-iso`, { method: 'POST' });
  });

  const runFirstBoot = () => runAction('First Boot Flow', async () => {
    if (!selectedVm) throw new Error('Select a VM first');
    const isoPath = firstBootIso.trim();
    if (!isoPath) throw new Error('ISO path is required');

    await api(`/api/v1/vms/${encodeURIComponent(selectedVm)}/attach-iso`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ iso_path: isoPath })
    });

    await api(`/api/v1/vms/${encodeURIComponent(selectedVm)}/boot-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ primary: 'cdrom' })
    });

    await api(`/api/v1/vms/${encodeURIComponent(selectedVm)}/start`, { method: 'POST' });
    setConsoleVmId(selectedVm);
    setVmTab('console');
  });

  const finishInstallFlow = () => runAction('Finalize Install', async () => {
    if (!selectedVm) throw new Error('Select a VM first');
    await api(`/api/v1/vms/${encodeURIComponent(selectedVm)}/detach-iso`, { method: 'POST' });
    await api(`/api/v1/vms/${encodeURIComponent(selectedVm)}/boot-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ primary: 'hd' })
    });
  });

  const importIso = () => runAction('Import ISO', async () => {
    const sourcePath = isoImportPath.trim();
    if (!sourcePath) throw new Error('Source path is required');
    await api('/api/v1/iso-library/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_path: sourcePath })
    });
    setIsoImportPath('');
  });

  const loadVncInfo = () => runAction('Load VNC Info', async () => {
    if (!selectedVm) throw new Error('Select a VM first');
    const data = await api(`/api/v1/vms/${encodeURIComponent(selectedVm)}/vnc`);
    setVncInfo(`VM ${data.vm_id} | ${data.host}:${data.port || '-'} | ${data.display} | ${data.url || '-'}`);
  });

  const applyReconfigure = () => runAction('Apply Offline Reconfigure', async () => {
    if (!selectedVm) throw new Error('Select a VM first');
    if (running) throw new Error('VM must be powered off');

    const payload = {};
    if (reconfigure.vcpus) payload.vcpus = Number(reconfigure.vcpus);
    if (reconfigure.memory_mb) payload.memory_mb = Number(reconfigure.memory_mb);
    if (reconfigure.disk_gb) payload.disk_gb = Number(reconfigure.disk_gb);
    if (Object.keys(payload).length === 0) throw new Error('Enter at least one field');

    await api(`/api/v1/vms/${encodeURIComponent(selectedVm)}/reconfigure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  });

  const addDisk = () => runAction('Add Extra Disk', async () => {
    if (!selectedVm) throw new Error('Select a VM first');
    if (running) throw new Error('VM must be powered off');

    const size = Number(newDiskGb || 0);
    if (!Number.isFinite(size) || size < 1) throw new Error('Disk size must be >= 1 GB');

    await api(`/api/v1/vms/${encodeURIComponent(selectedVm)}/disks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ size_gb: size })
    });
  });

  const openConsole = () => {
    if (!selectedVm) return;
    setConsoleVmId(selectedVm);
    setVmTab('console');
  };

  const installApp = (slug) => runAction(`Install ${slug}`, async () => {
    await api(`/api/v1/marketplace/apps/${slug}/install`, { method: 'POST' });
  });

  const listSnapshots = () => runAction('Load Snapshots', async () => {
    if (!snapshotVmId) throw new Error('Select a VM');
    const snapshots = await api(`/api/v1/vms/${encodeURIComponent(snapshotVmId)}/snapshots`);
    setState((prev) => ({ ...prev, snapshots }));
  });

  const createSnapshot = () => runAction('Create Snapshot', async () => {
    if (!snapshotVmId || !snapshotName.trim()) throw new Error('VM and snapshot name are required');
    await api(`/api/v1/vms/${encodeURIComponent(snapshotVmId)}/snapshots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot_name: snapshotName.trim() })
    });
  });

  const revertSnapshot = () => runAction('Revert Snapshot', async () => {
    if (!snapshotVmId || !snapshotName.trim()) throw new Error('VM and snapshot name are required');
    await api(`/api/v1/vms/${encodeURIComponent(snapshotVmId)}/snapshots/${encodeURIComponent(snapshotName.trim())}/revert`, { method: 'POST' });
  });

  const vmDetailsMap = useMemo(() => {
    const map = new Map();
    state.vmDetails.forEach((vm) => map.set(vm.id, vm));
    return map;
  }, [state.vmDetails]);

  const vmList = (
    <div className="vm-tree">
      <div className="vm-tree-toolbar">
        <input value={vmSearch} onChange={(e) => setVmSearch(e.target.value)} placeholder="Search VM" />
        <button onClick={() => setVmTab('create')}>New VM</button>
      </div>

      {filteredVms.length === 0 ? (
        <div className="empty">No VM matched.</div>
      ) : (
        filteredVms.map((id) => {
          const detail = vmDetailsMap.get(id);
          return (
            <button key={id} className={cls('vm-tree-item', selectedVm === id && 'active')} onClick={() => setSelectedVm(id)}>
              <div className="vm-tree-main">
                <strong>{id}</strong>
                <Chip value={detail?.state} />
              </div>
              <div className="vm-tree-meta">CPU {detail?.vcpus ?? '-'} • RAM {detail?.memory_mb ?? '-'} MB</div>
            </button>
          );
        })
      )}
    </div>
  );

  const vmPage = (
    <section className="stack">
      <div className="vm-workspace">
        <aside className="panel vm-left">{vmList}</aside>

        <div className="panel vm-right">
          <div className="vm-toolbar">
            <div>
              <h3>{selectedVm || 'No VM selected'}</h3>
              <div className="vm-toolbar-sub">
                <Chip value={selectedVmDetail?.state} />
                <span>Boot: {selectedVmDetail?.boot_primary || '-'}</span>
                <span>ISO: {selectedVmDetail?.iso_path || '-'}</span>
              </div>
            </div>

            <div className="actions">
              <button onClick={startVm} disabled={!selectedVm || busy}>Start</button>
              <button onClick={stopVm} disabled={!selectedVm || busy}>Stop</button>
              <button onClick={openConsole} disabled={!selectedVm}>Console</button>
              <button onClick={runBackup} disabled={!selectedVm || busy}>Backup</button>
              <button className="danger" onClick={deleteVm} disabled={!selectedVm || busy}>Delete</button>
            </div>
          </div>

          <div className="tabs vm-tabs">
            {VM_TABS.map(([key, label]) => (
              <button key={key} className={cls(vmTab === key && 'active')} onClick={() => setVmTab(key)}>{label}</button>
            ))}
          </div>

          {vmTab === 'summary' && (
            <div className="stack">
              <div className="cards">
                <div className="card"><h3>Status</h3><p>{selectedVmDetail?.state || '-'}</p></div>
                <div className="card"><h3>vCPU</h3><p>{selectedVmDetail?.vcpus ?? '-'}</p></div>
                <div className="card"><h3>Memory MB</h3><p>{selectedVmDetail?.memory_mb ?? '-'}</p></div>
                <div className="card"><h3>Boot Primary</h3><p>{selectedVmDetail?.boot_primary || '-'}</p></div>
              </div>

              <DataTable
                columns={[{ key: 'k', label: 'Property' }, { key: 'v', label: 'Value' }]}
                rows={[
                  { k: 'Network', v: selectedVmDetail?.network_mode ? `${selectedVmDetail.network_mode}:${selectedVmDetail.network_source}` : '-' },
                  { k: 'Boot Order', v: (selectedVmDetail?.boot_order || []).join(' > ') || '-' },
                  { k: 'ISO Path', v: selectedVmDetail?.iso_path || '-' },
                  { k: 'Disks', v: (selectedVmDetail?.disks || []).map((d) => `${d.target}:${d.source}`).join(' | ') || '-' }
                ]}
              />
            </div>
          )}

          {vmTab === 'console' && (
            <div className="stack">
              <div className="actions">
                <button onClick={loadVncInfo} disabled={!selectedVm || busy}>Load VNC Info</button>
                <span className="muted">{vncInfo}</span>
              </div>
              {!running && <div className="empty">VM is powered off. Start VM first.</div>}
              <iframe
                className="console"
                title="VM Console"
                src={consoleVmId ? `/novnc.html?tenant=${encodeURIComponent(tenant)}&token=${encodeURIComponent(token)}&vm_id=${encodeURIComponent(consoleVmId)}` : '/novnc.html'}
              />
            </div>
          )}

          {vmTab === 'hardware' && (
            <div className="stack">
              <div className="card compact">
                <h3>Offline Reconfigure</h3>
                <p className="muted">Like Proxmox: change resources while VM is shut down.</p>
                <div className="actions">
                  <input type="number" min="1" placeholder="vCPU" value={reconfigure.vcpus} onChange={(e) => setReconfigure((p) => ({ ...p, vcpus: e.target.value }))} />
                  <input type="number" min="256" placeholder="Memory MB" value={reconfigure.memory_mb} onChange={(e) => setReconfigure((p) => ({ ...p, memory_mb: e.target.value }))} />
                  <input type="number" min="5" placeholder="Disk GB" value={reconfigure.disk_gb} onChange={(e) => setReconfigure((p) => ({ ...p, disk_gb: e.target.value }))} />
                  <button onClick={applyReconfigure} disabled={!selectedVm || busy}>Apply</button>
                </div>
              </div>

              <div className="card compact">
                <h3>Add Host Disk</h3>
                <div className="actions">
                  <input type="number" min="1" value={newDiskGb} onChange={(e) => setNewDiskGb(e.target.value)} />
                  <button onClick={addDisk} disabled={!selectedVm || busy}>Create + Attach</button>
                </div>
              </div>

              <DataTable
                columns={[{ key: 'target', label: 'Target' }, { key: 'device', label: 'Device' }, { key: 'source', label: 'Source' }]}
                rows={Array.isArray(selectedVmDetail?.disks) ? selectedVmDetail.disks : []}
              />
            </div>
          )}

          {vmTab === 'storage' && (
            <div className="stack">
              <div className="card compact">
                <h3>First Boot Workflow</h3>
                <p className="muted">Attach ISO → set CDROM boot → start installer in one action.</p>
                <div className="actions">
                  <input value={firstBootIso} onChange={(e) => setFirstBootIso(e.target.value)} placeholder="/var/lib/libvirt/boot/ubuntu.iso" />
                  <select value={firstBootIso} onChange={(e) => setFirstBootIso(e.target.value)}>
                    <option value="">Choose from ISO library</option>
                    {state.isoLibrary.map((iso) => <option key={iso.path} value={iso.path}>{iso.name}</option>)}
                  </select>
                  <button onClick={runFirstBoot} disabled={!selectedVm || busy}>Run First Boot</button>
                  <button onClick={finishInstallFlow} disabled={!selectedVm || busy}>Finish Install (Disk Boot)</button>
                </div>
              </div>

              <div className="card compact">
                <h3>Manual ISO / Boot</h3>
                <div className="actions">
                  <button onClick={attachIsoOnly} disabled={!selectedVm || busy}>Attach ISO</button>
                  <button onClick={detachIsoOnly} disabled={!selectedVm || busy}>Detach ISO</button>
                  <button onClick={() => setBootPrimary('cdrom')} disabled={!selectedVm || busy}>Boot CDROM</button>
                  <button onClick={() => setBootPrimary('hd')} disabled={!selectedVm || busy}>Boot Disk</button>
                </div>
              </div>

              <div className="card compact">
                <h3>ISO Import</h3>
                <div className="actions">
                  <input value={isoImportPath} onChange={(e) => setIsoImportPath(e.target.value)} placeholder="/host/path/file.iso" />
                  <button onClick={importIso} disabled={busy}>Import</button>
                </div>
              </div>

              <DataTable
                columns={[
                  { key: 'name', label: 'ISO Name' },
                  { key: 'path', label: 'Path' },
                  { key: 'size_bytes', label: 'Size' },
                  { key: 'path', label: 'Use', render: (path) => <button onClick={() => setFirstBootIso(path)}>Use</button> }
                ]}
                rows={state.isoLibrary}
              />
            </div>
          )}

          {vmTab === 'tasks' && (
            <div className="stack">
              <div className="card compact">
                <h3>Snapshots</h3>
                <div className="actions">
                  <input placeholder="snapshot-name" value={snapshotName} onChange={(e) => setSnapshotName(e.target.value)} />
                  <button onClick={listVmSnapshots} disabled={!selectedVm || busy}>List</button>
                  <button onClick={createVmSnapshot} disabled={!selectedVm || busy}>Create</button>
                  <button onClick={revertVmSnapshot} disabled={!selectedVm || busy}>Revert</button>
                </div>
              </div>

              <DataTable columns={[{ key: 'name', label: 'Snapshot Name' }]} rows={state.vmSnapshots.map((name) => ({ name }))} />

              <div className="two-col">
                <div>
                  <h3>Recent VM Jobs</h3>
                  <DataTable
                    columns={[
                      { key: 'action', label: 'Action' },
                      { key: 'status', label: 'Status', render: (v) => <Chip value={v} /> },
                      { key: 'created_at', label: 'Created', render: (v) => toLocale(v) }
                    ]}
                    rows={vmJobs}
                  />
                </div>
                <div>
                  <h3>Recent VM Audits</h3>
                  <DataTable
                    columns={[
                      { key: 'action', label: 'Action' },
                      { key: 'status', label: 'Status', render: (v) => <Chip value={v} /> },
                      { key: 'message', label: 'Message' }
                    ]}
                    rows={vmAudits}
                  />
                </div>
              </div>
            </div>
          )}

          {vmTab === 'create' && (
            <div className="stack">
              <div className="card compact">
                <h3>Create New VM</h3>
                <div className="actions">
                  <input placeholder="VM ID" value={createDraft.id} onChange={(e) => setCreateDraft((p) => ({ ...p, id: e.target.value }))} />
                  <input type="number" min="1" value={createDraft.vcpus} onChange={(e) => setCreateDraft((p) => ({ ...p, vcpus: e.target.value }))} />
                  <input type="number" min="256" value={createDraft.memory_mb} onChange={(e) => setCreateDraft((p) => ({ ...p, memory_mb: e.target.value }))} />
                  <input type="number" min="5" value={createDraft.disk_gb} onChange={(e) => setCreateDraft((p) => ({ ...p, disk_gb: e.target.value }))} />
                  <input placeholder="ISO path (optional)" value={createDraft.iso_path} onChange={(e) => setCreateDraft((p) => ({ ...p, iso_path: e.target.value }))} />
                  <select value={createDraft.network_mode} onChange={(e) => setCreateDraft((p) => ({ ...p, network_mode: e.target.value }))}>
                    <option value="network">Libvirt Network</option>
                    <option value="bridge">Bridge</option>
                  </select>
                  <input placeholder="network / bridge source" value={createDraft.network_source} onChange={(e) => setCreateDraft((p) => ({ ...p, network_source: e.target.value }))} />
                  <button onClick={createVm} disabled={busy}>Create VM</button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );

  return (
    <div className="layout">
      <aside className="sidebar">
        <h1>Potorix</h1>
        <nav>
          {NAV_ITEMS.map(([key, label]) => (
            <button key={key} className={cls('nav-btn', view === key && 'active')} onClick={() => setView(key)}>{label}</button>
          ))}
        </nav>
      </aside>

      <main className="main">
        <header className="topbar">
          <h2>{NAV_ITEMS.find(([key]) => key === view)?.[1] || 'Dashboard'}</h2>
          <div className="auth-row">
            <input value={tenant} onChange={(e) => setTenant(e.target.value)} placeholder="Tenant ID" />
            <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="API Key" />
            <button onClick={refresh} disabled={busy}>Refresh</button>
            <button onClick={connectRealtime} disabled={busy}>Reconnect WS</button>
          </div>
        </header>

        {view === 'dashboard' && (
          <section className="stack">
            <div className="cards">
              <div className="card"><h3>Tenant VM Count</h3><p>{state.vms.length}</p></div>
              <div className="card"><h3>Queued/Running Jobs</h3><p>{state.jobs.filter((x) => ['queued', 'running'].includes(x.status)).length}</p></div>
              <div className="card"><h3>Failed Jobs</h3><p>{state.jobs.filter((x) => x.status === 'failed').length}</p></div>
              <div className="card"><h3>Audit Events</h3><p>{state.audits.length}</p></div>
            </div>

            <div className="panel two-col">
              <div>
                <h3>Recent Jobs</h3>
                <DataTable columns={[{ key: 'source', label: 'Source' }, { key: 'action', label: 'Action' }, { key: 'target', label: 'Target' }, { key: 'status', label: 'Status', render: (v) => <Chip value={v} /> }]} rows={state.jobs.slice(0, 8)} />
              </div>

              <div>
                <h3>Live Timeline</h3>
                <ul className="timeline">
                  {timeline.map((x, idx) => <li key={idx}><span>{toLocale(x.at)}</span><strong>{x.type}</strong><span>{x.message}</span></li>)}
                  {timeline.length === 0 && <li><span>No event yet</span></li>}
                </ul>
              </div>
            </div>
          </section>
        )}

        {view === 'vms' && vmPage}

        {view === 'snapshots' && (
          <section className="panel stack">
            <h3>Snapshot Operations</h3>
            <div className="actions">
              <select value={snapshotVmId} onChange={(e) => setSnapshotVmId(e.target.value)}>
                <option value="">Select VM</option>
                {state.vms.map((vm) => <option key={vm} value={vm}>{vm}</option>)}
              </select>
              <input placeholder="Snapshot name" value={snapshotName} onChange={(e) => setSnapshotName(e.target.value)} />
              <button onClick={listSnapshots} disabled={busy}>List</button>
              <button onClick={createSnapshot} disabled={busy}>Create</button>
              <button onClick={revertSnapshot} disabled={busy}>Revert</button>
            </div>
            <DataTable columns={[{ key: 'name', label: 'Snapshot Name' }]} rows={state.snapshots.map((x) => ({ name: x }))} />
          </section>
        )}

        {view === 'jobs' && <section className="panel"><h3>Jobs</h3><DataTable columns={[{ key: 'id', label: 'Job' }, { key: 'source', label: 'Source' }, { key: 'action', label: 'Action' }, { key: 'target', label: 'Target' }, { key: 'status', label: 'Status', render: (v) => <Chip value={v} /> }, { key: 'created_at', label: 'Created', render: (v) => toLocale(v) }]} rows={state.jobs} /></section>}

        {view === 'audits' && <section className="panel"><h3>Audit Logs</h3><DataTable columns={[{ key: 'id', label: 'ID' }, { key: 'action', label: 'Action' }, { key: 'resource_id', label: 'Resource' }, { key: 'status', label: 'Status', render: (v) => <Chip value={v} /> }, { key: 'message', label: 'Message' }]} rows={state.audits} /></section>}

        {view === 'marketplace' && <section className="panel"><h3>Marketplace</h3><DataTable columns={[{ key: 'slug', label: 'App' }, { key: 'version', label: 'Version' }, { key: 'description', label: 'Description' }, { key: 'slug', label: 'Action', render: (slug) => <button onClick={() => installApp(slug)} disabled={busy}>Install</button> }]} rows={state.apps} /></section>}

        {view === 'backups' && (
          <section className="panel two-col">
            <div>
              <h3>Backup Policies</h3>
              <DataTable columns={[{ key: 'id', label: 'ID' }, { key: 'name', label: 'Name' }, { key: 'target_id', label: 'Target' }, { key: 'schedule_cron', label: 'Schedule' }, { key: 'status', label: 'Status', render: (v) => <Chip value={v} /> }]} rows={state.backupPolicies} />
            </div>
            <div>
              <h3>Backup Runs</h3>
              <DataTable columns={[{ key: 'id', label: 'Run' }, { key: 'vm_id', label: 'VM' }, { key: 'status', label: 'Status', render: (v) => <Chip value={v} /> }, { key: 'created_at', label: 'Created', render: (v) => toLocale(v) }]} rows={state.backupRuns} />
            </div>
          </section>
        )}

        {view === 'agents' && <section className="panel"><h3>Agents</h3><DataTable columns={[{ key: 'node_name', label: 'Node' }, { key: 'version', label: 'Version' }, { key: 'status', label: 'Status', render: (v) => <Chip value={v} /> }, { key: 'last_seen_at', label: 'Last Seen', render: (v) => toLocale(v) }]} rows={state.agents} /></section>}

        <div className="toast-wrap">
          {toasts.map((t) => (
            <div key={t.id} className={cls('toast', t.kind)}>
              <strong>{t.title}</strong>
              <p>{t.message}</p>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
