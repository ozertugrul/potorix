import React, { useEffect } from 'react';

export function Drawer({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  if (!open) return null;

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer-panel" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <h3>{title}</h3>
          <button onClick={onClose}>✕</button>
        </div>
        <div className="drawer-body">
          {children}
        </div>
      </div>
    </div>
  );
}
