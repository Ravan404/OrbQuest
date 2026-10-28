import React, { useEffect, useState } from 'react';

const SIZES = {
  sm: 'h-7 w-7 rounded-md text-[10px]',
  md: 'h-10 w-10 rounded-lg text-[12px]',
  lg: 'h-14 w-14 rounded-xl text-[15px]',
};

function initials(name: string): string {
  const parts = name.trim().split(/[\s:-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase() || '?';
}

/** The game's icon, or its initials on a plain tile when there is none or it fails to load. */
export const GameIcon: React.FC<{ name: string; src?: string; size?: keyof typeof SIZES; className?: string }> = ({
  name,
  src,
  size = 'md',
  className = '',
}) => {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);

  const base = `${SIZES[size]} shrink-0 overflow-hidden ${className}`;

  if (src && !failed) {
    return (
      <span className={`${base} block bg-sunken`}>
        <img
          src={src}
          alt=""
          referrerPolicy="no-referrer"
          loading={src.startsWith('/') ? 'eager' : 'lazy'}
          decoding="async"
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      </span>
    );
  }

  return (
    <span className={`${base} flex items-center justify-center bg-sunken font-semibold text-muted`} aria-hidden="true">
      {initials(name)}
    </span>
  );
};
