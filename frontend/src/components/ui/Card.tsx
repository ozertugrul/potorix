import React from 'react';

export function Card({ title, children, className = '' }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {title && <h3 className="card-title">{title}</h3>}
      {children}
    </section>
  );
}
