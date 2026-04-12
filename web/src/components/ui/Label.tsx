type LabelProps = React.LabelHTMLAttributes<HTMLLabelElement>;

function Label({ className, ...props }: LabelProps) {
  return (
    <label
      className={`text-xs text-muted block mb-1 ${className ?? ''}`}
      {...props}
    />
  );
}

export { Label, type LabelProps };
