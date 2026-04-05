import React from 'react';

export function Modal({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: React.ReactNode }) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><h4>{title}</h4><button onClick={onClose}>✕</button></div>
        {children}
      </div>
    </div>
  );
}
