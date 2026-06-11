import { useToast } from '@/store/useToast'

export function ToastContainer() {
  const items = useToast((s) => s.items)
  return (
    <div className="toast-container">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.message}
        </div>
      ))}
    </div>
  )
}
