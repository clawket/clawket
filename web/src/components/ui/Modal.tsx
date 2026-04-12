interface ModalOverlayProps {
  onClose: () => void;
  children: React.ReactNode;
}

function ModalOverlay({ onClose, children }: ModalOverlayProps) {
  return (
    <div
      className="fixed inset-0 bg-overlay flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  );
}

interface ModalContentProps {
  children: React.ReactNode;
  className?: string;
}

function ModalContent({ children, className }: ModalContentProps) {
  return (
    <div className={`bg-surface border border-border rounded-lg shadow-xl ${className ?? 'w-[440px]'}`}>
      {children}
    </div>
  );
}

interface ModalHeaderProps {
  children: React.ReactNode;
}

function ModalHeader({ children }: ModalHeaderProps) {
  return (
    <div className="px-5 py-4 border-b border-border">
      <h3 className="text-base font-semibold text-foreground">{children}</h3>
    </div>
  );
}

interface ModalBodyProps {
  children: React.ReactNode;
  className?: string;
}

function ModalBody({ children, className }: ModalBodyProps) {
  return <div className={className ?? 'p-5 space-y-4'}>{children}</div>;
}

const Modal = {
  Overlay: ModalOverlay,
  Content: ModalContent,
  Header: ModalHeader,
  Body: ModalBody,
};

export { Modal };
