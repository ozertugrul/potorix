import { useMutation, useQueryClient } from '@tanstack/react-query';
import { backendVmApi } from '../services/backendVmApi';
import { useToastStore } from '../store/toastStore';
import { useVmStore } from '../store/vmStore';

export function useVmAction(vmId: string | null, action: string) {
  const queryClient = useQueryClient();
  const toast = useToastStore((s) => s.push);
  const setActionLoading = useVmStore((s) => s.setActionLoading);

  return useMutation({
    onMutate: async () => {
      if (!vmId) return;
      setActionLoading(action, true);
      
      // Optimistically add a task to disable buttons instantly
      await queryClient.cancelQueries({ queryKey: ['vm', vmId] });
      const previousVm = queryClient.getQueryData(['vm', vmId]);
      
      if (previousVm) {
        queryClient.setQueryData(['vm', vmId], (old: any) => ({
          ...old,
          tasks: [{ id: `optimistic-${Date.now()}`, action, status: 'running', timestamp: new Date().toISOString() }, ...(old.tasks || [])]
        }));
      }
      
      return { previousVm };
    },
    mutationFn: async () => {
      if (!vmId) throw new Error('No VM selected');
      return backendVmApi.action(vmId, action);
    },
    onSuccess: () => {
      toast({ kind: 'success', title: 'Action queued', message: `${action} submitted` });
      queryClient.invalidateQueries({ queryKey: ['vms'] });
      queryClient.invalidateQueries({ queryKey: ['vm', vmId] });
      queryClient.invalidateQueries({ queryKey: ['system-usage'] });
    },
    onError: (error: Error, _variables, context) => {
      toast({ kind: 'error', title: 'Action failed', message: error.message });
      if (context?.previousVm) {
        queryClient.setQueryData(['vm', vmId], context.previousVm);
      }
    },
    onSettled: () => setActionLoading(action, false)
  });
}
