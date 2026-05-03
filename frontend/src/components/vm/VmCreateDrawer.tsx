import React, { useState } from 'react';
import { Button } from '../ui/Button';
import { Drawer } from '../ui/Drawer';
import { backendVmApi } from '../../services/backendVmApi';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useToastStore } from '../../store/toastStore';

export function VmCreateDrawer({ open, onClose, isoLibrary, storagePools }: { open: boolean, onClose: () => void, isoLibrary: any[], storagePools: any[] }) {
  const queryClient = useQueryClient();
  const pushToast = useToastStore(s => s.push);

  const [form, setForm] = useState({
    id: String(Math.floor(Math.random() * 900) + 100),
    name: 'new-vm',
    node: 'node-a',
    osFamily: 'linux' as const,
    osVersion: 'Ubuntu 24.04',
    cpuSockets: 1,
    cpuCores: 2,
    memoryMb: 4096,
    diskGb: 40,
    storagePool: 'default',
    diskBus: 'scsi' as const,
    networkMode: 'nat' as const,
    networkSource: 'default',
    nicModel: 'virtio' as const,
    isoPath: '',
    cloudInitUser: 'admin',
    cloudInitNetwork: 'dhcp' as 'dhcp' | 'static',
    staticIp: '',
    gateway: '',
    dns: '1.1.1.1',
    vlanId: '',
    timezone: 'UTC',
    startAtBoot: true,
    firewallEnabled: true,
    snapshotOnCreate: false
  });

  const [advanced, setAdvanced] = useState(false);

  const mutation = useMutation({
    mutationFn: () => backendVmApi.createVm(form),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vms'] });
      pushToast({ kind: 'success', title: 'VM Creating', message: `VM ${form.id} is being created.` });
      onClose();
    },
    onError: (err: any) => {
      pushToast({ kind: 'error', title: 'VM Create Failed', message: err.message });
    }
  });

  return (
    <Drawer open={open} title="Create New VM" onClose={onClose}>
      <div className="form-grid" style={{ paddingBottom: '20px' }}>
        <label>VM ID <input value={form.id} onChange={e => setForm(s => ({ ...s, id: e.target.value.replace(/[^0-9]/g, '') }))} /></label>
        <label>Name <input value={form.name} onChange={e => setForm(s => ({ ...s, name: e.target.value }))} /></label>
        
        <label>OS Family
          <select value={form.osFamily} onChange={e => setForm(s => ({ ...s, osFamily: e.target.value as any }))}>
            <option value="linux">Linux</option>
            <option value="windows">Windows</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label>OS Version <input value={form.osVersion} onChange={e => setForm(s => ({ ...s, osVersion: e.target.value }))} /></label>

        <label>CPU Cores <input type="number" min="1" value={form.cpuCores} onChange={e => setForm(s => ({ ...s, cpuCores: Number(e.target.value) }))} /></label>
        <label>RAM (MB) <input type="number" min="512" step="256" value={form.memoryMb} onChange={e => setForm(s => ({ ...s, memoryMb: Number(e.target.value) }))} /></label>

        <label>Disk Size (GB) <input type="number" min="8" value={form.diskGb} onChange={e => setForm(s => ({ ...s, diskGb: Number(e.target.value) }))} /></label>
        <label>Storage Pool
          <select value={form.storagePool} onChange={e => setForm(s => ({ ...s, storagePool: e.target.value }))}>
            {(storagePools?.length ? storagePools : [{name: 'default'}]).map(p => (
              <option key={p.name} value={p.name}>{p.name}</option>
            ))}
          </select>
        </label>

        <label className="span2">Boot ISO
          <select value={form.isoPath} onChange={e => setForm(s => ({ ...s, isoPath: e.target.value }))}>
            <option value="">No ISO (Network Boot / Empty Disk)</option>
            {isoLibrary?.map(iso => <option key={iso.path} value={iso.path}>{iso.name}</option>)}
          </select>
        </label>

        <div className="span2" style={{ marginTop: '10px' }}>
          <Button variant="ghost" onClick={() => setAdvanced(!advanced)} style={{ width: '100%', border: '1px dashed #cbd5e1' }}>
            {advanced ? 'Hide Advanced Settings' : 'Show Advanced Settings'}
          </Button>
        </div>

        {advanced && (
          <>
            <h4 className="span2" style={{ margin: '10px 0 0', color: '#475569', fontSize: '14px', borderBottom: '1px solid #e2e8f0', paddingBottom: '4px' }}>Storage & Network</h4>
            
            <label>Disk Bus
              <select value={form.diskBus} onChange={e => setForm(s => ({ ...s, diskBus: e.target.value as any }))}>
                <option value="scsi">SCSI (recommended)</option>
                <option value="virtio">VirtIO</option>
                <option value="sata">SATA</option>
              </select>
            </label>
            <label>NIC Model
              <select value={form.nicModel} onChange={e => setForm(s => ({ ...s, nicModel: e.target.value as any }))}>
                <option value="virtio">VirtIO (recommended)</option>
                <option value="e1000">e1000</option>
                <option value="vmxnet3">vmxnet3</option>
              </select>
            </label>

            <label>Network Mode
              <select value={form.networkMode} onChange={e => setForm(s => ({ ...s, networkMode: e.target.value as any }))}>
                <option value="bridge">Bridge</option>
                <option value="nat">NAT</option>
                <option value="private">Private</option>
              </select>
            </label>
            <label>Network Source
              <input value={form.networkSource} onChange={e => setForm(s => ({ ...s, networkSource: e.target.value }))} placeholder="vmbr0 or default" />
            </label>

            <label className="span2">VLAN ID (optional)
              <input value={form.vlanId} onChange={e => setForm(s => ({ ...s, vlanId: e.target.value }))} placeholder="e.g. 100" />
            </label>

            <h4 className="span2" style={{ margin: '10px 0 0', color: '#475569', fontSize: '14px', borderBottom: '1px solid #e2e8f0', paddingBottom: '4px' }}>Cloud-Init & OS</h4>

            <label>Cloud-Init User
              <input value={form.cloudInitUser} onChange={e => setForm(s => ({ ...s, cloudInitUser: e.target.value }))} />
            </label>
            <label>Timezone
              <input value={form.timezone} onChange={e => setForm(s => ({ ...s, timezone: e.target.value }))} />
            </label>

            <label className="span2">IP Assignment
              <select value={form.cloudInitNetwork} onChange={e => setForm(s => ({ ...s, cloudInitNetwork: e.target.value as any }))}>
                <option value="dhcp">DHCP (Automatic)</option>
                <option value="static">Static IP</option>
              </select>
            </label>

            {form.cloudInitNetwork === 'static' && (
              <>
                <label>Static IP/CIDR
                  <input value={form.staticIp} onChange={e => setForm(s => ({ ...s, staticIp: e.target.value }))} placeholder="10.0.0.50/24" />
                </label>
                <label>Gateway
                  <input value={form.gateway} onChange={e => setForm(s => ({ ...s, gateway: e.target.value }))} placeholder="10.0.0.1" />
                </label>
                <label className="span2">DNS Servers
                  <input value={form.dns} onChange={e => setForm(s => ({ ...s, dns: e.target.value }))} placeholder="1.1.1.1, 8.8.8.8" />
                </label>
              </>
            )}

            <h4 className="span2" style={{ margin: '10px 0 0', color: '#475569', fontSize: '14px', borderBottom: '1px solid #e2e8f0', paddingBottom: '4px' }}>Policies</h4>
            
            <div className="span2" style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '13px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 'normal', cursor: 'pointer' }}>
                <input type="checkbox" checked={form.startAtBoot} onChange={e => setForm(s => ({ ...s, startAtBoot: e.target.checked }))} style={{ width: 'auto' }} /> 
                Start VM automatically when host boots
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 'normal', cursor: 'pointer' }}>
                <input type="checkbox" checked={form.firewallEnabled} onChange={e => setForm(s => ({ ...s, firewallEnabled: e.target.checked }))} style={{ width: 'auto' }} /> 
                Enable default firewall rules
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 'normal', cursor: 'pointer' }}>
                <input type="checkbox" checked={form.snapshotOnCreate} onChange={e => setForm(s => ({ ...s, snapshotOnCreate: e.target.checked }))} style={{ width: 'auto' }} /> 
                Take initial snapshot immediately after creation
              </label>
            </div>
          </>
        )}
      </div>

      <div style={{ display: 'flex', gap: '10px', marginTop: 'auto', paddingTop: '16px', borderTop: '1px solid #e2e8f0' }}>
        <Button loading={mutation.isPending} onClick={() => mutation.mutate()} style={{ flex: 1 }} disabled={!form.id || !form.name}>Create VM</Button>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
      </div>
    </Drawer>
  );
}
