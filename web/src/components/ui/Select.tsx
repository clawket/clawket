import { cva, type VariantProps } from 'class-variance-authority';

const selectVariants = cva(
  'w-full bg-background border border-border rounded text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-ring transition-colors appearance-none cursor-pointer',
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

interface SelectProps
  extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'>,
    VariantProps<typeof selectVariants> {}

function Select({ size, className, ...props }: SelectProps) {
  return (
    <select
      className={selectVariants({ size, className })}
      {...props}
    />
  );
}

export { Select, type SelectProps };
