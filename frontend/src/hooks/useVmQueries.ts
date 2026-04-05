import { useQuery } from '@tanstack/react-query';
import { backendVmApi } from '../services/backendVmApi';

export function useVmsQuery() {
  return useQuery({ queryKey: ['vms'], queryFn: () => backendVmApi.getVms(), refetchInterval: 3500 });
}

export function useVmDetailQuery(vmId: string | null) {
  return useQuery({ queryKey: ['vm', vmId], queryFn: () => backendVmApi.getVm(vmId!), enabled: Boolean(vmId), refetchInterval: 3500 });
}

export function useVmMetricsQuery(vmId: string | null) {
  return useQuery({
    queryKey: ['vm-metrics', vmId],
    queryFn: () => backendVmApi.getMetrics(vmId!),
    enabled: Boolean(vmId),
    refetchInterval: 4000
  });
}

export function useSystemUsageQuery() {
  return useQuery({ queryKey: ['system-usage'], queryFn: () => backendVmApi.getSystemUsage(), refetchInterval: 5000 });
}

export function useIsoLibraryQuery() {
  return useQuery({ queryKey: ['iso-library'], queryFn: () => backendVmApi.getIsoLibrary(), refetchInterval: 8000 });
}

export function useVmOperationsQuery(vmId: string | null) {
  return useQuery({
    queryKey: ['vm-operations', vmId],
    queryFn: () => backendVmApi.getVmOperations(vmId!),
    enabled: Boolean(vmId),
    refetchInterval: 2500
  });
}
