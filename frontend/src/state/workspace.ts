import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface Workspace {
  storeId: string;
  counterId: string;
  setStore: (id: string) => void;
  setCounter: (id: string) => void;
  reset: () => void;
}
export const useWorkspace = create<Workspace>()(
  persist(
    (set) => ({
      storeId: '',
      counterId: '',
      setStore: (id) => set({ storeId: id, counterId: '' }),
      setCounter: (id) => set({ counterId: id }),
      reset: () => set({ storeId: '', counterId: '' }),
    }),
    {
      name: 'pos-workspace',
      partialize: (state) => ({ storeId: state.storeId, counterId: state.counterId }),
    },
  ),
);
