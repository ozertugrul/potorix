import React from 'react';

export function Tabs({ value, onChange, items }: { value: string; onChange: (v: string) => void; items: Array<{ key: string; label: string }> }) {
  return (
    <div className="tabs">
      {items.map((it) => (
        <button key={it.key} className={value === it.key ? 'active' : ''} onClick={() => onChange(it.key)}>{it.label}</button>
      ))}
    </div>
  );
}
