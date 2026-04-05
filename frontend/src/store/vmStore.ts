import { create } from 'zustand';

interface VmStoreState {
  selectedVmId: string | null;
  selectedVmIds: string[];
  actionLoading: Record<string, boolean>;
  setPrimaryVm: (id: string | null) => void;
  toggleVmSelection: (id: string) => void;
  clearSelection: () => void;
  setActionLoading: (action: string, loading: boolean) => void;
}

export const useVmStore = create<VmStoreState>((set) => ({
  selectedVmId: null,
  selectedVmIds: [],
  actionLoading: {},
  setPrimaryVm: (id) => set((state) => ({ selectedVmId: id, selectedVmIds: id ? Array.from(new Set([id, ...state.selectedVmIds])) : [] })),
  toggleVmSelection: (id) => set((state) => {
    const has = state.selectedVmIds.includes(id);
    const selectedVmIds = has ? state.selectedVmIds.filter((x) => x !== id) : [...state.selectedVmIds, id];
    const selectedVmId = state.selectedVmId && selectedVmIds.includes(state.selectedVmId) ? state.selectedVmId : (selectedVmIds[0] ?? null);
    return { selectedVmIds, selectedVmId };
  }),
  clearSelection: () => set({ selectedVmId: null, selectedVmIds: [] }),
  setActionLoading: (action, loading) => set((state) => ({ actionLoading: { ...state.actionLoading, [action]: loading } }))
}));
