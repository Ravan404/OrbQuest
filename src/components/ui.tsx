import React, { useEffect } from 'react';
import { Search, X } from 'lucide-react';

/*
 * Small building blocks every screen shares, so a button or a field looks
 * the same everywhere and colours come only from the theme tokens.
 */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-soft';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-on-primary hover:bg-primary-hover font-medium',
  secondary: 'border border-line-strong bg-surface text-text hover:bg-hover',
  ghost: 'text-muted hover:bg-hover hover:text-text',
  danger: 'bg-danger text-page hover:brightness-110 font-medium',
  'danger-soft': 'border border-danger/40 text-danger hover:bg-danger/10',
};

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  icon?: React.ReactNode;
}

export const Button: React.FC<ButtonProps> = ({
  variant = 'secondary',
  size = 'md',
  icon,
  className = '',
  children,
  type = 'button',
  ...rest
}) => (
  <button
    type={type}
    className={`inline-flex min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md transition-colors disabled:pointer-events-none disabled:opacity-40 ${
      size === 'sm' ? 'h-7 px-2.5 text-[13px]' : 'h-8 px-3 text-[13px]'
    } ${VARIANTS[variant]} ${className}`}
    {...rest}
  >
    {icon}
    {children}
  </button>
);

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  tone?: 'default' | 'danger';
}

/** Square icon-only button. `label` becomes its tooltip and accessible name. */
export const IconButton: React.FC<IconButtonProps> = ({ label, tone = 'default', className = '', children, type = 'button', ...rest }) => (
  <button
    type={type}
    title={label}
    aria-label={label}
    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover disabled:pointer-events-none disabled:opacity-35 ${
      tone === 'danger' ? 'hover:text-danger' : 'hover:text-text'
    } ${className}`}
    {...rest}
  >
    {children}
  </button>
);

export const inputClass =
  'h-8 w-full rounded-md border border-line-strong bg-surface px-2.5 text-[13px] text-text placeholder:text-faint focus:border-primary focus:outline-none read-only:bg-sunken read-only:text-muted';

export const TextInput = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className = '', ...rest }, ref) => <input ref={ref} className={`${inputClass} ${className}`} {...rest} />
);
TextInput.displayName = 'TextInput';

interface SearchInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  trailing?: React.ReactNode;
}

export const SearchInput: React.FC<SearchInputProps> = ({ className = '', trailing, ...rest }) => (
  <div className={`relative ${className}`}>
    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
    <input type="search" className={`${inputClass} pl-8 ${trailing ? 'pr-8' : ''}`} {...rest} />
    {trailing && <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-faint">{trailing}</span>}
  </div>
);

/** Row of mutually exclusive choices (filters, presets). */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  className = '',
}: {
  options: { value: T; label: React.ReactNode; title?: string }[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div className={`inline-flex rounded-md bg-sunken p-0.5 ${className}`} role="group">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            title={option.title}
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={`flex-1 whitespace-nowrap rounded px-2.5 py-1 text-[12px] transition-colors ${
              active ? 'bg-surface font-medium text-text shadow-[0_1px_2px_var(--c-shadow)]' : 'text-muted hover:text-text'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

type ChipTone = 'neutral' | 'run' | 'wait' | 'danger' | 'outline';

const CHIP_TONES: Record<ChipTone, string> = {
  neutral: 'bg-sunken text-muted',
  run: 'bg-run/12 text-run',
  wait: 'bg-wait/12 text-wait',
  danger: 'bg-danger/12 text-danger',
  outline: 'border border-line-strong text-muted',
};

export const Chip: React.FC<{ tone?: ChipTone; dot?: boolean; children: React.ReactNode; className?: string }> = ({
  tone = 'neutral',
  dot = false,
  children,
  className = '',
}) => (
  <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${CHIP_TONES[tone]} ${className}`}>
    {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
    {children}
  </span>
);

/** Floating panel: menus, the bulk bar, notices. */
export const popClass = 'rounded-lg border border-line bg-surface shadow-pop';

export const SectionLabel: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <div className={`text-[11px] font-semibold uppercase tracking-wide text-faint ${className}`}>{children}</div>
);

interface DialogProps {
  title: string;
  subtitle?: string;
  onClose: () => void;
  footer?: React.ReactNode;
  width?: 'md' | 'lg';
  children: React.ReactNode;
}

/** Centered modal. Escape and a click outside close it. */
export const Dialog: React.FC<DialogProps> = ({ title, subtitle, onClose, footer, width = 'md', children }) => {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/40 p-4" onMouseDown={onClose}>
      <div className="flex min-h-full items-center justify-center">
        <section
          role="dialog"
          aria-modal="true"
          aria-label={title}
          onMouseDown={(event) => event.stopPropagation()}
          className={`animate-enter w-full overflow-hidden ${popClass} ${width === 'lg' ? 'max-w-2xl' : 'max-w-md'}`}
        >
          <header className="flex items-start gap-3 px-5 pb-2 pt-4">
            <div className="min-w-0 flex-1">
              <h2 className="text-[16px] font-semibold text-text">{title}</h2>
              {subtitle && <p className="mt-0.5 truncate text-[13px] text-muted">{subtitle}</p>}
            </div>
            <IconButton label="Close" onClick={onClose} className="-mr-2 -mt-1">
              <X className="h-4 w-4" />
            </IconButton>
          </header>
          <div className="px-5 pb-5 pt-2">{children}</div>
          {footer && (
            <footer className="flex items-center justify-end gap-2 border-t border-line bg-sunken/60 px-5 py-3">{footer}</footer>
          )}
        </section>
      </div>
    </div>
  );
};
