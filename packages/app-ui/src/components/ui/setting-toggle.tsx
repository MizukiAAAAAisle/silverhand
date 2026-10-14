export function SettingToggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
      className={`relative h-6 w-10 shrink-0 rounded-full focus-outline disabled:opacity-50 ${checked ? "bg-accent" : "bg-bg-elevated border border-border"}`}
    >
      <span
        className={`absolute top-0.5 size-5 rounded-full bg-white shadow-sm transition-transform ${checked ? "left-0.5 translate-x-4" : "left-0.5"}`}
      />
    </button>
  );
}
