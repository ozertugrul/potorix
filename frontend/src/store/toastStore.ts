import { create } from 'zustand';

export interface ToastItem {
  id: string;
  title: string;
  message: string;
  kind: 'info' | 'error' | 'success';
}

interface ToastStore {
  toasts: ToastItem[];
  push: (item: Omit<ToastItem, 'id'>) => void;
  remove: (id: string) => void;
}

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  push: (item) => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    set((state) => ({ toasts: [{ id, ...item }, ...state.toasts].slice(0, 6) }));
    setTimeout(() => set((state) => ({ toasts: state.toasts.filter((x) => x.id !== id) })), 3500);
  },
  remove: (id) => set((state) => ({ toasts: state.toasts.filter((x) => x.id !== id) }))
}));
