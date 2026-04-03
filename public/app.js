const el = (id) => document.getElementById(id);
const AUTH_STORAGE_KEY = 'potorix.auth.v1';
let socket;
const timeline = [];
const maxTimeline = 100;
let state = { vms: [], vmDetails: [], selectedVm: '', activeVmTab: 'summary', jobs: [], audits: [], apps: [], installs: [], backupPolicies: [], backupRuns: [], agents: [], snapshots: [], isoLibrary: [] };
const actionLocks = new Set();
let currentConsoleVmId = '';
let wizardStep = 1;
let wizardDraft = {};
let refreshInFlightPromise = null;
let refreshQueued = false;
let realtimeRefreshTimer = null;

const viewTitles = {
  dashboard: 'Control Plane Dashboard',
  vms: 'Virtual Machines',
  snapshots: 'Snapshots',
  jobs: 'Jobs',
  audits: 'Audit Logs',
  marketplace: 'Marketplace',
  backups: 'Backup Engine',
  agents: 'Compute Agents',
};

function auth() {
  const tenant = el('tenant').value.trim();
  const token = el('token').value.trim();
  return { tenant, token, headers: { 'X-Tenant-ID': tenant, 'X-API-Key': token } };
}

function loadPersistedAuth() {
  try {
    const raw = window.localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (el('tenant') && typeof data.tenant === 'string') el('tenant').value = data.tenant;
    if (el('token') && typeof data.token === 'string') el('token').value = data.token;
  } catch (_err) {
    // ignore malformed local cache in development
  }
}

function persistAuth() {
  try {
    const { tenant, token } = auth();
    window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ tenant, token }));
  } catch (_err) {
    // ignore storage failures
  }
}

async function api(path, options = {}) {
  const { tenant, token, headers } = auth();
  const url = new URL(path, window.location.origin);
  url.searchParams.set('tenant', tenant);
  url.searchParams.set('token', token);
  const res = await fetch(url.toString(), { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'API error');
  return data.data;
}

function chip(status) {
  const s = (status || '').toLowerCase();
  return `<span class="chip ${s}">${status || '-'}</span>`;
}

function table(columns, rows) {
  const th = columns.map((c) => `<th>${c.label}</th>`).join('');
  const tr = rows.length
    ? rows.map((r) => `<tr>${columns.map((c) => `<td>${c.render ? c.render(r[c.key], r) : (r[c.key] ?? '-')}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${columns.length}">No data</td></tr>`;
  return `<table class="table"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}

function selectedVmId(selectId) {
  const node = el(selectId);
  return node ? node.value.trim() : '';
}

function renderVmSelect(selectId, includePlaceholder = true) {
  const node = el(selectId);
  if (!node) return;
  if (node.tagName === 'INPUT') {
    if (state.selectedVm) node.value = state.selectedVm;
    return;
  }
  const current = node.value;
  const options = [];
  if (includePlaceholder) options.push('<option value="">VM sec</option>');
  options.push(...state.vms.map((id) => `<option value="${id}">${id}</option>`));
  node.innerHTML = options.join('');
  if (state.vms.includes(current)) {
    node.value = current;
  } else if (state.vms.length > 0) {
    node.value = state.vms[0];
  }
}

function showToast(event) {
  const container = el('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${event.severity === 'error' ? 'error' : ''}`;
  const resource = event.resource || {};
  const data = event.data || {};
  toast.innerHTML = `<div class="title">${event.event_type}</div><div>${resource.type || 'resource'} / ${resource.id || '-'}</div><div class="meta">${data.status || '-'} • ${new Date(event.occurred_at).toLocaleTimeString('tr-TR')}</div>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

function shouldToastEvent(event) {
  const eventType = (event?.event_type || '').toLowerCase();
  if (eventType === 'ws.connected' || eventType === 'job.running') return false;
  if (eventType === 'audit.logged' && String(event?.data?.status || '').toLowerCase() === 'queued') return false;
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lockAction(key, lock) {
  const shouldLock = !!lock;
  if (shouldLock) actionLocks.add(key);
  else actionLocks.delete(key);
  document.querySelectorAll(`[data-action-key="${key}"]`).forEach((btn) => {
    btn.disabled = shouldLock;
    btn.textContent = shouldLock ? 'Working...' : (btn.dataset.actionLabel || btn.textContent);
  });
}

async function runVmAction(vmId, action, fn) {
  const key = `${vmId}:${action}`;
  if (actionLocks.has(key)) return;
  lockAction(key, true);
  try {
    await fn();
  } finally {
    lockAction(key, false);
  }
}

function renderTimeline() {
  el('timeline').innerHTML = timeline.length
    ? timeline.map((x) => `<li><span class="time">${new Date(x.occurred_at).toLocaleTimeString('tr-TR')}</span><span class="badge ${x.severity === 'error' ? 'error' : 'info'}">${x.event_type}</span><span>${x.message}</span></li>`).join('')
    : '<li><span>Henuz event yok</span></li>';
}

function pushTimeline(event) {
  const msg = event.data?.message || `${event.resource?.type || 'resource'}:${event.resource?.id || '-'} ${event.data?.action || event.event_type}`;
  timeline.unshift({ occurred_at: event.occurred_at, event_type: event.event_type, severity: event.severity, message: msg });
  if (timeline.length > maxTimeline) timeline.length = maxTimeline;
  renderTimeline();
}

function renderDashboard() {
  el('vm-count').textContent = state.vms.length;
  el('active-jobs').textContent = state.jobs.filter((x) => x.status === 'queued' || x.status === 'running').length;
  el('failed-jobs').textContent = state.jobs.filter((x) => x.status === 'failed').length;
  el('audit-count').textContent = state.audits.length;

  el('jobs-table').innerHTML = table([
    { key: 'source', label: 'Source' }, { key: 'action', label: 'Action' }, { key: 'target', label: 'Target' }, { key: 'status', label: 'Status', render: (v) => chip(v) }
  ], state.jobs.slice(0, 8));

  el('audits-table').innerHTML = table([
    { key: 'action', label: 'Action' }, { key: 'resource_id', label: 'Resource' }, { key: 'status', label: 'Status', render: (v) => chip(v) }, { key: 'created_at', label: 'Time' }
  ], state.audits.slice(0, 8));

  const usage = state.systemUsage || {};
  const host = usage.host || {};
  const tenant = usage.tenant || {};
  const usageCards = el('usage-cards');
  if (usageCards) {
    usageCards.innerHTML = [
      `<div class="card"><h3>Host CPU</h3><p>${host.cpu_total ?? '-'}</p></div>`,
      `<div class="card"><h3>Host RAM MB</h3><p>${host.memory_total_mb ?? '-'}</p></div>`,
      `<div class="card"><h3>Disk Free GB</h3><p>${host.disk_free_gb ?? '-'}</p></div>`,
      `<div class="card"><h3>Running VMs</h3><p>${tenant.vm_running ?? '-'}/${tenant.vm_total ?? '-'}</p></div>`,
    ].join('');
  }
  renderUsageBars();
}

function renderUsageBars() {
  const container = el('usage-bars');
  if (!container) return;
  const usage = state.systemUsage || {};
  const host = usage.host || {};
  const tenant = usage.tenant || {};
  const rows = [
    { label: 'CPU Alloc', value: (tenant.alloc_vcpus || 0), max: Math.max(host.cpu_total || 1, 1), color: '#2a67f5', unit: 'vCPU' },
    { label: 'RAM Alloc', value: (tenant.alloc_memory_mb || 0), max: Math.max(host.memory_total_mb || 1, 1), color: '#22a06b', unit: 'MB' },
    { label: 'Disk Alloc', value: (tenant.alloc_disk_gb || 0), max: Math.max(host.disk_total_gb || 1, 1), color: '#9a55ff', unit: 'GB' },
  ];
  container.innerHTML = rows.map((r) => {
    const pct = Math.max(0, Math.min(100, (r.value / r.max) * 100));
    return `<div class="usage-row"><span class="usage-label">${r.label}</span><div class="usage-track"><div class="usage-fill" style="width:${pct}%;background:${r.color};"></div></div><span class="usage-val">${r.value}/${r.max} ${r.unit}</span></div>`;
  }).join('');
}

function renderViews() {
  renderDashboard();

  const vmDetailsMap = new Map(state.vmDetails.map((x) => [x.id, x]));
  if (!state.selectedVm || !state.vms.includes(state.selectedVm)) {
    state.selectedVm = state.vms[0] || '';
  }

  const selected = vmDetailsMap.get(state.selectedVm) || {};
  const vmListNode = el('vm-list');
  if (vmListNode) {
    vmListNode.innerHTML = state.vms.length
      ? state.vms.map((id) => `<div class="vm-list-item ${id === state.selectedVm ? 'active' : ''}" data-vm-select="${id}"><span class="vm-list-id">${id}</span>${chip(vmDetailsMap.get(id)?.state || 'unknown')}</div>`).join('')
      : '<div class="empty-state">No VM yet</div>';
  }
  const vmEmptyActions = el('vm-list-empty-actions');
  if (vmEmptyActions) vmEmptyActions.style.display = state.vms.length ? 'none' : 'block';
  const vmTitle = el('vm-selected-title');
  if (vmTitle) vmTitle.textContent = state.selectedVm || 'No VM selected';
  const vmState = el('vm-selected-state');
  if (vmState) {
    vmState.className = `chip ${(selected.state || 'unknown').toLowerCase()}`;
    vmState.textContent = selected.state || 'unknown';
  }
  updateConsoleOverlay(selected);
  const summaryCards = el('vm-summary-cards');
  if (summaryCards) {
    summaryCards.innerHTML = [
      `<div class="card"><h3>Status</h3><p>${selected.state || '-'}</p></div>`,
      `<div class="card"><h3>vCPU</h3><p>${selected.vcpus ?? '-'}</p></div>`,
      `<div class="card"><h3>Memory MB</h3><p>${selected.memory_mb ?? '-'}</p></div>`,
      `<div class="card"><h3>Boot</h3><p>${selected.boot_primary || '-'}</p></div>`,
    ].join('');
  }
  const hwTable = el('vm-hardware-table');
  if (hwTable) {
    hwTable.innerHTML = table(
      [{ key: 'k', label: 'Property' }, { key: 'v', label: 'Value' }],
      [
        { k: 'VM ID', v: state.selectedVm || '-' },
        { k: 'Network', v: selected.network_mode ? `${selected.network_mode}:${selected.network_source}` : '-' },
        { k: 'ISO', v: selected.iso_path || '-' },
        { k: 'Disks', v: (selected.disks || []).map((d) => `${d.target}:${d.source}`).join(' | ') || '-' },
        { k: 'Boot Order', v: (selected.boot_order || []).join(' > ') || '-' },
      ]
    );
  }
  const vmJobs = state.jobs.filter((j) => j.target === state.selectedVm).slice(0, 10);
  const vmAudits = state.audits.filter((a) => a.resource_id === state.selectedVm).slice(0, 10);
  if (el('vm-jobs-table')) {
    el('vm-jobs-table').innerHTML = table([
      { key: 'action', label: 'Action' }, { key: 'status', label: 'Status', render: (v) => chip(v) }, { key: 'created_at', label: 'Created' }
    ], vmJobs);
  }
  if (el('vm-audits-table')) {
    el('vm-audits-table').innerHTML = table([
      { key: 'action', label: 'Action' }, { key: 'status', label: 'Status', render: (v) => chip(v) }, { key: 'message', label: 'Message' }
    ], vmAudits);
  }

  el('iso-library-table').innerHTML = table([
    { key: 'name', label: 'ISO Name' },
    { key: 'path', label: 'Path' },
    { key: 'size_bytes', label: 'Size (bytes)' },
    { key: 'path', label: 'Use', render: (v) => `<button class="btn iso-use-btn" data-path="${v}">Use in VM Form</button>` },
  ], state.isoLibrary);

  el('snapshots-view').innerHTML = table([
    { key: 'name', label: 'Snapshot Name' }
  ], state.snapshots.map((name) => ({ name })));

  el('jobs-full-table').innerHTML = table([
    { key: 'id', label: 'Job' }, { key: 'source', label: 'Source' }, { key: 'action', label: 'Action' }, { key: 'target', label: 'Target' }, { key: 'status', label: 'Status', render: (v) => chip(v) }, { key: 'created_at', label: 'Created' }
  ], state.jobs);

  el('audits-full-table').innerHTML = table([
    { key: 'id', label: 'ID' }, { key: 'action', label: 'Action' }, { key: 'resource_id', label: 'Resource' }, { key: 'status', label: 'Status', render: (v) => chip(v) }, { key: 'message', label: 'Message' }
  ], state.audits);

  el('marketplace-table').innerHTML = table([
    { key: 'slug', label: 'App' }, { key: 'version', label: 'Version' }, { key: 'description', label: 'Description' },
    { key: 'slug', label: 'Action', render: (slug) => `<button class="btn install-btn" data-slug="${slug}">Install</button>` }
  ], state.apps);

  el('backup-policies-table').innerHTML = table([
    { key: 'id', label: 'ID' }, { key: 'name', label: 'Name' }, { key: 'target_id', label: 'Target' }, { key: 'schedule_cron', label: 'Schedule' }, { key: 'status', label: 'Status', render: (v) => chip(v) }
  ], state.backupPolicies);

  el('backup-runs-table').innerHTML = table([
    { key: 'id', label: 'Run' }, { key: 'vm_id', label: 'VM' }, { key: 'status', label: 'Status', render: (v) => chip(v) }, { key: 'created_at', label: 'Created' }
  ], state.backupRuns);

  el('agents-table').innerHTML = table([
    { key: 'node_name', label: 'Node' }, { key: 'version', label: 'Version' }, { key: 'status', label: 'Status', render: (v) => chip(v) }, { key: 'last_seen_at', label: 'Last Seen' }
  ], state.agents);

  document.querySelectorAll('.install-btn').forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`/api/v1/marketplace/apps/${b.dataset.slug}/install`, { method: 'POST' });
        await refresh();
      } catch (err) {
        showToast({ event_type: 'ui.error', severity: 'error', occurred_at: new Date().toISOString(), resource: { type: 'app', id: b.dataset.slug }, data: { status: 'failed', message: err.message } });
      }
    };
  });

  document.querySelectorAll('.iso-use-btn').forEach((b) => {
    b.onclick = () => {
      el('vm-action-iso').value = b.dataset.path;
      showToast({ event_type: 'ui.iso.selected', severity: 'info', occurred_at: new Date().toISOString(), resource: { type: 'iso', id: b.dataset.path }, data: { status: 'selected' } });
    };
  });

  document.querySelectorAll('[data-vm-select]').forEach((b) => {
    b.onclick = () => {
      state.selectedVm = b.dataset.vmSelect;
      currentConsoleVmId = '';
      renderViews();
      syncConsoleToSelectedVm();
    };
  });

  renderVmSelect('vm-action-id');
  renderVmSelect('snapshot-vm-id');
}

async function createVm(payloadOverride = null) {
  const payload = payloadOverride || {};
  if (!payload.id) throw new Error('VM ID gerekli');
  const idem = `ui-vm-${payload.id}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  await api('/api/v1/vms', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idem }, body: JSON.stringify(payload) });
  return payload.id;
}

async function runBackup() {
  const vm_id = state.selectedVm;
  if (!vm_id) throw new Error('Backup icin VM secin');
  await api('/api/v1/backups/run', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `ui-backup-${vm_id}` }, body: JSON.stringify({ vm_id }) });
}

async function attachIso() {
  const vmId = selectedVmId('vm-action-id');
  const isoPath = el('vm-action-iso').value.trim();
  if (!vmId || !isoPath) throw new Error('VM ID ve ISO path gerekli');
  await api(`/api/v1/vms/${encodeURIComponent(vmId)}/attach-iso`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ iso_path: isoPath }),
  });
  await api(`/api/v1/vms/${encodeURIComponent(vmId)}/boot-order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ primary: 'cdrom' }),
  });
}

async function detachIso() {
  const vmId = selectedVmId('vm-action-id');
  if (!vmId) throw new Error('VM ID gerekli');
  await api(`/api/v1/vms/${encodeURIComponent(vmId)}/detach-iso`, { method: 'POST' });
  await api(`/api/v1/vms/${encodeURIComponent(vmId)}/boot-order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ primary: 'hd' }),
  });
}

async function setBootPrimary(primary) {
  const vmId = selectedVmId('vm-action-id');
  if (!vmId) throw new Error('VM ID gerekli');
  await api(`/api/v1/vms/${encodeURIComponent(vmId)}/boot-order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ primary }),
  });
}

async function reconfigureSelectedVmOffline() {
  const vmId = state.selectedVm;
  if (!vmId) throw new Error('VM secin');
  const selected = state.vmDetails.find((x) => x.id === vmId);
  if (!String(selected?.state || '').toLowerCase().includes('shut')) throw new Error('VM kapali olmali');
  const payload = {};
  const v = Number(el('vm-edit-vcpus')?.value);
  const m = Number(el('vm-edit-memory')?.value);
  const d = Number(el('vm-edit-disk')?.value);
  if (Number.isFinite(v) && v > 0) payload.vcpus = v;
  if (Number.isFinite(m) && m > 0) payload.memory_mb = m;
  if (Number.isFinite(d) && d > 0) payload.disk_gb = d;
  if (Object.keys(payload).length === 0) throw new Error('En az bir alan girin');
  await api(`/api/v1/vms/${encodeURIComponent(vmId)}/reconfigure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function addExtraDiskToSelectedVm() {
  const vmId = state.selectedVm;
  if (!vmId) throw new Error('VM secin');
  const selected = state.vmDetails.find((x) => x.id === vmId);
  if (!String(selected?.state || '').toLowerCase().includes('shut')) throw new Error('VM kapali olmali');
  const size = Number(el('vm-extra-disk-gb')?.value || 0);
  if (!Number.isFinite(size) || size < 1) throw new Error('Disk GB >= 1 olmali');
  await api(`/api/v1/vms/${encodeURIComponent(vmId)}/disks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ size_gb: size }),
  });
}

async function loadVncInfo() {
  const vmId = selectedVmId('vm-action-id');
  if (!vmId) throw new Error('VM ID gerekli');
  const data = await api(`/api/v1/vms/${encodeURIComponent(vmId)}/vnc`);
  el('vnc-info').textContent = `VM: ${data.vm_id} | Display: ${data.display} | Host: ${data.host} | Port: ${data.port || '-'} | URL: ${data.url || '-'}`;
}

function openConsoleForVm(vmId) {
  const tenant = el('tenant').value.trim();
  const token = el('token').value.trim();
  if (!vmId || !tenant || !token) throw new Error('VM, tenant ve token gerekli');
  const frame = el('console-frame');
  frame.src = `/novnc.html?tenant=${encodeURIComponent(tenant)}&token=${encodeURIComponent(token)}&vm_id=${encodeURIComponent(vmId)}`;
  currentConsoleVmId = vmId;
  el('vnc-info').textContent = `Embedded console loading for VM: ${vmId}`;
}

function updateConsoleOverlay(vmDetail) {
  const overlay = el('console-overlay');
  const text = el('console-overlay-text');
  if (!overlay || !text) return;
  const running = String(vmDetail?.state || '').toLowerCase().includes('running');
  if (!state.selectedVm) {
    overlay.style.display = 'flex';
    text.textContent = 'Select a VM from the list';
    return;
  }
  if (running) {
    overlay.style.display = 'none';
  } else {
    overlay.style.display = 'flex';
    text.textContent = `VM ${state.selectedVm} is powered off`;
  }
}

function syncConsoleToSelectedVm() {
  if (!state.selectedVm) return;
  const detail = state.vmDetails.find((x) => x.id === state.selectedVm);
  const running = String(detail?.state || '').toLowerCase().includes('running');
  if (running && currentConsoleVmId !== state.selectedVm) {
    openConsoleForVm(state.selectedVm);
  }
}

async function toggleConsoleFullscreen() {
  const frame = el('console-frame');
  if (!frame) return;
  const target = frame.parentElement || frame;
  if (document.fullscreenElement) {
    await document.exitFullscreen();
  } else if (target.requestFullscreen) {
    await target.requestFullscreen();
  }
}

function refreshConsoleFullscreenButton() {
  const btn = el('btn-console-fullscreen');
  if (!btn) return;
  btn.textContent = document.fullscreenElement ? 'Exit Fullscreen' : 'Fullscreen';
}

async function waitForVnc(vmId) {
  for (let i = 0; i < 8; i += 1) {
    try {
      const data = await api(`/api/v1/vms/${encodeURIComponent(vmId)}/vnc`);
      el('vnc-info').textContent = `VM: ${data.vm_id} | Display: ${data.display} | Host: ${data.host} | Port: ${data.port || '-'} | URL: ${data.url || '-'}`;
      showToast({ event_type: 'ui.vnc.ready', severity: 'info', occurred_at: new Date().toISOString(), resource: { type: 'vm', id: vmId }, data: { status: 'ready', message: data.url || 'VNC ready' } });
      return;
    } catch (err) {
      if (!String(err.message).includes('not running')) throw err;
      await sleep(1500);
    }
  }
  showToast({ event_type: 'ui.vnc.waiting', severity: 'info', occurred_at: new Date().toISOString(), resource: { type: 'vm', id: vmId }, data: { status: 'pending', message: 'VM started; VNC not ready yet.' } });
}

async function loadIsoLibrary() {
  const data = await api('/api/v1/iso-library');
  state = { ...state, isoLibrary: data };
  renderViews();
}

async function importIsoToLibrary() {
  const sourcePath = el('iso-import-source').value.trim();
  if (!sourcePath) throw new Error('Source path gerekli');
  await api('/api/v1/iso-library/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_path: sourcePath }),
  });
  await loadIsoLibrary();
}

async function listSnapshots() {
  const vmId = selectedVmId('snapshot-vm-id');
  if (!vmId) throw new Error('Snapshot VM ID gerekli');
  const snapshots = await api(`/api/v1/vms/${encodeURIComponent(vmId)}/snapshots`);
  state = { ...state, snapshots };
  renderViews();
}

async function createSnapshot() {
  const vmId = selectedVmId('snapshot-vm-id');
  const snapshotName = el('snapshot-name').value.trim();
  if (!vmId || !snapshotName) throw new Error('VM ID ve snapshot name gerekli');
  await api(`/api/v1/vms/${encodeURIComponent(vmId)}/snapshots`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ snapshot_name: snapshotName }),
  });
  await listSnapshots();
}

async function revertSnapshot() {
  const vmId = selectedVmId('snapshot-vm-id');
  const snapshotName = el('snapshot-name').value.trim();
  if (!vmId || !snapshotName) throw new Error('VM ID ve snapshot name gerekli');
  await api(`/api/v1/vms/${encodeURIComponent(vmId)}/snapshots/${encodeURIComponent(snapshotName)}/revert`, { method: 'POST' });
}

async function performRefresh() {
  try {
    const [vms, vmDetails, jobs, audits, apps, backupPolicies, backupRuns, agents, isoLibrary, systemUsage] = await Promise.all([
      api('/api/v1/vms'), api('/api/v1/vms/details'), api('/api/v1/jobs?limit=50'), api('/api/v1/audit-logs?limit=50'), api('/api/v1/marketplace/apps'), api('/api/v1/backups/policies'), api('/api/v1/backups/runs?limit=50'), api('/api/v1/agents'), api('/api/v1/iso-library'), api('/api/v1/system/usage'),
    ]);
    state = { ...state, vms, vmDetails, jobs, audits, apps, backupPolicies, backupRuns, agents, isoLibrary, systemUsage };
    renderViews();
  } catch (err) {
    showToast({ event_type: 'ui.error', severity: 'error', occurred_at: new Date().toISOString(), resource: { type: 'ui', id: 'refresh' }, data: { status: 'failed', message: err.message } });
  }
}

async function refresh() {
  if (refreshInFlightPromise) {
    refreshQueued = true;
    return refreshInFlightPromise;
  }
  refreshInFlightPromise = performRefresh();
  try {
    await refreshInFlightPromise;
  } finally {
    refreshInFlightPromise = null;
    if (refreshQueued) {
      refreshQueued = false;
      await refresh();
    }
  }
}

function scheduleRealtimeRefresh() {
  if (realtimeRefreshTimer) return;
  realtimeRefreshTimer = setTimeout(() => {
    realtimeRefreshTimer = null;
    refresh();
  }, 250);
}

function activateView(view) {
  document.querySelectorAll('#menu a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active-view', v.id === `view-${view}`));
  el('view-title').textContent = viewTitles[view] || 'Control Plane Dashboard';
}

function bindMenu() {
  document.querySelectorAll('#menu a').forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      const view = a.dataset.view;
      history.replaceState({}, '', `#${view}`);
      activateView(view);
    };
  });
  const hash = (window.location.hash || '#dashboard').replace('#', '');
  activateView(viewTitles[hash] ? hash : 'dashboard');
}

async function startSelectedVm() {
  const vmId = state.selectedVm;
  if (!vmId) throw new Error('VM secin');
  await runVmAction(vmId, 'start', async () => {
    await api(`/api/v1/vms/${encodeURIComponent(vmId)}/start`, { method: 'POST' });
    showToast({ event_type: 'ui.vm.start', severity: 'info', occurred_at: new Date().toISOString(), resource: { type: 'vm', id: vmId }, data: { status: 'queued', message: 'Start queued, checking VNC...' } });
    await refresh();
    await waitForVnc(vmId);
    openConsoleForVm(vmId);
  });
}

async function stopSelectedVm() {
  const vmId = state.selectedVm;
  if (!vmId) throw new Error('VM secin');
  await runVmAction(vmId, 'stop', async () => {
    await api(`/api/v1/vms/${encodeURIComponent(vmId)}/stop`, { method: 'POST' });
    await refresh();
  });
}

async function deleteSelectedVm() {
  const vmId = state.selectedVm;
  if (!vmId) throw new Error('VM secin');
  const confirmed = window.confirm(`Delete VM ${vmId}? This also removes storage.`);
  if (!confirmed) return;
  await runVmAction(vmId, 'delete', async () => {
    await api(`/api/v1/vms/${encodeURIComponent(vmId)}`, { method: 'DELETE' });
    await refresh();
  });
}

function bindVmTabs() {
  document.querySelectorAll('.pve-tab-btn').forEach((btn) => {
    btn.onclick = () => {
      state.activeVmTab = btn.dataset.vmTab;
      document.querySelectorAll('.pve-tab-btn').forEach((x) => x.classList.toggle('active', x.dataset.vmTab === state.activeVmTab));
      document.querySelectorAll('.pve-tab-panel').forEach((x) => x.classList.toggle('active', x.id === `vm-tab-${state.activeVmTab}`));
    };
  });
}

function openCreateWizard() {
  wizardStep = 1;
  wizardDraft = {
    id: `vm-${Math.floor(Date.now() / 1000).toString().slice(-5)}`,
    vcpus: 2,
    memory_mb: 2048,
    disk_gb: 20,
    iso_path: '',
    network_mode: 'network',
    network_source: 'default',
  };
  const modal = el('vm-create-modal');
  if (modal) modal.classList.remove('hidden');
  renderCreateWizard();
}

function closeCreateWizard() {
  const modal = el('vm-create-modal');
  if (modal) modal.classList.add('hidden');
}

function collectWizardStep() {
  if (wizardStep === 1) {
    wizardDraft.id = (el('wiz-vm-id')?.value || '').trim();
    wizardDraft.vcpus = Number(el('wiz-vcpus')?.value || 1);
    wizardDraft.memory_mb = Number(el('wiz-memory')?.value || 512);
    wizardDraft.disk_gb = Number(el('wiz-disk')?.value || 5);
  } else if (wizardStep === 2) {
    wizardDraft.iso_path = (el('wiz-iso')?.value || '').trim();
    wizardDraft.network_mode = el('wiz-net-mode')?.value || 'network';
    wizardDraft.network_source = (el('wiz-net-source')?.value || 'default').trim() || 'default';
  }
}

function renderCreateWizard() {
  const step = el('vm-wizard-step');
  const body = el('vm-wizard-body');
  if (!step || !body) return;
  step.textContent = `Step ${wizardStep} / 3`;
  if (wizardStep === 1) {
    body.innerHTML = `<div class="actions-row"><input id="wiz-vm-id" placeholder="VM ID" value="${wizardDraft.id || ''}"/><input id="wiz-vcpus" type="number" min="1" value="${wizardDraft.vcpus || 2}" placeholder="vCPU"/><input id="wiz-memory" type="number" min="512" value="${wizardDraft.memory_mb || 2048}" placeholder="RAM MB"/><input id="wiz-disk" type="number" min="5" value="${wizardDraft.disk_gb || 20}" placeholder="Disk GB"/></div>`;
  } else if (wizardStep === 2) {
    body.innerHTML = `<div class="actions-row"><input id="wiz-iso" placeholder="ISO Path (optional)" value="${wizardDraft.iso_path || ''}"/><select id="wiz-net-mode"><option value="network" ${wizardDraft.network_mode === 'network' ? 'selected' : ''}>Libvirt Network</option><option value="bridge" ${wizardDraft.network_mode === 'bridge' ? 'selected' : ''}>Bridge</option></select><input id="wiz-net-source" value="${wizardDraft.network_source || 'default'}" placeholder="network/bridge source"/></div>`;
  } else {
    const netKey = wizardDraft.network_mode === 'bridge' ? 'bridge' : 'network';
    body.innerHTML = `<div class="table-wrap">${table([{ key: 'k', label: 'Field' }, { key: 'v', label: 'Value' }], [{ k: 'VM ID', v: wizardDraft.id }, { k: 'vCPU', v: wizardDraft.vcpus }, { k: 'RAM MB', v: wizardDraft.memory_mb }, { k: 'Disk GB', v: wizardDraft.disk_gb }, { k: 'ISO', v: wizardDraft.iso_path || '-' }, { k: 'Network', v: `${netKey}:${wizardDraft.network_source}` }])}</div>`;
  }
  if (el('btn-wizard-back')) el('btn-wizard-back').disabled = wizardStep === 1;
  if (el('btn-wizard-next')) el('btn-wizard-next').style.display = wizardStep < 3 ? '' : 'none';
  if (el('btn-wizard-create')) el('btn-wizard-create').style.display = wizardStep === 3 ? '' : 'none';
}

async function createVmFromWizard() {
  collectWizardStep();
  const payload = {
    id: wizardDraft.id,
    vcpus: wizardDraft.vcpus,
    memory_mb: wizardDraft.memory_mb,
    disk_gb: wizardDraft.disk_gb,
    network_mode: wizardDraft.network_mode,
    [wizardDraft.network_mode === 'bridge' ? 'bridge' : 'network']: wizardDraft.network_source || 'default',
  };
  if (wizardDraft.iso_path) payload.iso_path = wizardDraft.iso_path;
  const vmId = await createVm(payload);
  closeCreateWizard();
  await refresh();
  state.selectedVm = vmId;
  renderViews();
}

function connectRealtime() {
  if (socket) socket.close();
  const tenant = encodeURIComponent(el('tenant').value.trim());
  const token = encodeURIComponent(el('token').value.trim());
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${protocol}://${window.location.host}/ws?tenant=${tenant}&token=${token}`);
  socket.onmessage = (raw) => {
    const event = JSON.parse(raw.data);
    pushTimeline(event);
    if (shouldToastEvent(event)) showToast(event);
    if (event.event_type.startsWith('job.') || event.event_type.startsWith('audit.')) scheduleRealtimeRefresh();
  };
  socket.onclose = () => setTimeout(connectRealtime, 1500);
}

const on = (id, fn) => { const n = el(id); if (n) n.onclick = fn; };
on('refresh', async () => { await refresh(); connectRealtime(); });
on('btn-create-vm', async () => { try { await createVm(); await refresh(); } catch (err) { showToast({ event_type: 'ui.error', severity: 'error', occurred_at: new Date().toISOString(), resource: { type: 'vm', id: el('vm-id').value.trim() }, data: { status: 'failed', message: err.message } }); } });
on('btn-run-backup', async () => { try { await runBackup(); await refresh(); } catch (err) { showToast({ event_type: 'ui.error', severity: 'error', occurred_at: new Date().toISOString(), resource: { type: 'backup', id: el('vm-id').value.trim() }, data: { status: 'failed', message: err.message } }); } });
on('btn-snapshot-list', async () => { try { await listSnapshots(); } catch (err) { showToast({ event_type: 'ui.error', severity: 'error', occurred_at: new Date().toISOString(), resource: { type: 'snapshot', id: el('snapshot-vm-id').value.trim() || '-' }, data: { status: 'failed', message: err.message } }); } });
on('btn-snapshot-create', async () => { try { await createSnapshot(); await refresh(); } catch (err) { showToast({ event_type: 'ui.error', severity: 'error', occurred_at: new Date().toISOString(), resource: { type: 'snapshot', id: el('snapshot-vm-id').value.trim() || '-' }, data: { status: 'failed', message: err.message } }); } });
on('btn-snapshot-revert', async () => { try { await revertSnapshot(); await refresh(); } catch (err) { showToast({ event_type: 'ui.error', severity: 'error', occurred_at: new Date().toISOString(), resource: { type: 'snapshot', id: el('snapshot-vm-id').value.trim() || '-' }, data: { status: 'failed', message: err.message } }); } });
on('btn-attach-iso', async () => { try { await attachIso(); await refresh(); } catch (err) { showToast({ event_type: 'ui.error', severity: 'error', occurred_at: new Date().toISOString(), resource: { type: 'vm', id: state.selectedVm || '-' }, data: { status: 'failed', message: err.message } }); } });
on('btn-detach-iso', async () => { try { await detachIso(); await refresh(); } catch (err) { showToast({ event_type: 'ui.error', severity: 'error', occurred_at: new Date().toISOString(), resource: { type: 'vm', id: state.selectedVm || '-' }, data: { status: 'failed', message: err.message } }); } });
on('btn-vnc-info', async () => { try { await loadVncInfo(); } catch (err) { showToast({ event_type: 'ui.error', severity: 'error', occurred_at: new Date().toISOString(), resource: { type: 'vm', id: state.selectedVm || '-' }, data: { status: 'failed', message: err.message } }); } });
on('btn-open-console', async () => { try { openConsoleForVm(state.selectedVm); } catch (err) { showToast({ event_type: 'ui.error', severity: 'error', occurred_at: new Date().toISOString(), resource: { type: 'vm', id: state.selectedVm || '-' }, data: { status: 'failed', message: err.message } }); } });
on('btn-console-fullscreen', async () => { try { await toggleConsoleFullscreen(); } catch (err) { showToast({ event_type: 'ui.error', severity: 'error', occurred_at: new Date().toISOString(), resource: { type: 'console', id: state.selectedVm || '-' }, data: { status: 'failed', message: err.message } }); } });
on('btn-console-run', async () => { try { await startSelectedVm(); } catch (err) { showToast({ event_type: 'ui.error', severity: 'error', occurred_at: new Date().toISOString(), resource: { type: 'vm', id: state.selectedVm || '-' }, data: { status: 'failed', message: err.message } }); } });
on('btn-iso-refresh', async () => { try { await loadIsoLibrary(); } catch (err) { showToast({ event_type: 'ui.error', severity: 'error', occurred_at: new Date().toISOString(), resource: { type: 'iso-library', id: 'refresh' }, data: { status: 'failed', message: err.message } }); } });
on('btn-iso-import', async () => { try { await importIsoToLibrary(); await refresh(); } catch (err) { showToast({ event_type: 'ui.error', severity: 'error', occurred_at: new Date().toISOString(), resource: { type: 'iso-library', id: 'import' }, data: { status: 'failed', message: err.message } }); } });
on('btn-boot-cdrom', async () => { try { await setBootPrimary('cdrom'); await refresh(); } catch (err) { showToast({ event_type: 'ui.error', severity: 'error', occurred_at: new Date().toISOString(), resource: { type: 'vm', id: state.selectedVm || '-' }, data: { status: 'failed', message: err.message } }); } });
on('btn-boot-hd', async () => { try { await setBootPrimary('hd'); await refresh(); } catch (err) { showToast({ event_type: 'ui.error', severity: 'error', occurred_at: new Date().toISOString(), resource: { type: 'vm', id: state.selectedVm || '-' }, data: { status: 'failed', message: err.message } }); } });
on('btn-vm-start', async () => { try { await startSelectedVm(); } catch (err) { showToast({ event_type: 'ui.error', severity: 'error', occurred_at: new Date().toISOString(), resource: { type: 'vm', id: state.selectedVm || '-' }, data: { status: 'failed', message: err.message } }); } });
on('btn-vm-stop', async () => { try { await stopSelectedVm(); } catch (err) { showToast({ event_type: 'ui.error', severity: 'error', occurred_at: new Date().toISOString(), resource: { type: 'vm', id: state.selectedVm || '-' }, data: { status: 'failed', message: err.message } }); } });
on('btn-vm-delete', async () => { try { await deleteSelectedVm(); } catch (err) { showToast({ event_type: 'ui.error', severity: 'error', occurred_at: new Date().toISOString(), resource: { type: 'vm', id: state.selectedVm || '-' }, data: { status: 'failed', message: err.message } }); } });
on('btn-vm-reconfigure', async () => { try { await reconfigureSelectedVmOffline(); await refresh(); } catch (err) { showToast({ event_type: 'ui.error', severity: 'error', occurred_at: new Date().toISOString(), resource: { type: 'vm', id: state.selectedVm || '-' }, data: { status: 'failed', message: err.message } }); } });
on('btn-vm-add-disk', async () => { try { await addExtraDiskToSelectedVm(); await refresh(); } catch (err) { showToast({ event_type: 'ui.error', severity: 'error', occurred_at: new Date().toISOString(), resource: { type: 'vm', id: state.selectedVm || '-' }, data: { status: 'failed', message: err.message } }); } });
on('btn-go-create-vm', () => openCreateWizard());
on('btn-open-create-wizard', () => openCreateWizard());
on('btn-open-create-wizard-tab', () => openCreateWizard());
on('btn-wizard-cancel', () => closeCreateWizard());
on('btn-wizard-back', () => { collectWizardStep(); wizardStep = Math.max(1, wizardStep - 1); renderCreateWizard(); });
on('btn-wizard-next', () => { collectWizardStep(); wizardStep = Math.min(3, wizardStep + 1); renderCreateWizard(); });
on('btn-wizard-create', async () => { try { await createVmFromWizard(); } catch (err) { showToast({ event_type: 'ui.error', severity: 'error', occurred_at: new Date().toISOString(), resource: { type: 'vm', id: wizardDraft.id || '-' }, data: { status: 'failed', message: err.message } }); } });
const tenantInput = el('tenant');
if (tenantInput) tenantInput.addEventListener('input', persistAuth);
const tokenInput = el('token');
if (tokenInput) tokenInput.addEventListener('input', persistAuth);

loadPersistedAuth();
bindMenu();
bindVmTabs();
document.addEventListener('fullscreenchange', refreshConsoleFullscreenButton);
refreshConsoleFullscreenButton();
refresh();
connectRealtime();
