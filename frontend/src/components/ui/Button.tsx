import React from 'react';
import { Loader2 } from 'lucide-react';

interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  loading?: boolean;
  icon?: React.ReactNode;
  variant?: 'primary' | 'danger' | 'ghost';
}

export function Button({ loading, icon, variant = 'primary', children, className = '', ...props }: Props) {
  return (
    <button className={`btn btn-${variant} ${className}`} disabled={loading || props.disabled} {...props}>
      {loading ? <Loader2 size={15} className="spin" /> : icon}
      <span>{children}</span>
    </button>
  );
}
