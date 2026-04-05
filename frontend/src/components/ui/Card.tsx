import React from 'react';

export function Card({ title, children, className = '' }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`cardx ${className}`}>
      {title && <h3 className="cardx-title">{title}</h3>}
      {children}
    </section>
  );
}
