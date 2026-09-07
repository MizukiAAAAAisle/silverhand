import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export const RangeInput = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>
>(({ className, ...props }, ref) => (
  <input ref={ref} type="range" className={cn('range-input', className)} {...props} />
));
RangeInput.displayName = 'RangeInput';
