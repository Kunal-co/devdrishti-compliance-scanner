import { create } from 'zustand';
import { Inspector } from '@/types';
import inspectorsData from '@/data/inspectorProfiles.json';

interface AuthState {
  inspector: Inspector | null;
  isLoggedIn: boolean;
  login: (inspectorId: string, password: string) => boolean;
  logout: () => void;
  getInspectorDetails: () => Inspector | null;
}

// Ensure the JSON data is treated as the correct typed shape
const inspectorsList = (inspectorsData as unknown as { inspectors: Inspector[] }).inspectors;

export const useAuthStore = create<AuthState>((set, get) => ({
  inspector: null,
  isLoggedIn: false,

  login: (inspectorId: string, password: string) => {
    const inspector = inspectorsList.find(
      (insp) => insp.id === inspectorId && insp.password === password
    );

    if (inspector) {
      // Cast to Inspector to satisfy the typed store
      set({ inspector: inspector as Inspector, isLoggedIn: true });
      localStorage.setItem('inspector_id', inspectorId);
      localStorage.setItem('inspector_name', inspector.name);
      return true;
    }
    return false;
  },

  logout: () => {
    set({ inspector: null, isLoggedIn: false });
    localStorage.removeItem('inspector_id');
    localStorage.removeItem('inspector_name');
  },

  getInspectorDetails: () => {
    return get().inspector;
  },
}));
