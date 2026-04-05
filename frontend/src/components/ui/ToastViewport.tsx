import { useToastStore } from '../../store/toastStore';

export function ToastViewport() {
  const toasts = useToastStore((s) => s.toasts);
  const remove = useToastStore((s) => s.remove);
  return (
    <div className="toast-wrap">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => remove(t.id)}>
          <strong>{t.title}</strong>
          <p>{t.message}</p>
        </div>
      ))}
    </div>
  );
}
