import { useMutation, useQueryClient } from '@tanstack/react-query';
import { backendVmApi } from '../services/backendVmApi';
import { useToastStore } from '../store/toastStore';
import { useVmStore } from '../store/vmStore';

export function useVmAction(vmId: string | null, action: string) {
  const queryClient = useQueryClient();
  const toast = useToastStore((s) => s.push);
  const setActionLoading = useVmStore((s) => s.setActionLoading);

  return useMutation({
    mutationFn: async () => {
      if (!vmId) throw new Error('No VM selected');
      setActionLoading(action, true);
      return backendVmApi.action(vmId, action);
    },
    onSuccess: () => {
      toast({ kind: 'success', title: 'Action queued', message: `${action} submitted` });
      queryClient.invalidateQueries({ queryKey: ['vms'] });
      queryClient.invalidateQueries({ queryKey: ['vm', vmId] });
      queryClient.invalidateQueries({ queryKey: ['system-usage'] });
    },
    onError: (error: Error) => {
      toast({ kind: 'error', title: 'Action failed', message: error.message });
    },
    onSettled: () => setActionLoading(action, false)
  });
}
