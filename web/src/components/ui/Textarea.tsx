import { cva, type VariantProps } from 'class-variance-authority';

const textareaVariants = cva(
  'w-full bg-background border border-border rounded text-foreground placeholder:text-muted focus:outline-none focus:border-primary focus:ring-1 focus:ring-ring transition-colors resize-none',
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

interface TextareaProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'size'>,
    VariantProps<typeof textareaVariants> {}

function Textarea({ size, className, ...props }: TextareaProps) {
  return (
    <textarea
      className={textareaVariants({ size, className })}
      {...props}
    />
  );
}

export { Textarea, type TextareaProps };
