import { cva, type VariantProps } from 'class-variance-authority';

const inputVariants = cva(
  'w-full bg-background border border-border rounded text-foreground placeholder:text-muted focus:outline-none focus:border-primary focus:ring-1 focus:ring-ring transition-colors',
  {
    variants: {
      size: {
        sm: 'px-2.5 py-1.5 text-xs',
        md: 'px-3 py-2 text-sm',
        lg: 'px-4 py-2.5 text-base',
      },
    },
    defaultVariants: {
      size: 'md',
    },
  },
);

interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'>,
    VariantProps<typeof inputVariants> {}

function Input({ size, className, ...props }: InputProps) {
  return (
    <input
      className={inputVariants({ size, className })}
      {...props}
    />
  );
}

export { Input, type InputProps };
