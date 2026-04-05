export type VmStatus = 'running' | 'stopped' | 'paused';

export type VmTaskStatus = 'success' | 'failed' | 'running';

export interface VmTask {
  id: string;
  action: string;
  status: VmTaskStatus;
  timestamp: string;
}

export interface SnapshotItem {
  id: string;
  name: string;
  createdAt: string;
}

export interface BackupItem {
  id: string;
  name: string;
  createdAt: string;
  size: string;
}

export interface FirewallRule {
  id: string;
  direction: 'IN' | 'OUT';
  action: 'ACCEPT' | 'DROP';
  source: string;
  destination: string;
  port: string;
}

export interface VmEntity {
  id: string;
  name: string;
  node: string;
  status: VmStatus;
  uptime: string;
  tags: string[];
  cpuCores: number;
  ramMb: number;
  disks: Array<{ id: string; name: string; sizeGb: number }>;
  nics: Array<{ id: string; bridge: string; model: string }>;
  cdrom: string;
  gpu?: string;
  options: {
    bootOrder: string;
    startAtBoot: boolean;
    bios: 'BIOS' | 'UEFI';
    protection: boolean;
  };
  cloudInit: {
    user: string;
    sshKeys: string;
    network: 'dhcp' | 'static';
    yaml: string;
  };
  firewallEnabled: boolean;
  firewallRules: FirewallRule[];
  permissions: Array<{ id: string; user: string; role: string }>;
  snapshots: SnapshotItem[];
  backups: BackupItem[];
  tasks: VmTask[];
}

export interface MetricsSample {
  time: string;
  cpu: number;
  ram: number;
  diskIo: number;
  net: number;
}
